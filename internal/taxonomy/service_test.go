package taxonomy

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

type fakeRepo struct {
	terms   []Term
	nextID  int
	deleted []string
}

func (f *fakeRepo) List(_ context.Context, siteID string) ([]Term, error) {
	out := make([]Term, 0, len(f.terms))
	for _, term := range f.terms {
		if term.SiteID == siteID {
			out = append(out, term)
		}
	}
	return out, nil
}

func (f *fakeRepo) FindByID(_ context.Context, siteID, termID string) (Term, error) {
	for _, term := range f.terms {
		if term.SiteID == siteID && term.ID == termID {
			return term, nil
		}
	}
	return Term{}, ErrNotFound
}

func (f *fakeRepo) Insert(_ context.Context, term Term) (Term, error) {
	f.nextID++
	term.ID = "term_" + string(rune('0'+f.nextID))
	f.terms = append(f.terms, term)
	return term, nil
}

func (f *fakeRepo) Update(_ context.Context, term Term) (Term, error) {
	for index, existing := range f.terms {
		if existing.ID == term.ID && existing.SiteID == term.SiteID {
			f.terms[index] = term
			return term, nil
		}
	}
	return Term{}, ErrNotFound
}

func (f *fakeRepo) Delete(_ context.Context, siteID, termID string) error {
	for index, term := range f.terms {
		if term.ID == termID && term.SiteID == siteID {
			f.terms = append(f.terms[:index], f.terms[index+1:]...)
			f.deleted = append(f.deleted, termID)
			return nil
		}
	}
	return ErrNotFound
}

func newTestService(t *testing.T, repo Repository) *Service {
	t.Helper()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Now:        func() time.Time { return time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service
}

func siteAdmin() Actor {
	return Actor{UserID: "u1", SiteID: "site_1", Role: site.RoleSiteAdmin}
}

func TestCreateAuthorization(t *testing.T) {
	service := newTestService(t, &fakeRepo{})
	input := Input{Kind: KindCategory, Name: "Craft", Slug: "craft"}

	_, err := service.Create(context.Background(), Actor{}, "site_1", input)
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, err = service.Create(context.Background(), Actor{
		UserID: "u1", SiteID: "site_2", Role: site.RoleSiteAdmin,
	}, "site_1", input)
	require.ErrorIs(t, err, ErrCrossSite)

	_, err = service.Create(context.Background(), Actor{
		UserID: "u1", SiteID: "site_1", Role: site.RoleMember,
	}, "site_1", input)
	require.ErrorIs(t, err, ErrPermissionDenied)

	term, err := service.Create(context.Background(), siteAdmin(), "site_1", input)
	require.NoError(t, err)
	require.Equal(t, KindCategory, term.Kind)
	require.Equal(t, "site_1", term.SiteID)
	require.NotEmpty(t, term.ID)
}

func TestCreateValidatesInput(t *testing.T) {
	service := newTestService(t, &fakeRepo{})
	_, err := service.Create(context.Background(), siteAdmin(), "site_1", Input{
		Kind: "topic", Name: "x", Slug: "x",
	})
	require.Error(t, err)
}

func TestListIsPublicAndScoped(t *testing.T) {
	repo := &fakeRepo{terms: []Term{
		{ID: "t1", SiteID: "site_1", Kind: KindTag, Name: "Go"},
		{ID: "t2", SiteID: "site_2", Kind: KindTag, Name: "Other"},
	}}
	service := newTestService(t, repo)

	terms, err := service.List(context.Background(), "site_1")
	require.NoError(t, err)
	require.Len(t, terms, 1)
	require.Equal(t, "t1", terms[0].ID)

	_, err = service.List(context.Background(), "")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestUpdateAppliesPatch(t *testing.T) {
	repo := &fakeRepo{terms: []Term{{
		ID: "t1", SiteID: "site_1", Kind: KindCategory,
		Name: "Craft", Slug: "craft", Description: "old", Color: "#112233",
	}}}
	service := newTestService(t, repo)

	name := "Craft Notes"
	term, err := service.Update(context.Background(), siteAdmin(), "site_1", "t1",
		PatchInput{Name: &name})
	require.NoError(t, err)
	require.Equal(t, "Craft Notes", term.Name)
	require.Equal(t, "craft", term.Slug)
	require.Equal(t, "old", term.Description)

	_, err = service.Update(context.Background(), siteAdmin(), "site_1", "missing", PatchInput{})
	require.ErrorIs(t, err, ErrNotFound)

	_, err = service.Update(context.Background(), Actor{
		UserID: "u2", SiteID: "site_1", Role: site.RoleMember,
	}, "site_1", "t1", PatchInput{})
	require.ErrorIs(t, err, ErrPermissionDenied)
}

func TestDeleteRequiresAdmin(t *testing.T) {
	repo := &fakeRepo{terms: []Term{{ID: "t1", SiteID: "site_1", Kind: KindTag, Name: "Go"}}}
	service := newTestService(t, repo)

	err := service.Delete(context.Background(), Actor{
		UserID: "u2", SiteID: "site_1", Role: site.RoleEditor,
	}, "site_1", "t1")
	require.ErrorIs(t, err, ErrPermissionDenied)

	require.NoError(t, service.Delete(context.Background(), siteAdmin(), "site_1", "t1"))
	require.Equal(t, []string{"t1"}, repo.deleted)
}
