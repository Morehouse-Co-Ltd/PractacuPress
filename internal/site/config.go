package site

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
)

// MaxSiteConfigBytes bounds one site configuration document.
//
// The document is a handful of switches and thresholds; even with every optional field
// filled it stays well under a few kilobytes. The cap exists so one authenticated write
// cannot fill the database, and so a runaway client fails loudly instead of slowly. It
// is deliberately much smaller than MaxCustomizationBytes: this is not a design.
const MaxSiteConfigBytes = 64 << 10

// Per-field bounds. The frontend enforces the same numbers; the server repeats them
// because the browser is not a security boundary and because an out-of-range value
// stored here would silently render as "off" in `readAccess`-style normalisers.
const (
	maxAdminPathCharacters = 80
	maxAccessMessageRunes  = 200
	maxDomainCharacters    = 253
	maxSiteConfigAliases   = 20
	maxCORSOrigins         = 12
	maxOriginCharacters    = 300
	maxTrustedProxies      = 16
	maxProxyCharacters     = 64
	maxTLSFieldCharacters  = 300
	maxPreconnectOrigins   = 8
	maxAuthProviders       = 8
	maxAuthFieldCharacters = 500
	maxLoadingTextRunes    = 200
	maxLoadingColorRunes   = 64
)

// reservedAdminPathPrefixes are the SPA paths the admin entry must not shadow.
//
// The admin tree is mounted at the configured path, so choosing `/login` would hide the
// login page behind the authenticated admin shell and choosing `/api` would shadow the
// reverse-proxied API. These are route names, not security, but a site owner who types
// one of them must get a validation error instead of an unreachable site.
var reservedAdminPathPrefixes = []string{
	"/setup",
	"/login",
	"/register",
	"/forgot-password",
	"/reset-password",
	"/verify-email",
	"/api",
	"/articles",
	"/posts",
	"/categories",
	"/category",
	"/tags",
	"/tag",
	"/search",
	"/u",
	"/me",
	"/messages",
	"/notifications",
	"/a",
	"/p",
	"/rss.xml",
	"/atom.xml",
	"/sitemap.xml",
	"/robots.txt",
}

// siteConfigDocument is the known shape of the stored document.
//
// Decoding into typed fields (instead of walking a map) means a typo such as
// `"limit": "forty"` is rejected with the field name rather than stored and later
// normalised away by the browser, which is exactly how the "it looks right on my
// machine" bug this feature fixes began. Unknown sections are ignored so the frontend
// can add fields without an API change; pointers distinguish "omitted" from a zero.
type siteConfigDocument struct {
	AdminPath   string                        `json:"admin_path"`
	Access      *accessConfigDocument         `json:"access"`
	Domains     *domainConfigDocument         `json:"domains"`
	Performance *performanceConfigDocument    `json:"performance"`
	Loading     *loadingConfigDocument        `json:"loading"`
	Auth        map[string]authConfigDocument `json:"auth"`
}

type rateRuleDocument struct {
	Enabled       *bool `json:"enabled"`
	Limit         *int  `json:"limit"`
	WindowSeconds *int  `json:"window_seconds"`
	BlockSeconds  *int  `json:"block_seconds"`
}

type tabsRuleDocument struct {
	Enabled *bool `json:"enabled"`
	Limit   *int  `json:"limit"`
}

type accessConfigDocument struct {
	Enabled    *bool             `json:"enabled"`
	PageSwitch *rateRuleDocument `json:"page_switch"`
	Requests   *rateRuleDocument `json:"requests"`
	Tabs       *tabsRuleDocument `json:"tabs"`
	Message    *string           `json:"message"`
}

type tlsConfigDocument struct {
	Mode     string `json:"mode"`
	Email    string `json:"email"`
	CertPath string `json:"cert_path"`
	KeyPath  string `json:"key_path"`
	HSTS     *bool  `json:"hsts"`
}

