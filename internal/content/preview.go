package content

import (
	"context"
	"net/url"
	"time"
)

// Draft preview links (Beta 1.2 contract H).
//
// A preview link lets an editor or an outside reviewer open an unpublished draft
// without a session. It is deliberately narrow: the token authorizes one item, expires
// after PreviewTokenTTL, and never weakens the item's own access mode. So a public
// draft can be reviewed anonymously, while a password protected one still needs its
// password and a members-only one still needs an account.

// PreviewTokenTTL is the default lifetime of a minted preview link.
const PreviewTokenTTL = 30 * time.Minute

// SetPreviewSigner wires the token signer after construction.
//
// The composition root may prefer a setter when the signer (which loads its key from
// the data directory) is built next to the content service rather than before it. Like
// every wiring method in this codebase it is called once, before the server serves
// requests, and is not concurrency safe with signing.
func (s *Service) SetPreviewSigner(signer PreviewSigner) { s.preview = signer }

// PreviewGrant is the response of the preview endpoint.
type PreviewGrant struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
	// Path is the site relative URL to open, with the token already attached.
	Path string `json:"path"`
}

// IssuePreview mints a preview link for one item.
//
// The same authority that may read the raw history may preview it: the author and
// editors. Anyone else receives ErrNotFound rather than a permission error, so the
// endpoint never confirms that a private item exists.
func (s *Service) IssuePreview(ctx context.Context, actor Actor, contentID string) (PreviewGrant, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return PreviewGrant{}, err
	}
	if !canReadHistory(item, actor) {
		return PreviewGrant{}, ErrNotFound
	}
	if s.preview == nil {
		// Signing was not wired: refusing is safer than handing out an unsigned link
		// that would grant nothing or, worse, be forgeable.
		return PreviewGrant{}, ErrPreviewUnavailable
	}

	token, expiresAt, err := s.preview.Issue(item.ID, PreviewTokenTTL)
	if err != nil {
		return PreviewGrant{}, err
	}
	return PreviewGrant{
		Token:     token,
		ExpiresAt: expiresAt,
		Path:      ContentPath(item) + "?preview_token=" + url.QueryEscape(token),
	}, nil
}

// ReadWithPreview reads one item, honouring a preview token when it is valid.
//
// The token is checked against the loaded item, which is what scopes it to exactly one
// draft. An invalid or expired token is not an error on its own: the request simply
// falls back to the ordinary read, so an unpublished item still answers 404 and the
// token cannot be used as an existence probe.
func (s *Service) ReadWithPreview(
	ctx context.Context,
	actor Actor,
	contentID, previewToken string,
	unlocked bool,
) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	preview := s.previewAuthorizes(item.ID, previewToken)
	if err := readableWithPreview(item, actor, unlocked, preview); err != nil {
		return Content{}, err
	}
	return item, nil
}

// previewAuthorizes reports whether token is a valid preview token minted for
// contentID.
func (s *Service) previewAuthorizes(contentID, token string) bool {
	if s.preview == nil {
		return false
	}
	authorizedID, ok := s.preview.Verify(token)
	return ok && authorizedID == contentID
}
