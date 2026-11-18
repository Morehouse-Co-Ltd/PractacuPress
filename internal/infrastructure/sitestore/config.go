package sitestore

import (
	"context"
	"encoding/json"

	entgen "github.com/practacu/practacu-press/ent"
	"github.com/practacu/practacu-press/ent/siteconfig"
	"github.com/practacu/practacu-press/internal/site"
)

// SiteConfig returns the saved site configuration of one site.
func (s *Store) SiteConfig(ctx context.Context, siteID string) (site.SiteConfig, error) {
	row, err := s.client.SiteConfig.Query().
		Where(siteconfig.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return site.SiteConfig{}, site.ErrSiteConfigNotFound
		}
		return site.SiteConfig{}, err
	}
	return toSiteConfig(row), nil
}

// SaveSiteConfig upserts the site configuration and records the audit entry in the same
// transaction.
//
// Same conditional write as SaveCustomization: two devices that both read revision 3 must
// not both write 4, or one configuration silently disappears. A stale precondition is a
// conflict; only a genuinely absent row may be created, and only by a caller that did not
// claim to have read an older version.
func (s *Store) SaveSiteConfig(
	ctx context.Context,
	siteID string,
	in site.SiteConfigInput,
	audit site.AuditEntry,
) (site.SiteConfig, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return site.SiteConfig{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	// The current document is read before the write because a top level key the
	// caller did not send must survive: `site_configs` also carries server owned
	// sections (notably `step_up`), and a client that only knows the documented
	// fields would otherwise erase them on every save. The merge is skipped when the
	// caller provably read an older revision: the conditional update below refuses
	// that write anyway.
	current, err := tx.SiteConfig.Query().
		Where(siteconfig.SiteIDEQ(siteID)).
		Only(ctx)
	switch {
	case err == nil:
		in.Document = mergeMissingTopLevelKeys([]byte(current.Document), in.Document)
	case entgen.IsNotFound(err):
		// A fresh site: nothing to merge.
	default:
		return site.SiteConfig{}, err
	}

	affected, err := tx.SiteConfig.Update().
		Where(
			siteconfig.SiteIDEQ(siteID),
			siteconfig.RevisionEQ(in.ExpectedRevision),
		).
		SetDocument(string(in.Document)).
		AddRevision(1).
		Save(ctx)
	if err != nil {
		return site.SiteConfig{}, err
	}

	if affected == 0 {
		exists, err := tx.SiteConfig.Query().
			Where(siteconfig.SiteIDEQ(siteID)).
			Exist(ctx)
		if err != nil {
			return site.SiteConfig{}, err
		}
		if exists {
			return site.SiteConfig{}, site.ErrSiteConfigConflict
		}
		if in.ExpectedRevision > 0 {
			// The caller expected a configuration that is no longer there; recreating it
			// silently would resurrect settings someone deliberately discarded.
			return site.SiteConfig{}, site.ErrSiteConfigConflict
		}
		if _, err := tx.SiteConfig.Create().
			SetSiteID(siteID).
			SetDocument(string(in.Document)).
			SetRevision(1).
			Save(ctx); err != nil {
			return site.SiteConfig{}, err
		}
	}

	saved, err := tx.SiteConfig.Query().
		Where(siteconfig.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		return site.SiteConfig{}, err
	}

	if err := insertAudit(ctx, tx.Client(), audit, "site_config", siteID); err != nil {
		return site.SiteConfig{}, err
	}

	if err := tx.Commit(); err != nil {
		return site.SiteConfig{}, err
	}
	committed = true

	return toSiteConfig(saved), nil
}

// toSiteConfig maps a generated row onto the domain type.
func toSiteConfig(row *entgen.SiteConfig) site.SiteConfig {
	return site.SiteConfig{
		Document:  []byte(row.Document),
		Revision:  row.Revision,
		UpdatedAt: row.UpdatedAt.UTC(),
	}
}

// mergeMissingTopLevelKeys copies the top level keys of current that incoming does
// not carry.
//
// The site configuration is an opaque JSON document: the browser writes the section
// it knows and the server adds sections of its own (today `step_up`). Without this
// merge, one save from a client that never saw those keys would silently drop them,
// which for `step_up` means switching a security control off by accident. Keys the
// caller does send keep the caller's value byte for byte; the document is returned
// untouched when there is nothing to merge, so the "stored verbatim" guarantee still
// holds for an ordinary save.
func mergeMissingTopLevelKeys(current, incoming []byte) []byte {
	if len(current) == 0 || len(incoming) == 0 {
		return incoming
	}
	var stored, sent map[string]json.RawMessage
	if err := json.Unmarshal(current, &stored); err != nil {
		return incoming
	}
	if err := json.Unmarshal(incoming, &sent); err != nil {
		return incoming
	}
	if sent == nil {
		sent = map[string]json.RawMessage{}
	}
	added := false
	for key, raw := range stored {
		if _, ok := sent[key]; ok {
			continue
		}
		sent[key] = raw
		added = true
	}
	if !added {
		return incoming
	}
	merged, err := json.Marshal(sent)
	if err != nil {
		return incoming
	}
	return merged
}
