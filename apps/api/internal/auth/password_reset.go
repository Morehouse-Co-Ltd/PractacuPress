package auth

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

// Password reset rules.
const (
	// VerificationKindPasswordReset is the token kind of a reset link. The value is
	// part of the persistence schema, not a UI label.
	VerificationKindPasswordReset = "password_reset"
	// ResetTokenTTL bounds how long a reset link stays usable.
	ResetTokenTTL = 30 * time.Minute
	// resetCooldown is the quiet period between two links for the same account. It
	// stops the endpoint from being used to flood someone's inbox.
	resetCooldown = 60 * time.Second
	// resetTokenBytes is the entropy of a reset token. 32 bytes is far beyond what
	// a guessing attack could cover inside the TTL.
	resetTokenBytes = 32
	// ResetPath is the frontend route a reset link points at.
	ResetPath = "/reset-password"
)

// Password reset failures.
var (
	// ErrResetTokenInvalid covers unknown, expired and already redeemed tokens: the
	// caller must not learn which of the three it was.
	ErrResetTokenInvalid = errors.New("auth: password reset token is invalid or expired")
	// ErrMailNotConfigured means the deployment has no SMTP relay, so a reset link
	// could not be delivered.
	ErrMailNotConfigured = errors.New("auth: mail is not configured")
)

// ResetPolicy describes the password reset capability of this deployment.
type ResetPolicy struct {
	// Enabled reports whether reset requests can be delivered.
	Enabled bool
	// Delivery names the channel. It is always "email" today.
	Delivery string
	// ExpiresIn is the lifetime of a reset link.
	ExpiresIn time.Duration
	// Cooldown is the minimum interval between two requests for one account.
	Cooldown time.Duration
}

// ResetRequest is the outcome of asking for a reset link.
//
// Accepted is always true once the request is well formed: reporting "no such
// account" would make the endpoint an account enumeration oracle.
type ResetRequest struct {
	// Delivered reports whether the message reached the relay. It is false for an
	// unknown address as well, by design.
	Delivered bool
	// ExpiresAt is when the link dies.
	ExpiresAt time.Time
}

// PasswordResetPolicy reports whether this deployment can send reset links.
func (s *Service) PasswordResetPolicy() ResetPolicy {
	return ResetPolicy{
		Enabled:   s.mailReady(),
		Delivery:  "email",
		ExpiresIn: ResetTokenTTL,
		Cooldown:  resetCooldown,
	}
}

// RequestPasswordReset emails a single use reset link.
//
// The account lookup, the site membership check and the cooldown are all silent: a
// caller always receives the same answer, so the endpoint cannot be used to find out
// which addresses have an account on this site.
func (s *Service) RequestPasswordReset(
	ctx context.Context,
	siteID, rawEmail, baseURL string,
) (ResetRequest, error) {
	if !s.mailReady() {
		return ResetRequest{}, ErrMailNotConfigured
	}
	if siteID == "" {
		return ResetRequest{}, fmt.Errorf("%w: site is required", ErrInvalidInput)
	}
	email, err := NormalizeEmail(rawEmail)
	if err != nil {
		return ResetRequest{}, err
	}

	now := s.now()
	identity, err := s.repo.FindEmailIdentity(ctx, email)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return ResetRequest{}, nil
		}
		return ResetRequest{}, err
	}
	// An account that only ever signed in through a provider has no password to
	// reset. Saying so would leak which accounts are password backed.
	if identity.PasswordHash == "" {
		return ResetRequest{}, nil
	}
	if _, err := s.repo.FindMembershipRole(ctx, siteID, identity.UserID); err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return ResetRequest{}, nil
		}
		return ResetRequest{}, err
	}

	// A second link inside the cooldown is dropped, but the caller still sees the
	// same accepted response.
	if latest, err := s.repo.LatestLiveVerificationToken(ctx, identity.UserID,
		VerificationKindPasswordReset, now); err == nil {
		if now.Sub(latest.CreatedAt) < resetCooldown {
			return ResetRequest{Delivered: false, ExpiresAt: latest.ExpiresAt}, nil
		}
	} else if !errors.Is(err, ErrVerificationTokenNotFound) {
		return ResetRequest{}, err
	}

	plain, err := randomToken(resetTokenBytes)
	if err != nil {
		return ResetRequest{}, err
	}
	expiresAt := now.Add(ResetTokenTTL)

	// Older links die with the new request: a user who asks twice should have
	// exactly one working link in their inbox.
	if err := s.repo.InvalidateVerificationTokens(ctx, identity.UserID,
		VerificationKindPasswordReset, now); err != nil {
		return ResetRequest{}, err
	}
	if err := s.repo.CreateVerificationToken(ctx, VerificationToken{
		ID:        uuid.Must(uuid.NewV7()).String(),
		UserID:    identity.UserID,
		Kind:      VerificationKindPasswordReset,
		TokenHash: HashOpaqueToken(plain),
		ExpiresAt: expiresAt,
		CreatedAt: now,
	}); err != nil {
		return ResetRequest{}, err
	}

	link := resetLink(s.resetOrigin(baseURL), plain)
	if err := s.mailer.Send(ctx, buildResetEmail(identity.Email, link, expiresAt)); err != nil {
		// The response stays accepted on purpose. A delivery failure that only
		// happens for registered addresses would restore the enumeration oracle,
		// so it is logged for the operator instead of reported to the caller.
		s.logError("password reset mail failed", "error", err, "user_id", identity.UserID)
		return ResetRequest{Delivered: false, ExpiresAt: expiresAt}, nil
	}

	s.logInfo("password reset mail sent", "user_id", identity.UserID)
	return ResetRequest{Delivered: true, ExpiresAt: expiresAt}, nil
}

