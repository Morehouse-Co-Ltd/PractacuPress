package platformadmin_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/infrastructure/auditstore"
	"github.com/practacu/practacu-press/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/platformstore"
	"github.com/practacu/practacu-press/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/platformadmin"
	"github.com/practacu/practacu-press/internal/site"
	ginrouter "github.com/practacu/practacu-press/internal/transport/http/gin"
	"github.com/practacu/practacu-press/internal/transport/http/gin/middleware"

	entgen "github.com/practacu/practacu-press/internal/ent"
	entsite "github.com/practacu/practacu-press/internal/ent/site"
	"github.com/practacu/practacu-press/internal/ent/sitecustomization"
	entsitemember "github.com/practacu/practacu-press/internal/ent/sitemember"
	entuser "github.com/practacu/practacu-press/internal/ent/user"
)

// dynamicTXT answers the challenge the way a correctly configured DNS zone would:
// it reads the stored token of the site that owns the record name.
type dynamicTXT struct{ client *entgen.Client }

func (d dynamicTXT) LookupTXT(ctx context.Context, name string) ([]string, error) {
	domain := strings.TrimPrefix(name, site.DomainVerificationRecordPrefix)
	row, err := d.client.Site.Query().Where(entsite.DomainEQ(domain)).Only(ctx)
	if err != nil {
		return nil, err
	}
	if row.DomainVerificationToken == nil {
		return nil, nil
	}
	return []string{*row.DomainVerificationToken}, nil
}

// mapResolver answers from an explicit host map, falling back to the console's own
// site. The test mutates it when a target domain becomes verified.
type mapResolver struct {
	fallback site.Site
	byHost   map[string]site.Site
}

func (m *mapResolver) Resolve(_ context.Context, host string) (site.Site, error) {
	if found, ok := m.byHost[host]; ok {
		return found, nil
	}
	if m.fallback.ID != "" {
		return m.fallback, nil
	}
	return site.Site{}, site.ErrNotFound
}

type harness struct {
	router   *gin.Engine
	db       *db.DB
	resolver *mapResolver
	issuer   *auth.TokenIssuer
	site     site.Site
	rootID   string
	rootTok  string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "platform.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	verifiedNow := time.Now().UTC()
	siteRow, err := handle.Client.Site.Create().
		SetSlug("main").
		SetName("Main").
		SetDomain("main.local").
		SetDomainVerifiedAt(verifiedNow).
		Save(ctx)
	require.NoError(t, err)
	root, err := handle.Client.User.Create().SetDisplayName("Root").Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.SiteMember.Create().
		SetSiteID(siteRow.ID).
		SetUserID(root.ID).
		SetRole(string(site.RolePlatformAdmin)).
		SetStatus(site.MemberStatusActive).
		Save(ctx)
	require.NoError(t, err)

	cfg := config.Config{AppEnv: config.EnvTest, AuthJWTIssuer: "platform-handler-test", DefaultSiteID: siteRow.ID}
	issuer, _, err := auth.NewTokenIssuer(cfg)
	require.NoError(t, err)

	authService, err := auth.NewService(auth.ServiceConfig{
		Repository: authstore.New(handle.Client),
		Hasher: auth.NewArgon2idHasher(auth.Argon2Params{
			Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
		}),
		Tokens: issuer,
	})
	require.NoError(t, err)

	siteService, err := site.NewService(
		sitestore.New(handle.Client),
		site.WithTXTLookup(dynamicTXT{client: handle.Client}),
	)
	require.NoError(t, err)
	platformService, err := platformadmin.NewService(platformadmin.ServiceConfig{
		Repository: sitestore.New(handle.Client),
		Accounts:   authService,
		Sessions:   authService,
		Tokens:     issuer,
		Domains:    siteService,
		// The cross-site views read the same database: the console adapter counts the
		// deployment and the shared audit store provides both the cross-site reader
		// and the recorder of the query itself.
		Metrics:   platformstore.New(handle.Client),
		Directory: platformstore.New(handle.Client),
		Trail:     auditstore.New(handle.Client),
		Recorder:  auditstore.New(handle.Client),
	})
	require.NoError(t, err)

	consoleSite := site.Site{
		ID: siteRow.ID, Slug: "main", Name: "Main",
		Domain: "main.local", DomainVerifiedAt: &verifiedNow,
	}
	resolver := &mapResolver{fallback: consoleSite, byHost: map[string]site.Site{}}

	authHandler := auth.NewHandler(authService, auth.HandlerConfig{
		SiteID:    func(*gin.Context) string { return siteRow.ID },
		Principal: middleware.PrincipalFrom,
	})
	platformHandler := platformadmin.NewHandler(platformService, platformadmin.HandlerConfig{
		Principal: func(c *gin.Context) (string, string, bool) {
			principal, ok := middleware.PrincipalFrom(c)
			return principal.UserID, principal.SiteID, ok
		},
		Site:     middleware.SiteFrom,
		Sessions: authHandler,
	})

	router := ginrouter.New(ginrouter.Dependencies{
		Config:       cfg,
		SiteResolver: resolver,
		AccessTokens: issuer,
		Memberships:  siteService,
		Auth:         authHandler,
		Platform:     platformHandler,
	})

	token, _, err := issuer.IssueAccess(auth.Principal{
		UserID: root.ID,
		SiteID: siteRow.ID,
		Role:   site.RolePlatformAdmin,
	})
	require.NoError(t, err)

	return &harness{
		router:   router,
		db:       handle,
		resolver: resolver,
		issuer:   issuer,
		site:     consoleSite,
		rootID:   root.ID,
		rootTok:  token,
	}
}

