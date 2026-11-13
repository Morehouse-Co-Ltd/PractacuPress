// Package safetystore implements the content safety persistence port with Ent.
package safetystore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/safety"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/sensitiveword"
	"github.com/practacu/practacu-press/apps/api/ent/siteiprule"
	"github.com/practacu/practacu-press/apps/api/ent/sitesafetysetting"
)

// Store is the Ent backed implementation of safety.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ safety.Repository = (*Store)(nil)

// ListWords returns every configured word of a site.
func (s *Store) ListWords(ctx context.Context, siteID string) ([]safety.SensitiveWord, error) {
	rows, err := s.client.SensitiveWord.Query().
		Where(sensitiveword.SiteIDEQ(siteID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	words := make([]safety.SensitiveWord, 0, len(rows))
	for _, row := range rows {
		words = append(words, toWord(row))
	}
	return words, nil
}

// InsertWord stores a new word.
func (s *Store) InsertWord(ctx context.Context, word safety.SensitiveWord) (safety.SensitiveWord, error) {
	builder := s.client.SensitiveWord.Create().
		SetID(word.ID).
		SetSiteID(word.SiteID).
		SetWord(word.Word).
		SetMode(string(word.Mode)).
		SetReplacement(word.Replacement).
		SetEnabled(word.Enabled).
		SetCreatedAt(word.CreatedAt).
		SetUpdatedAt(word.UpdatedAt)

	row, err := builder.Save(ctx)
	if err != nil {
		if entgen.IsConstraintError(err) {
			return safety.SensitiveWord{}, safety.ErrConflict
		}
		return safety.SensitiveWord{}, err
	}
	return toWord(row), nil
}

// FindWord loads one word inside a site scope.
func (s *Store) FindWord(ctx context.Context, siteID, wordID string) (safety.SensitiveWord, error) {
	row, err := s.client.SensitiveWord.Query().
		Where(sensitiveword.IDEQ(wordID), sensitiveword.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return safety.SensitiveWord{}, safety.ErrNotFound
		}
		return safety.SensitiveWord{}, err
	}
	return toWord(row), nil
}

// UpdateWord stores a mode, replacement or enabled change.
func (s *Store) UpdateWord(ctx context.Context, word safety.SensitiveWord) (safety.SensitiveWord, error) {
	if err := s.client.SensitiveWord.UpdateOneID(word.ID).
		SetMode(string(word.Mode)).
		SetReplacement(word.Replacement).
		SetEnabled(word.Enabled).
		SetUpdatedAt(word.UpdatedAt).
		Exec(ctx); err != nil {
		if entgen.IsNotFound(err) {
			return safety.SensitiveWord{}, safety.ErrNotFound
		}
		return safety.SensitiveWord{}, err
	}
	return s.FindWord(ctx, word.SiteID, word.ID)
}

// DeleteWord removes one word inside a site scope.
func (s *Store) DeleteWord(ctx context.Context, siteID, wordID string) error {
	count, err := s.client.SensitiveWord.Delete().
		Where(sensitiveword.IDEQ(wordID), sensitiveword.SiteIDEQ(siteID)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return safety.ErrNotFound
	}
	return nil
}

// ListIPRules returns every allow and deny entry of a site.
func (s *Store) ListIPRules(ctx context.Context, siteID string) ([]safety.IPRule, error) {
	rows, err := s.client.SiteIPRule.Query().
		Where(siteiprule.SiteIDEQ(siteID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	rules := make([]safety.IPRule, 0, len(rows))
	for _, row := range rows {
		rules = append(rules, toIPRule(row))
	}
	return rules, nil
}

// InsertIPRule stores a new rule.
func (s *Store) InsertIPRule(ctx context.Context, rule safety.IPRule) (safety.IPRule, error) {
	builder := s.client.SiteIPRule.Create().
		SetID(rule.ID).
		SetSiteID(rule.SiteID).
		SetKind(string(rule.Kind)).
		SetValue(rule.Value).
		SetCreatedAt(rule.CreatedAt)
	if rule.Note != "" {
		builder.SetNote(rule.Note)
	}

	row, err := builder.Save(ctx)
	if err != nil {
		if entgen.IsConstraintError(err) {
			return safety.IPRule{}, safety.ErrConflict
		}
		return safety.IPRule{}, err
	}
	return toIPRule(row), nil
}

// FindIPRule loads one rule inside a site scope.
func (s *Store) FindIPRule(ctx context.Context, siteID, ruleID string) (safety.IPRule, error) {
	row, err := s.client.SiteIPRule.Query().
		Where(siteiprule.IDEQ(ruleID), siteiprule.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return safety.IPRule{}, safety.ErrNotFound
		}
		return safety.IPRule{}, err
	}
	return toIPRule(row), nil
}

// DeleteIPRule removes one rule inside a site scope.
func (s *Store) DeleteIPRule(ctx context.Context, siteID, ruleID string) error {
	count, err := s.client.SiteIPRule.Delete().
		Where(siteiprule.IDEQ(ruleID), siteiprule.SiteIDEQ(siteID)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if count == 0 {
		return safety.ErrNotFound
	}
	return nil
}

// RateConfig returns the site limits or ErrNotFound when the row has never been
// written (the site is using the documented defaults).
func (s *Store) RateConfig(ctx context.Context, siteID string) (safety.RateConfig, error) {
	row, err := s.client.SiteSafetySetting.Query().
		Where(sitesafetysetting.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return safety.RateConfig{}, safety.ErrNotFound
		}
		return safety.RateConfig{}, err
	}
	return safety.RateConfig{
		UserLimit: row.CommentUserLimit,
		IPLimit:   row.CommentIPLimit,
		Window:    time.Duration(row.CommentWindowSeconds) * time.Second,
	}, nil
}

// SaveRateConfig upserts the limits of one site.
func (s *Store) SaveRateConfig(
	ctx context.Context,
	siteID string,
	cfg safety.RateConfig,
	at time.Time,
) error {
	seconds := int(cfg.Window / time.Second)
	row, err := s.client.SiteSafetySetting.Query().
		Where(sitesafetysetting.SiteIDEQ(siteID)).
		Only(ctx)
	switch {
	case err == nil:
		return s.client.SiteSafetySetting.UpdateOneID(row.ID).
			SetCommentUserLimit(cfg.UserLimit).
			SetCommentIPLimit(cfg.IPLimit).
			SetCommentWindowSeconds(seconds).
			SetUpdatedAt(at).
			Exec(ctx)
	case entgen.IsNotFound(err):
		_, createErr := s.client.SiteSafetySetting.Create().
			SetSiteID(siteID).
			SetCommentUserLimit(cfg.UserLimit).
			SetCommentIPLimit(cfg.IPLimit).
			SetCommentWindowSeconds(seconds).
			SetCreatedAt(at).
			SetUpdatedAt(at).
			Save(ctx)
		if createErr != nil && entgen.IsConstraintError(createErr) {
			// A concurrent first write won the unique site_id key; update that row.
			return s.SaveRateConfig(ctx, siteID, cfg, at)
		}
		return createErr
	default:
		return err
	}
}

func toWord(row *entgen.SensitiveWord) safety.SensitiveWord {
	return safety.SensitiveWord{
		ID:          row.ID,
		SiteID:      row.SiteID,
		Word:        row.Word,
		Mode:        safety.WordMode(row.Mode),
		Replacement: row.Replacement,
		Enabled:     row.Enabled,
		CreatedAt:   row.CreatedAt,
		UpdatedAt:   row.UpdatedAt,
	}
}

func toIPRule(row *entgen.SiteIPRule) safety.IPRule {
	rule := safety.IPRule{
		ID:        row.ID,
		SiteID:    row.SiteID,
		Kind:      safety.IPRuleKind(row.Kind),
		Value:     row.Value,
		CreatedAt: row.CreatedAt,
	}
	if row.Note != nil {
		rule.Note = *row.Note
	}
	return rule
}
