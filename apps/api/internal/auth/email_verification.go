package auth

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

// Email verification rules.
const (
	// VerificationKindEmailVerify is the token kind of a verification link. It
	// matches the user_identities.verified_at gate and the schema's allowed value.
	VerificationKindEmailVerify = "email_verify"
	// EmailVerificationTokenTTL bounds how long a verification link stays usable.
	EmailVerificationTokenTTL = 24 * time.Hour
	// emailVerificationCooldown is the quiet period between two links for one
	// account, so the endpoint cannot be used to flood an inbox.
	emailVerificationCooldown = 60 * time.Second
	// emailVerificationTokenBytes is the entropy of a verification token.
	emailVerificationTokenBytes = 32
	// VerifyEmailPath is the frontend route a verification link points at.
	VerifyEmailPath = "/verify-email"
	// emailVerificationSubject is the subject line of the verification mail. It is a
	// constant because the mail log records it, so a skipped attempt still says what
	// would have been sent.
	emailVerificationSubject = "验证你的邮箱地址"
)

// EmailVerificationRequest is the outcome of asking for a verification link.
type EmailVerificationRequest struct {
	Delivered       bool
	AlreadyVerified bool
	ExpiresAt       time.Time
}

// RequestEmailVerification emails a fresh verification link to the caller's address.
//
// The caller is authenticated, so unlike password reset there is no enumeration
// concern: the address is the caller's own identity. A verified account is not an
// error; it reports AlreadyVerified and sends nothing.
func (s *Service) RequestEmailVerification(
	ctx context.Context,
	userID, siteID, baseURL string,
) (EmailVerificationRequest, error) {
	if !s.mailReady() {
		// No relay: the caller keeps the same "capability unavailable" answer as
		// before. Best effort, the attempt is still recorded as skipped so the
		// dashboard can explain why no verification mail went out.
		s.recordEmailVerificationSkipped(ctx, userID, siteID)
		return EmailVerificationRequest{}, ErrMailNotConfigured
	}

	identity, err := s.repo.FindEmailIdentityByUser(ctx, userID)
	if err != nil {
		return EmailVerificationRequest{}, err
	}
	if identity.VerifiedAt != nil {
		return EmailVerificationRequest{AlreadyVerified: true}, nil
	}
	if identity.Email == "" {
		return EmailVerificationRequest{}, ErrMailNotConfigured
	}

	now := s.now()
	if latest, findErr := s.repo.LatestLiveVerificationToken(
		ctx, userID, VerificationKindEmailVerify, now,
	); findErr == nil {
		if now.Sub(latest.CreatedAt) < emailVerificationCooldown {
			return EmailVerificationRequest{
				Delivered: false,
				ExpiresAt: latest.ExpiresAt,
			}, nil
		}
	} else if !errors.Is(findErr, ErrVerificationTokenNotFound) {
		return EmailVerificationRequest{}, findErr
	}

	expiresAt, err := s.issueEmailVerificationToken(ctx, userID, siteID, identity.Email, baseURL, now)
	if err != nil {
		return EmailVerificationRequest{}, err
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.email_verification_requested",
		TargetType: "user",
		TargetID:   userID,
	})
	return EmailVerificationRequest{Delivered: true, ExpiresAt: expiresAt}, nil
}

// VerifyEmail redeems a verification link.
//
// The token is single use: consuming it before touching the identity makes two
// concurrent redemptions resolve to exactly one success. A successful redemption
// proves both the identity and the account level mirror.
func (s *Service) VerifyEmail(ctx context.Context, plainToken string) error {
	if strings.TrimSpace(plainToken) == "" {
		return ErrEmailVerificationTokenInvalid
	}

	now := s.now()
	token, err := s.repo.FindVerificationToken(ctx, HashOpaqueToken(plainToken))
	if err != nil {
		if errors.Is(err, ErrVerificationTokenNotFound) {
			return ErrEmailVerificationTokenInvalid
		}
		return err
	}
	if token.Kind != VerificationKindEmailVerify || !token.Live(now) {
		return ErrEmailVerificationTokenInvalid
	}

	consumed, err := s.repo.ConsumeVerificationToken(ctx, token.ID, now)
	if err != nil {
		return err
	}
	if !consumed {
		return ErrEmailVerificationTokenInvalid
	}

	identity, err := s.repo.FindEmailIdentityByUser(ctx, token.UserID)
	if err != nil {
		return err
	}
	if err := s.repo.MarkEmailVerified(ctx, identity.ID, token.UserID, now); err != nil {
		return err
	}
	// Older links die with the one that succeeded.
	if err := s.repo.InvalidateVerificationTokens(ctx, token.UserID,
		VerificationKindEmailVerify, now); err != nil {
		return err
	}

	s.recordAudit(ctx, audit.Entry{
		ActorID:    token.UserID,
		Action:     "auth.email_verified",
		TargetType: "user",
		TargetID:   token.UserID,
	})
	return nil
}