func (h *harness) do(t *testing.T, method, path, host, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var payload *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		payload = bytes.NewReader(raw)
	} else {
		payload = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, payload)
	req.Host = host
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	return w
}

func decode(t *testing.T, w *httptest.ResponseRecorder, target any) {
	t.Helper()
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), target), w.Body.String())
}

func TestPlatformListCreateDetailAndEnter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newHarness(t)
	ctx := context.Background()

	list := h.do(t, http.MethodGet, "/api/v1/platform/sites", "main.local", h.rootTok, nil)
	require.Equal(t, http.StatusOK, list.Code, list.Body.String())
	var listBody struct {
		Items []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"items"`
	}
	decode(t, list, &listBody)
	require.Len(t, listBody.Items, 1)
	require.Equal(t, h.site.ID, listBody.Items[0].ID)

	create := h.do(t, http.MethodPost, "/api/v1/platform/sites", "main.local", h.rootTok, map[string]any{
		"name":            "Journal",
		"slug":            "journal",
		"domain":          "journal.example",
		"visibility_mode": "public",
		"owner": map[string]string{
			"email":        "owner@example.com",
			"display_name": "Owner",
			"password":     "correct horse battery",
		},
	})
	require.Equal(t, http.StatusCreated, create.Code, create.Body.String())
	var created struct {
		Site struct {
			ID     string `json:"id"`
			Slug   string `json:"slug"`
			Domain string `json:"domain"`
		} `json:"site"`
		Owner struct {
			UserID string `json:"user_id"`
			Role   string `json:"role"`
		} `json:"owner"`
	}
	decode(t, create, &created)
	require.Equal(t, "journal", created.Site.Slug)
	require.Equal(t, "journal.example", created.Site.Domain)
	require.Equal(t, string(site.RoleSiteAdmin), created.Owner.Role)

	// The default design document and the owner membership exist immediately.
	design, err := h.db.Client.SiteCustomization.Query().
		Where(sitecustomization.SiteIDEQ(created.Site.ID)).
		Only(ctx)
	require.NoError(t, err)
	require.Contains(t, design.Document, "schema_version")
	owner, err := h.db.Client.SiteMember.Query().All(ctx)
	require.NoError(t, err)
	require.Len(t, owner, 2)

	detail := h.do(t, http.MethodGet, "/api/v1/platform/sites/"+created.Site.ID, "main.local", h.rootTok, nil)
	require.Equal(t, http.StatusOK, detail.Code, detail.Body.String())
	var detailBody struct {
		DomainStatus struct {
			Domain            string `json:"domain"`
			Verified          bool   `json:"verified"`
			VerificationToken string `json:"verification_token"`
			RecordName        string `json:"record_name"`
		} `json:"domain_status"`
	}
	decode(t, detail, &detailBody)
	require.False(t, detailBody.DomainStatus.Verified)
	require.NotEmpty(t, detailBody.DomainStatus.VerificationToken)
	require.Equal(t, "_practacu-verify.journal.example", detailBody.DomainStatus.RecordName)

	// The new domain is a pending challenge, so it cannot be entered yet.
	blocked := h.do(t, http.MethodPost, "/api/v1/platform/sites/"+created.Site.ID+"/enter", "main.local", h.rootTok, nil)
	require.Equal(t, http.StatusOK, blocked.Code, blocked.Body.String())
	var blockedEntry struct {
		Switchable bool   `json:"switchable"`
		Reason     string `json:"reason"`
	}
	decode(t, blocked, &blockedEntry)
	require.False(t, blockedEntry.Switchable)
	require.Equal(t, "domain_unverified", blockedEntry.Reason)

	// The console can redeem the challenge: the site's own admin area is unreachable
	// until the hostname proves ownership, so this is the bootstrap path.
	verify := h.do(t, http.MethodPost,
		"/api/v1/platform/sites/"+created.Site.ID+"/domain/verify", "main.local", h.rootTok, nil)
	require.Equal(t, http.StatusOK, verify.Code, verify.Body.String())
	var verifyBody struct {
		Verified bool   `json:"verified"`
		Domain   string `json:"domain"`
	}
	decode(t, verify, &verifyBody)
	require.True(t, verifyBody.Verified)
	require.Equal(t, "journal.example", verifyBody.Domain)

	// Once the operator proves the domain, the console hands over a token...
	verifiedAt := time.Now().UTC()
	h.resolver.byHost["journal.example"] = site.Site{
		ID:               created.Site.ID,
		Slug:             "journal",
		Name:             "Journal",
		Domain:           "journal.example",
		DomainVerifiedAt: &verifiedAt,
	}
	enter := h.do(t, http.MethodPost, "/api/v1/platform/sites/"+created.Site.ID+"/enter", "main.local", h.rootTok, nil)
	require.Equal(t, http.StatusOK, enter.Code, enter.Body.String())
	var entry struct {
		Switchable  bool   `json:"switchable"`
		SwitchToken string `json:"switch_token"`
	}
	decode(t, enter, &entry)
	require.True(t, entry.Switchable)
	require.NotEmpty(t, entry.SwitchToken)

	// ...and redeems it on the target origin for a normal session.
	claim := h.do(t, http.MethodPost, "/api/v1/platform/enter/claim", "journal.example", "", map[string]string{
		"switch_token": entry.SwitchToken,
	})
	require.Equal(t, http.StatusOK, claim.Code, claim.Body.String())
	require.Contains(t, claim.Header().Get("Set-Cookie"), auth.RefreshCookieName)
	var session struct {
		AccessToken string `json:"access_token"`
		User        struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	decode(t, claim, &session)
	require.NotEmpty(t, session.AccessToken)
	require.Equal(t, h.rootID, session.User.ID)
}

func TestPlatformRequiresPlatformAdmin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newHarness(t)
	ctx := context.Background()

	member, err := h.db.Client.User.Create().SetDisplayName("Reader").Save(ctx)
	require.NoError(t, err)
	_, err = h.db.Client.SiteMember.Create().
		SetSiteID(h.site.ID).
		SetUserID(member.ID).
		SetRole(string(site.RoleMember)).
		SetStatus(site.MemberStatusActive).
		Save(ctx)
	require.NoError(t, err)
	token, _, err := h.issuer.IssueAccess(auth.Principal{
		UserID: member.ID, SiteID: h.site.ID, Role: site.RoleMember,
	})
	require.NoError(t, err)

	list := h.do(t, http.MethodGet, "/api/v1/platform/sites", "main.local", token, nil)
	require.Equal(t, http.StatusForbidden, list.Code, list.Body.String())
	require.Contains(t, list.Body.String(), `"code":"permission_denied"`)

	create := h.do(t, http.MethodPost, "/api/v1/platform/sites", "main.local", token, map[string]any{
		"name": "Other", "slug": "other", "domain": "other.example",
		"owner": map[string]string{
			"email": "other@example.com", "display_name": "Other", "password": "correct horse battery",
		},
	})
	require.Equal(t, http.StatusForbidden, create.Code, create.Body.String())
	count, err := h.db.Client.Site.Query().Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}

// TestPlatformCreateAllowsConfirmedWeakOwnerPassword covers the platform console's
// first-administrator password: it uses the same confirmation flag as every other
// password creation path, and the hard bounds still apply without it.
func TestPlatformCreateAllowsConfirmedWeakOwnerPassword(t *testing.T) {
	h := newHarness(t)

	create := h.do(t, http.MethodPost, "/api/v1/platform/sites", "main.local", h.rootTok, map[string]any{
		"name":   "Weak owner site",
		"slug":   "weak-owner-site",
		"domain": "weak-owner.example",
		"owner": map[string]any{
			"email":                 "weak-owner@example.com",
			"display_name":          "Weak owner",
			"password":              "short",
			"confirm_weak_password": true,
		},
	})
	require.Equal(t, http.StatusCreated, create.Code, create.Body.String())

	var created struct {
		Site struct {
			ID string `json:"id"`
		} `json:"site"`
	}
	decode(t, create, &created)
	require.NotEmpty(t, created.Site.ID)

	user, err := h.db.Client.User.Query().
		Where(entuser.DisplayNameEQ("Weak owner")).
		Only(context.Background())
	require.NoError(t, err)
	require.NotEmpty(t, user.ID)

	member, err := h.db.Client.SiteMember.Query().
		Where(
			entsitemember.SiteIDEQ(created.Site.ID),
			entsitemember.UserIDEQ(user.ID),
		).
		Only(context.Background())
	require.NoError(t, err)
	require.Equal(t, string(site.RoleSiteAdmin), member.Role)
}

func TestPlatformCreateRejectsDuplicateSlugAndInvalidInput(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := newHarness(t)

	body := map[string]any{
		"name": "Main copy", "slug": "main", "domain": "copy.example",
		"owner": map[string]string{
			"email": "copy@example.com", "display_name": "Copy", "password": "correct horse battery",
		},
	}
	w := h.do(t, http.MethodPost, "/api/v1/platform/sites", "main.local", h.rootTok, body)
	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "slug_taken")

	body["slug"] = "copy"
	body["domain"] = "not a domain"
	w = h.do(t, http.MethodPost, "/api/v1/platform/sites", "main.local", h.rootTok, body)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "validation_failed")

	body["domain"] = "copy.example"
	body["owner"].(map[string]string)["password"] = "short"
	w = h.do(t, http.MethodPost, "/api/v1/platform/sites", "main.local", h.rootTok, body)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())

	count, err := h.db.Client.Site.Query().Count(context.Background())
	require.NoError(t, err)
	require.Equal(t, 1, count)
}