type domainConfigDocument struct {
	Enabled         *bool              `json:"enabled"`
	Primary         string             `json:"primary"`
	Aliases         []string           `json:"aliases"`
	AllowWWW        *bool              `json:"allow_www"`
	AllowLocalhost  *bool              `json:"allow_localhost"`
	AllowIP         *bool              `json:"allow_ip"`
	RedirectPrimary *bool              `json:"redirect_primary"`
	HTTPSOnly       *bool              `json:"https_only"`
	TLS             *tlsConfigDocument `json:"tls"`
	CORSOrigins     []string           `json:"cors_origins"`
	CookieDomain    string             `json:"cookie_domain"`
	TrustedProxies  []string           `json:"trusted_proxies"`
}

type performanceConfigDocument struct {
	FeedLimit           *int     `json:"feed_limit"`
	ArchiveLimit        *int     `json:"archive_limit"`
	RequestCache        *bool    `json:"request_cache"`
	CacheTTL            *int     `json:"cache_ttl"`
	LazyMedia           *bool    `json:"lazy_media"`
	DisableAnimations   *bool    `json:"disable_animations"`
	Preconnect          []string `json:"preconnect"`
	Gzip                *bool    `json:"gzip"`
	StaticCacheDays     *int     `json:"static_cache_days"`
	KeepaliveTimeout    *int     `json:"keepalive_timeout"`
	ClientMaxBodySizeMB *int     `json:"client_max_body_size_mb"`
	ProxyReadTimeout    *int     `json:"proxy_read_timeout"`
	APIReadTimeout      *int     `json:"api_read_timeout"`
	APIIdleTimeout      *int     `json:"api_idle_timeout"`
	DBMaxOpenConns      *int     `json:"db_max_open_conns"`
	DBMaxIdleConns      *int     `json:"db_max_idle_conns"`
	DBConnMaxLifetime   *int     `json:"db_conn_max_lifetime"`
}

type loadingConfigDocument struct {
	Enabled          *bool   `json:"enabled"`
	Preset           string  `json:"preset"`
	Text             string  `json:"text"`
	AccentMode       string  `json:"accent_mode"`
	Accent           string  `json:"accent"`
	BackgroundMode   string  `json:"background_mode"`
	Background       string  `json:"background"`
	Size             *int    `json:"size"`
	MinDurationMS    *int    `json:"min_duration_ms"`
	ShowOnFirstLoad  *bool   `json:"show_on_first_load"`
	ShowOnNavigation *bool   `json:"show_on_navigation"`
	CustomCSS        *string `json:"custom_css"`
}

type authConfigDocument struct {
	Enabled     *bool  `json:"enabled"`
	ClientID    string `json:"client_id"`
	RedirectURI string `json:"redirect_uri"`
	Extra       string `json:"extra"`
	Note        string `json:"note"`
}

// siteConfigPresets mirrors the frontend `LoadingPreset` union.
var siteConfigPresets = map[string]struct{}{
	"spinner": {}, "dots": {}, "pulse": {}, "bar": {},
	"orbit": {}, "skeleton": {}, "shimmer": {}, "skeleton-shimmer": {},
}

var siteConfigTLSModes = map[string]struct{}{"off": {}, "letsencrypt": {}, "manual": {}}

// SiteConfig returns the saved site configuration of a site.
//
// No actor is involved on purpose, mirroring Customization: who may see which projection
// is a transport concern. The handler answers it from the principal's membership.
func (s *Service) SiteConfig(ctx context.Context, siteID string) (SiteConfig, error) {
	if siteID == "" {
		return SiteConfig{}, ErrNotFound
	}
	return s.repo.SiteConfig(ctx, siteID)
}

// SiteCORSOrigins returns the origins a site allowed for cross origin readers.
//
// It is the read path for `domains.cors_origins`: the per-site CORS middleware runs
// after host resolution, so it needs the list that belongs to the hostname the request
// arrived on, and this package is the only place that knows the stored document shape.
// Keeping the decoding here is what stops a second copy of the JSON tags (and with it a
// second, quietly diverging notion of the setting) from appearing in the transport layer.
//
// The document was validated on write, so this only normalises: surrounding whitespace
// is trimmed and empty or duplicate entries are dropped (compared case insensitively,
// because hostnames are). A document that is not a JSON object yields no origins
// instead of an error, so a hand edited row degrades to "no site level CORS" rather
// than failing every cross origin request of that site.
func SiteCORSOrigins(document []byte) []string {
	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 {
		return nil
	}
	var doc siteConfigDocument
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return nil
	}
	if doc.Domains == nil || len(doc.Domains.CORSOrigins) == 0 {
		return nil
	}

	origins := make([]string, 0, len(doc.Domains.CORSOrigins))
	seen := make(map[string]struct{}, len(doc.Domains.CORSOrigins))
	for _, entry := range doc.Domains.CORSOrigins {
		origin := strings.TrimSpace(entry)
		if origin == "" {
			continue
		}
		key := strings.ToLower(origin)
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		origins = append(origins, origin)
	}
	return origins
}