// issueEmailVerificationToken retires the previous link and sends a new one.
//
// siteID only scopes the mail log row; an empty value is recorded as such rather
// than invented, and a row that cannot be written never blocks the mail.
func (s *Service) issueEmailVerificationToken(
	ctx context.Context,
	userID, siteID, email, baseURL string,
	now time.Time,
) (time.Time, error) {
	plain, err := randomToken(emailVerificationTokenBytes)
	if err != nil {
		return time.Time{}, err
	}
	expiresAt := now.Add(EmailVerificationTokenTTL)

	if err := s.repo.InvalidateVerificationTokens(ctx, userID,
		VerificationKindEmailVerify, now); err != nil {
		return time.Time{}, err
	}
	if err := s.repo.CreateVerificationToken(ctx, VerificationToken{
		ID:        uuid.Must(uuid.NewV7()).String(),
		UserID:    userID,
		Kind:      VerificationKindEmailVerify,
		TokenHash: HashOpaqueToken(plain),
		ExpiresAt: expiresAt,
		CreatedAt: now,
	}); err != nil {
		return time.Time{}, err
	}

	link := verifyEmailLink(s.resetOrigin(baseURL), plain)
	if err := s.sendSystemMail(ctx, siteID, MailLogTemplateEmailVerify,
		buildVerificationEmail(email, link, expiresAt)); err != nil {
		return time.Time{}, err
	}
	s.logInfo("email verification mail sent", "user_id", userID)
	return expiresAt, nil
}

// recordEmailVerificationSkipped writes the mail log row for a verification mail that
// was never attempted because the deployment has no relay.
//
// The address has to be looked up here: the unconfigured check runs before the
// caller's identity is read, and email_logs.to_email is mandatory, so without an
// identity there is nothing to record. Every step is best effort; the caller's
// answer is not affected.
func (s *Service) recordEmailVerificationSkipped(ctx context.Context, userID, siteID string) {
	if s.mailLog == nil {
		return
	}
	identity, err := s.repo.FindEmailIdentityByUser(ctx, userID)
	if err != nil || strings.TrimSpace(identity.Email) == "" {
		return
	}
	s.recordSkippedSystemMail(ctx, siteID, MailLogTemplateEmailVerify, identity.Email,
		emailVerificationSubject, mailLogReasonNoRelay)
}

// sendEmailVerification is the registration path: it issues a link and reports the
// error to the caller, which logs it without failing the registration.
func (s *Service) sendEmailVerification(
	ctx context.Context,
	userID, siteID, email, baseURL string,
) (time.Time, error) {
	if siteID == "" {
		return time.Time{}, nil
	}
	now := s.now()
	expiresAt, err := s.issueEmailVerificationToken(ctx, userID, siteID, email, baseURL, now)
	if err != nil {
		return time.Time{}, err
	}
	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.email_verification_requested",
		TargetType: "user",
		TargetID:   userID,
	})
	return expiresAt, nil
}

// verifyEmailLink builds the absolute URL the user clicks.
func verifyEmailLink(baseURL, token string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	query := url.Values{}
	query.Set("token", token)
	return base + VerifyEmailPath + "?" + query.Encode()
}

// buildVerificationEmail renders the verification mail.
func buildVerificationEmail(to, link string, expiresAt time.Time) mailer.Message {
	hours := int(EmailVerificationTokenTTL / time.Hour)
	subject := "验证你的邮箱地址"
	text := fmt.Sprintf(`你好：

请点击下面的链接验证这个邮箱地址：

%s

链接 %d 小时内有效，只能使用一次。如果这不是你发起的，可以忽略这封邮件，你的账户仍可正常使用。

—— Practacu Press`, link, hours)
	html := fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px 16px;background:#f6f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e0;border-radius:14px">
    <tr><td style="padding:32px 32px 8px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a82">Practacu Press</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600">验证你的邮箱地址</h1>
      <p style="margin:0 0 22px;font-size:14px;line-height:1.75;color:#4a4a45">点击下面的按钮完成验证，验证后你的账户会显示「已验证」。</p>
      <p style="margin:0 0 24px">
        <a href="%s" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:999px">验证邮箱</a>
      </p>
      <p style="margin:0 0 8px;font-size:12px;line-height:1.7;color:#8a8a82">如果按钮无法点击，请复制这个链接到浏览器：<br><span style="word-break:break-all;color:#4a4a45">%s</span></p>
    </td></tr>
    <tr><td style="padding:8px 32px 30px">
      <hr style="border:0;border-top:1px solid #eeeee8;margin:0 0 16px">
      <p style="margin:0;font-size:12px;line-height:1.7;color:#8a8a82">链接 %d 小时内有效，只能使用一次。如果这不是你发起的，可以忽略这封邮件，你的账户仍可正常使用。这封邮件由系统发出，不需要回复。</p>
    </td></tr>
  </table>
</body></html>`, link, link, hours)

	return mailer.Message{
		To:      []string{to},
		Subject: subject,
		Text:    text,
		HTML:    html,
	}
}
