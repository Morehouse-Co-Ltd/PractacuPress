package auth

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/practacu/practacu-press/internal/audit"
)

// MaxBioLength bounds the free text profile bio (users.bio is VARCHAR 2000).
const MaxBioLength = 2000

// AvatarValidator checks that an avatar media reference is usable by this caller.
//
// It is a narrow port so the auth module does not depend on the media module (and
// its storage adapters). The composition root adapts media.Service to it.
type AvatarValidator interface {
	ValidateAvatar(ctx context.Context, siteID, userID, assetID string) error
}

// UpdateProfile applies a self-service partial profile update.
//
// Only the authenticated account itself can be edited; there is deliberately no
// user id parameter, so this endpoint cannot be turned into an account editor for
// someone else.
func (s *Service) UpdateProfile(
	ctx context.Context,
	userID, siteID string,
	in ProfileInput,
) (UserView, error) {
	update := ProfileUpdate{}
	changed := make([]string, 0, 3)

	if in.DisplayName != nil {
		name, err := ValidateDisplayName(*in.DisplayName)
		if err != nil {
			return UserView{}, err
		}
		update.DisplayName = &name
		changed = append(changed, "display_name")
	}

	if in.Bio != nil {
		bio := strings.TrimSpace(*in.Bio)
		if utf8.RuneCountInString(bio) > MaxBioLength {
			return UserView{}, invalidField("bio", "too_long", "bio is too long")
		}
		update.Bio = &bio
		changed = append(changed, "bio")
	}

	if in.AvatarMediaID != nil {
		assetID := strings.TrimSpace(*in.AvatarMediaID)
		if len(assetID) > 36 {
			return UserView{}, invalidField("avatar_media_id", "too_long", "avatar id is too long")
		}
		if assetID != "" {
			if s.avatars == nil {
				return UserView{}, invalidField("avatar_media_id", "invalid",
					"avatar must be a clean image you uploaded")
			}
			if err := s.avatars.ValidateAvatar(ctx, siteID, userID, assetID); err != nil {
				return UserView{}, invalidField("avatar_media_id", "invalid",
					"avatar must be a clean image you uploaded")
			}
		}
		update.AvatarMediaID = &assetID
		changed = append(changed, "avatar_media_id")
	}

	user, err := s.repo.UpdateProfile(ctx, userID, update)
	if err != nil {
		return UserView{}, err
	}
	view := user.View()
	if identity, identityErr := s.repo.FindEmailIdentityByUser(ctx, userID); identityErr == nil {
		view.Email = identity.Email
		if identity.VerifiedAt != nil {
			view.EmailVerified = true
		}
	}

	if len(changed) > 0 {
		s.recordAudit(ctx, audit.Entry{
			SiteID:     siteID,
			ActorID:    userID,
			Action:     "auth.profile_updated",
			TargetType: "user",
			TargetID:   userID,
			Detail:     map[string]any{"fields": changed},
		})
	}
	return view, nil
}

// recordAudit writes one account security event.
//
// Auditing is best effort here on purpose: an unreachable audit table must not
// make login, registration or a password change fail. The error is logged so an
// operator can see the gap, and the business operation still returns success.
func (s *Service) recordAudit(ctx context.Context, entry audit.Entry) {
	if s.audit == nil {
		return
	}
	if entry.At.IsZero() {
		entry.At = s.now()
	}
	if err := s.audit.Record(ctx, entry); err != nil {
		s.logError("audit write failed", "error", err, "action", entry.Action)
	}
}