// SiteCORSOrigins returns the cross origin origins stored for one site.
//
// The transport layer wraps this in per-site caching: a cross origin request is the
// only thing that pays for the read, but that read must not hit the database twice for
// one browser action.
func (s *Service) SiteCORSOrigins(ctx context.Context, siteID string) ([]string, error) {
	stored, err := s.SiteConfig(ctx, siteID)
	if err != nil {
		return nil, err
	}
	return SiteCORSOrigins(stored.Document), nil
}

// SaveSiteConfig validates and stores a site's runtime configuration.
//
// The document is stored byte for byte after validation. The audit entry records the
// shape of the change, never the document itself: this table holds rate thresholds,
// certificate paths and OAuth client ids, none of which belong in the operator log.
func (s *Service) SaveSiteConfig(
	ctx context.Context,
	actor Member,
	siteID string,
	document []byte,
	expectedRevision int,
	requestID string,
) (SiteConfig, error) {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return SiteConfig{}, err
	}
	if err := validateSiteConfigDocument(document); err != nil {
		return SiteConfig{}, err
	}
	// step_up is server owned: it is written only by UpdateStepUpSettings, which
	// applies its own re-authentication rule. A client save (or a round-tripped
	// masked administrator projection) therefore cannot overwrite or erase it; the
	// store merges the stored section back when the incoming document omits it.
	document, err := stripStepUpSection(document)
	if err != nil {
		return SiteConfig{}, err
	}
	if expectedRevision < 0 {
		return SiteConfig{}, fmt.Errorf("%w: revision must not be negative", ErrInvalidInput)
	}

	return s.repo.SaveSiteConfig(
		ctx,
		siteID,
		SiteConfigInput{Document: document, ExpectedRevision: expectedRevision},
		AuditEntry{
			SiteID:    siteID,
			ActorID:   actor.UserID,
			Action:    "site.config.updated",
			Target:    siteID,
			RequestID: requestID,
			Detail: map[string]any{
				"bytes":    len(document),
				"revision": expectedRevision + 1,
			},
			At: s.now(),
		},
	)
}

// validateSiteConfigDocument rejects a payload that is not a JSON object within the size
// cap, or that carries a known field outside its documented range.
func validateSiteConfigDocument(document []byte) error {
	if len(document) == 0 {
		return fmt.Errorf("%w: document is empty", ErrInvalidInput)
	}
	if len(document) > MaxSiteConfigBytes {
		return fmt.Errorf("%w: document exceeds %d bytes", ErrSiteConfigTooLarge, MaxSiteConfigBytes)
	}

	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("%w: document must be a JSON object", ErrInvalidInput)
	}
	if !json.Valid(trimmed) {
		return fmt.Errorf("%w: document is not valid JSON", ErrInvalidInput)
	}

	var doc siteConfigDocument
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return fmt.Errorf("%w: %s", ErrInvalidInput, configFieldError(err))
	}
	return validateSiteConfigFields(doc)
}

// validateSiteConfigFields checks the bounds the browser also enforces.
func validateSiteConfigFields(doc siteConfigDocument) error {
	if path := doc.AdminPath; path != "" {
		if err := validateAdminPath(path); err != nil {
			return err
		}
	}
	if err := validateAccessConfig(doc.Access); err != nil {
		return err
	}
	if err := validateDomainConfig(doc.Domains); err != nil {
		return err
	}
	if err := validatePerformanceConfig(doc.Performance); err != nil {
		return err
	}
	if err := validateLoadingConfig(doc.Loading); err != nil {
		return err
	}
	return validateAuthConfig(doc.Auth)
}

