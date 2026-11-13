package auth

import (
	"context"
	"errors"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
)

// ChangePassword replaces the password of the authenticated account.
//
// The current password has to be presented even though the caller is already
// authenticated: an unattended browser session must not be enough to take over
// the account. Success revokes every other refresh session while keeping the
// caller's own session alive, so a stolen token held elsewhere stops working.
func (s *Service) ChangePassword(
	ctx context.Context,
	userID, siteID, currentRefreshToken, currentPassword, newPassword string,
) error {
	if currentPassword == "" {
		return invalidField("current_password", "required", "current password is required")
	}
	if err := ValidatePassword(newPassword); err != nil {
		return err
	}
	if currentPassword == newPassword {
		return ErrPasswordUnchanged
	}

	identity, err := s.repo.FindEmailIdentityByUser(ctx, userID)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			// A provider-only account has no password to verify, which is exactly the
			// same answer as an existing account with a wrong password.
			return ErrCurrentPasswordInvalid
		}
		return err
	}
	if identity.PasswordHash == "" {
		return ErrCurrentPasswordInvalid
	}

	matches, err := s.hasher.Verify(ctx, currentPassword, identity.PasswordHash)
	if err != nil {
		return err
	}
	if !matches {
		return ErrCurrentPasswordInvalid
	}

	passwordHash, err := s.hasher.Hash(ctx, newPassword)
	if err != nil {
		return err
	}
	// A password change must not be able to unverify the address that already
	// proved itself, so the identity timestamp is left untouched.
	if err := s.repo.UpdatePasswordHash(ctx, identity.ID, passwordHash, nil); err != nil {
		return err
	}

	keepSessionID := ""
	if currentRefreshToken != "" {
		if record, findErr := s.repo.FindSessionByHash(ctx, HashOpaqueToken(currentRefreshToken)); findErr == nil {
			if record.UserID == userID {
				keepSessionID = record.ID
			}
		}
	}
	if err := s.repo.RevokeOtherUserSessions(
		ctx, userID, keepSessionID, "password_changed", s.now(),
	); err != nil {
		return err
	}

	s.recordAudit(ctx, audit.Entry{
		SiteID:     siteID,
		ActorID:    userID,
		Action:     "auth.password_changed",
		TargetType: "user",
		TargetID:   userID,
		Detail:     map[string]any{"other_sessions_revoked": keepSessionID != ""},
	})
	return nil
}