// ResetPassword redeems a reset token and replaces the password.
//
// A successful reset revokes every live session of the account: an attacker who
// already owns a session must not keep it by riding a password change.
func (s *Service) ResetPassword(ctx context.Context, plainToken, newPassword string) error {
	if strings.TrimSpace(plainToken) == "" {
		return ErrResetTokenInvalid
	}
	if err := ValidatePassword(newPassword); err != nil {
		return err
	}

	now := s.now()
	token, err := s.repo.FindVerificationToken(ctx, HashOpaqueToken(plainToken))
	if err != nil {
		if errors.Is(err, ErrVerificationTokenNotFound) {
			return ErrResetTokenInvalid
		}
		return err
	}
	if token.Kind != VerificationKindPasswordReset || !token.Live(now) {
		return ErrResetTokenInvalid
	}

	// Hash before consuming: hashing is the expensive step and a failure there must
	// not burn the user's only link.
	passwordHash, err := s.hasher.Hash(ctx, newPassword)
	if err != nil {
		return err
	}

	// Consuming first makes redemption single use even when two requests race: only
	// one of them can flip consumed_at.
	consumed, err := s.repo.ConsumeVerificationToken(ctx, token.ID, now)
	if err != nil {
		return err
	}
	if !consumed {
		return ErrResetTokenInvalid
	}

	identity, err := s.repo.FindEmailIdentityByUser(ctx, token.UserID)
	if err != nil {
		return err
	}

	// Presenting the link proves the mailbox, so an unverified address becomes
	// verified. An already verified one keeps its original timestamp.
	verifiedAt := now
	if identity.VerifiedAt != nil {
		verifiedAt = *identity.VerifiedAt
	}
	if err := s.repo.UpdatePasswordHash(ctx, identity.ID, passwordHash, &verifiedAt); err != nil {
		return err
	}

	// Tokens still outstanding are retired; the one just used is already consumed.
	if err := s.repo.InvalidateVerificationTokens(ctx, token.UserID,
		VerificationKindPasswordReset, now); err != nil {
		return err
	}
	if err := s.repo.RevokeUserSessions(ctx, token.UserID, "password_reset", now); err != nil {
		return err
	}

	s.logInfo("password reset completed", "user_id", token.UserID)
	return nil
}

func (s *Service) mailReady() bool {
	return s.mailer != nil && s.mailer.Configured()
}

// resetOrigin prefers the operator configured URL over the origin of the request.
//
// The request origin is the address the browser actually used to reach this site,
// which is what a same origin deployment wants; PUBLIC_BASE_URL exists for the
// deployments where the API is reached through a different host than the website.
func (s *Service) resetOrigin(requestOrigin string) string {
	if s.publicBaseURL != "" {
		return s.publicBaseURL
	}
	return requestOrigin
}

// resetLink builds the absolute URL the user clicks.
func resetLink(baseURL, token string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	query := url.Values{}
	query.Set("token", token)
	return base + ResetPath + "?" + query.Encode()
}

// buildResetEmail renders the reset mail.
//
// It is intentionally plain: a transactional mail with no images, no tracking pixel
// and a single link survives every mail client and every spam filter.
func buildResetEmail(to, link string, expiresAt time.Time) mailer.Message {
	minutes := int(ResetTokenTTL / time.Minute)
	subject := "重置你的账户密码"
	text := fmt.Sprintf(`你好：

我们收到了重置这个账户密码的请求。点击下面的链接设置新密码：

%s

链接 %d 分钟内有效，只能使用一次。如果这不是你发起的，可以忽略这封邮件，密码不会改变。

—— Practacu Press`, link, minutes)
	html := fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px 16px;background:#f6f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e0;border-radius:14px">
    <tr><td style="padding:32px 32px 8px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a82">Practacu Press</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600">重置你的账户密码</h1>
      <p style="margin:0 0 22px;font-size:14px;line-height:1.75;color:#4a4a45">我们收到了重置这个账户密码的请求。点击下面的按钮设置新密码。</p>
      <p style="margin:0 0 24px">
        <a href="%s" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:999px">设置新密码</a>
      </p>
      <p style="margin:0 0 8px;font-size:12px;line-height:1.7;color:#8a8a82">如果按钮无法点击，请复制这个链接到浏览器：<br><span style="word-break:break-all;color:#4a4a45">%s</span></p>
    </td></tr>
    <tr><td style="padding:8px 32px 30px">
      <hr style="border:0;border-top:1px solid #eeeee8;margin:0 0 16px">
      <p style="margin:0;font-size:12px;line-height:1.7;color:#8a8a82">链接 %d 分钟内有效，只能使用一次。如果这不是你发起的，可以忽略这封邮件，密码不会改变。这封邮件由系统发出，不需要回复。</p>
    </td></tr>
  </table>
</body></html>`, link, link, minutes)

	return mailer.Message{
		To:      []string{to},
		Subject: subject,
		Text:    text,
		HTML:    html,
	}
}

func (s *Service) logInfo(msg string, args ...any) {
	if s.logger != nil {
		s.logger.Info(msg, args...)
	}
}

func (s *Service) logError(msg string, args ...any) {
	if s.logger != nil {
		s.logger.Error(msg, args...)
	}
}