// validateAdminPath enforces the shape the SPA router can mount.
func validateAdminPath(path string) error {
	if !strings.HasPrefix(path, "/") {
		return fmt.Errorf("%w: admin_path must start with /", ErrInvalidInput)
	}
	if len([]rune(path)) > maxAdminPathCharacters {
		return fmt.Errorf("%w: admin_path exceeds %d characters", ErrInvalidInput, maxAdminPathCharacters)
	}
	if strings.Contains(path, "//") {
		return fmt.Errorf("%w: admin_path must not contain //", ErrInvalidInput)
	}
	for _, r := range path {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return fmt.Errorf("%w: admin_path must not contain spaces", ErrInvalidInput)
		}
	}
	if strings.ContainsAny(path, "?#") {
		return fmt.Errorf("%w: admin_path must be a path, not a URL", ErrInvalidInput)
	}
	if path == "/" {
		// Mounting the admin tree at the root would make every site page a dashboard.
		return fmt.Errorf("%w: admin_path must not be /", ErrInvalidInput)
	}

	lowered := strings.TrimSuffix(strings.ToLower(path), "/")
	for _, reserved := range reservedAdminPathPrefixes {
		if lowered == reserved || strings.HasPrefix(lowered, reserved+"/") {
			return fmt.Errorf("%w: admin_path must not shadow %s", ErrInvalidInput, reserved)
		}
	}
	return nil
}

func validateAccessConfig(access *accessConfigDocument) error {
	if access == nil {
		return nil
	}
	for name, rule := range map[string]*rateRuleDocument{
		"access.page_switch": access.PageSwitch,
		"access.requests":    access.Requests,
	} {
		if rule == nil {
			continue
		}
		if err := validateRateRule(name, rule); err != nil {
			return err
		}
	}
	if tabs := access.Tabs; tabs != nil && tabs.Limit != nil {
		if err := requireRange("access.tabs.limit", *tabs.Limit, 1, 64); err != nil {
			return err
		}
	}
	if access.Message != nil {
		if err := requireRunes("access.message", *access.Message, maxAccessMessageRunes); err != nil {
			return err
		}
	}
	return nil
}

func validateRateRule(name string, rule *rateRuleDocument) error {
	if rule.Limit != nil {
		if err := requireRange(name+".limit", *rule.Limit, 1, 10000); err != nil {
			return err
		}
	}
	if rule.WindowSeconds != nil {
		if err := requireRange(name+".window_seconds", *rule.WindowSeconds, 1, 3600); err != nil {
			return err
		}
	}
	if rule.BlockSeconds != nil {
		if err := requireRange(name+".block_seconds", *rule.BlockSeconds, 1, 86400); err != nil {
			return err
		}
	}
	return nil
}

func validateDomainConfig(domains *domainConfigDocument) error {
	if domains == nil {
		return nil
	}
	if err := requireHost("domains.primary", domains.Primary, maxDomainCharacters); err != nil {
		return err
	}
	if err := requireHostList("domains.aliases", domains.Aliases, maxSiteConfigAliases, maxDomainCharacters); err != nil {
		return err
	}
	if err := requireOriginList("domains.cors_origins", domains.CORSOrigins, maxCORSOrigins, maxOriginCharacters); err != nil {
		return err
	}
	// Entries are addresses or CIDRs ("10.0.0.0/8"), not hostnames, so the host check
	// above does not apply: only the count, the length and whitespace are bounded.
	if err := requireTokenList("domains.trusted_proxies", domains.TrustedProxies, maxTrustedProxies, maxProxyCharacters); err != nil {
		return err
	}
	if err := requireHost("domains.cookie_domain", domains.CookieDomain, maxDomainCharacters); err != nil {
		return err
	}
	if tls := domains.TLS; tls != nil {
		if tls.Mode != "" {
			if _, ok := siteConfigTLSModes[tls.Mode]; !ok {
				return fmt.Errorf("%w: domains.tls.mode must be off, letsencrypt or manual", ErrInvalidInput)
			}
		}
		for name, value := range map[string]string{
			"domains.tls.email":     tls.Email,
			"domains.tls.cert_path": tls.CertPath,
			"domains.tls.key_path":  tls.KeyPath,
		} {
			if err := requireRunes(name, value, maxTLSFieldCharacters); err != nil {
				return err
			}
		}
	}
	return nil
}

func validatePerformanceConfig(perf *performanceConfigDocument) error {
	if perf == nil {
		return nil
	}
	bounds := []struct {
		name     string
		value    *int
		min, max int
	}{
		{"performance.feed_limit", perf.FeedLimit, 1, 60},
		{"performance.archive_limit", perf.ArchiveLimit, 1, 60},
		{"performance.cache_ttl", perf.CacheTTL, 1, 120},
		{"performance.static_cache_days", perf.StaticCacheDays, 1, 3650},
		{"performance.keepalive_timeout", perf.KeepaliveTimeout, 1, 3600},
		{"performance.client_max_body_size_mb", perf.ClientMaxBodySizeMB, 1, 2048},
		{"performance.proxy_read_timeout", perf.ProxyReadTimeout, 1, 3600},
		{"performance.api_read_timeout", perf.APIReadTimeout, 1, 600},
		{"performance.api_idle_timeout", perf.APIIdleTimeout, 1, 3600},
		{"performance.db_max_open_conns", perf.DBMaxOpenConns, 0, 512},
		{"performance.db_max_idle_conns", perf.DBMaxIdleConns, 0, 512},
		{"performance.db_conn_max_lifetime", perf.DBConnMaxLifetime, 0, 86400},
	}
	for _, bound := range bounds {
		if bound.value == nil {
			continue
		}
		if err := requireRange(bound.name, *bound.value, bound.min, bound.max); err != nil {
			return err
		}
	}
	return requireOriginList("performance.preconnect", perf.Preconnect, maxPreconnectOrigins, maxOriginCharacters)
}

func validateLoadingConfig(loading *loadingConfigDocument) error {
	if loading == nil {
		return nil
	}
	if loading.Preset != "" {
		if _, ok := siteConfigPresets[loading.Preset]; !ok {
			return fmt.Errorf("%w: loading.preset is not a known preset", ErrInvalidInput)
		}
	}
	if err := requireRunes("loading.text", loading.Text, maxLoadingTextRunes); err != nil {
		return err
	}
	for name, value := range map[string]string{
		"loading.accent":     loading.Accent,
		"loading.background": loading.Background,
	} {
		if err := requireRunes(name, value, maxLoadingColorRunes); err != nil {
			return err
		}
	}
	for name, mode := range map[string]string{
		"loading.accent_mode":     loading.AccentMode,
		"loading.background_mode": loading.BackgroundMode,
	} {
		if mode != "" && mode != "theme" && mode != "custom" {
			return fmt.Errorf("%w: %s must be theme or custom", ErrInvalidInput, name)
		}
	}
	if loading.Size != nil {
		if err := requireRange("loading.size", *loading.Size, 8, 320); err != nil {
			return err
		}
	}
	if loading.MinDurationMS != nil {
		if err := requireRange("loading.min_duration_ms", *loading.MinDurationMS, 0, 3000); err != nil {
			return err
		}
	}
	if loading.CustomCSS != nil {
		// The loading screen stylesheet reaches a <style> element, so it gets the same
		// construct check as the design document's custom_css.
		if err := requireRunes("loading.custom_css", *loading.CustomCSS, maxCustomCSSCharacters); err != nil {
			return err
		}
		if marker := highRiskCSSMarker(*loading.CustomCSS); marker != "" {
			return fmt.Errorf("%w: loading.custom_css contains forbidden construct %q", ErrInvalidInput, marker)
		}
	}
	return nil
}

func validateAuthConfig(auth map[string]authConfigDocument) error {
	if len(auth) > maxAuthProviders {
		return fmt.Errorf("%w: auth exceeds %d providers", ErrInvalidInput, maxAuthProviders)
	}
	for id, provider := range auth {
		if id == "" || len([]rune(id)) > 32 {
			return fmt.Errorf("%w: auth provider id is invalid", ErrInvalidInput)
		}
		for name, value := range map[string]string{
			"auth." + id + ".client_id":    provider.ClientID,
			"auth." + id + ".redirect_uri": provider.RedirectURI,
			"auth." + id + ".extra":        provider.Extra,
			"auth." + id + ".note":         provider.Note,
		} {
			if err := requireRunes(name, value, maxAuthFieldCharacters); err != nil {
				return err
			}
		}
	}
	return nil
}

// publicPerformanceConfig is the part of the performance section a visitor's browser
// actually executes. The gateway, API and database tuning values are deploy-time intent:
// they are generated into a copy-paste snippet and never change what a browser does, so
// they stay out of the anonymous payload.
type publicPerformanceConfig struct {
	FeedLimit         *int     `json:"feed_limit,omitempty"`
	ArchiveLimit      *int     `json:"archive_limit,omitempty"`
	RequestCache      *bool    `json:"request_cache,omitempty"`
	CacheTTL          *int     `json:"cache_ttl,omitempty"`
	LazyMedia         *bool    `json:"lazy_media,omitempty"`
	DisableAnimations *bool    `json:"disable_animations,omitempty"`
	Preconnect        []string `json:"preconnect,omitempty"`
}

// publicDomainConfig is the part of the domain section the visitor guard needs.
//
// TLS paths, CORS origins, trusted proxies and the cookie domain describe how the
// deployment is wired; they are administration data, not browsing data, and they stay
// out of the anonymous payload.
type publicDomainConfig struct {
	Enabled        *bool    `json:"enabled,omitempty"`
	Primary        string   `json:"primary,omitempty"`
	Aliases        []string `json:"aliases,omitempty"`
	AllowWWW       *bool    `json:"allow_www,omitempty"`
	AllowLocalhost *bool    `json:"allow_localhost,omitempty"`
	AllowIP        *bool    `json:"allow_ip,omitempty"`
}

// publicAuthConfig is the part of the login provider settings the login page needs.
//
// Only the switch is public: a visitor's login page has to know whether Google or
// WeChat is on, otherwise the setting stays invisible outside the owner's browser.
// Client ids, redirect URIs and notes are administration data and stay out.
type publicAuthConfig struct {
	Enabled *bool `json:"enabled,omitempty"`
}

// publicSiteConfig is the anonymous projection every visitor downloads.
//
// The `step_up` section is absent by construction: it holds the hash of the site's
// dedicated security password and an administrator-only switch, so it is neither in
// this allow-list nor in siteConfigDocument. Administrators read a masked copy from
// SanitizeSiteConfigForAdmin instead.
type publicSiteConfig struct {
	AdminPath   string                      `json:"admin_path,omitempty"`
	Access      *accessConfigDocument       `json:"access,omitempty"`
	Domains     *publicDomainConfig         `json:"domains,omitempty"`
	Performance *publicPerformanceConfig    `json:"performance,omitempty"`
	Loading     *loadingConfigDocument      `json:"loading,omitempty"`
	Auth        map[string]publicAuthConfig `json:"auth,omitempty"`
}

// publicSiteConfigDocument builds the visitor projection from the stored document.
//
// The split is the point of the feature being server side at all: the browser needs the
// access thresholds, the loading screen and the admin entry, and it must never receive
// the certificate paths, trusted proxies or OAuth client ids. Unknown sections are
// dropped here, which also makes this the allow-list that keeps a future field from
// leaking by accident.
func publicSiteConfigDocument(document []byte) ([]byte, error) {
	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 {
		return []byte("{}"), nil
	}
	var doc siteConfigDocument
	if err := json.Unmarshal(trimmed, &doc); err != nil {
		return nil, fmt.Errorf("%w: stored configuration is not a JSON object", ErrInvalidInput)
	}

	public := publicSiteConfig{
		AdminPath: doc.AdminPath,
		Access:    doc.Access,
		Loading:   doc.Loading,
	}
	if len(doc.Auth) > 0 {
		public.Auth = make(map[string]publicAuthConfig, len(doc.Auth))
		for id, provider := range doc.Auth {
			public.Auth[id] = publicAuthConfig{Enabled: provider.Enabled}
		}
	}
	if domains := doc.Domains; domains != nil {
		public.Domains = &publicDomainConfig{
			Enabled:        domains.Enabled,
			Primary:        domains.Primary,
			Aliases:        domains.Aliases,
			AllowWWW:       domains.AllowWWW,
			AllowLocalhost: domains.AllowLocalhost,
			AllowIP:        domains.AllowIP,
		}
	}
	if perf := doc.Performance; perf != nil {
		public.Performance = &publicPerformanceConfig{
			FeedLimit:         perf.FeedLimit,
			ArchiveLimit:      perf.ArchiveLimit,
			RequestCache:      perf.RequestCache,
			CacheTTL:          perf.CacheTTL,
			LazyMedia:         perf.LazyMedia,
			DisableAnimations: perf.DisableAnimations,
			Preconnect:        perf.Preconnect,
		}
	}
	return json.Marshal(public)
}

// PublicSiteConfig is the exported view of publicSiteConfigDocument for the handler and
// its tests.
func PublicSiteConfig(document []byte) ([]byte, error) {
	return publicSiteConfigDocument(document)
}

// configFieldError turns a json type error into a short field description.
//
// "json: cannot unmarshal string into Go struct field siteConfigDocument.access of type
// int" is useful in a log and noise in an API message; the client reads which field is
// wrong, not the Go type behind it.
func configFieldError(err error) string {
	message := err.Error()
	if index := strings.LastIndex(message, "field siteConfigDocument."); index >= 0 {
		message = message[index+len("field siteConfigDocument."):]
	}
	if index := strings.Index(message, " of type "); index >= 0 {
		message = message[:index]
	}
	message = strings.TrimSpace(message)
	if message == "" || len(message) > 160 {
		return "a field has the wrong type"
	}
	return fmt.Sprintf("%s has the wrong type", message)
}

func requireRange(name string, value, min, max int) error {
	if value < min || value > max {
		return fmt.Errorf("%w: %s must be between %d and %d", ErrInvalidInput, name, min, max)
	}
	return nil
}

func requireRunes(name, value string, max int) error {
	if len([]rune(value)) > max {
		return fmt.Errorf("%w: %s exceeds %d characters", ErrInvalidInput, name, max)
	}
	return nil
}

func requireHost(name, value string, max int) error {
	if value == "" {
		return nil
	}
	if len([]rune(value)) > max {
		return fmt.Errorf("%w: %s exceeds %d characters", ErrInvalidInput, name, max)
	}
	if strings.Contains(value, "://") || strings.ContainsAny(value, " \t\r\n/?#") {
		return fmt.Errorf("%w: %s must be a hostname", ErrInvalidInput, name)
	}
	return nil
}

func requireHostList(name string, values []string, count, max int) error {
	if len(values) > count {
		return fmt.Errorf("%w: %s exceeds %d entries", ErrInvalidInput, name, count)
	}
	for _, value := range values {
		if err := requireHost(name, value, max); err != nil {
			return err
		}
	}
	return nil
}

// requireTokenList bounds free-form entries such as addresses and CIDRs.
func requireTokenList(name string, values []string, count, max int) error {
	if len(values) > count {
		return fmt.Errorf("%w: %s exceeds %d entries", ErrInvalidInput, name, count)
	}
	for _, value := range values {
		if len([]rune(value)) > max {
			return fmt.Errorf("%w: %s exceeds %d characters", ErrInvalidInput, name, max)
		}
		if strings.ContainsAny(value, " \t\r\n") {
			return fmt.Errorf("%w: %s must not contain whitespace", ErrInvalidInput, name)
		}
	}
	return nil
}

func requireOriginList(name string, values []string, count, max int) error {
	if len(values) > count {
		return fmt.Errorf("%w: %s exceeds %d entries", ErrInvalidInput, name, count)
	}
	for _, value := range values {
		if len([]rune(value)) > max {
			return fmt.Errorf("%w: %s exceeds %d characters", ErrInvalidInput, name, max)
		}
		// A bare "*" is the one value the deployment CORS policy refuses to combine
		// with credentials, and SiteCORS always answers with credentials. Accepting
		// it here would let a site administrator re-open exactly the configuration
		// the operator cannot set in the environment. Subdomain patterns such as
		// "https://*.example.com" stay valid: they echo one matched origin.
		if strings.TrimSpace(value) == "*" {
			return fmt.Errorf("%w: %s must list explicit origins, not *", ErrInvalidInput, name)
		}
	}
	return nil
}
