# Authentication & Authorization Audit — Practacu Press API (Go)

**Auditor:** auth-audit (Team Lead coordination)
**Date:** 2026-10-31
**Method:** static source review only. The shell in this environment is broken (`pwsh` exits `0xC0000142`, PTY sessions fail), so **no build, test, `go vet`, linter or runtime probe was executed**. Every claim below is anchored to a quoted source line; anything that needs a live measurement is listed under *Needs runtime confirmation* instead of being asserted.

**Scope reviewed (all files read in full):**

- `apps/api/internal/auth/{tokens,service,handler,password,password_reset,validation,domain,repository}.go`
- `apps/api/internal/infrastructure/authstore/store.go`
- `apps/api/internal/transport/http/gin/{router,dependencies}.go`
- `apps/api/internal/transport/http/gin/middleware/{auth,site,cors,rate_limit,trusted_proxies,recovery,error,context,request_id,problem}.go`
- `apps/api/internal/site/{domain,service,handler,status,address,domain_validation,member_validation}.go`, `apps/api/internal/site/repository.go`
- `apps/api/internal/infrastructure/sitestore/store.go`
- `apps/api/internal/transport/ws/{handler,hub}.go` (owns `POST /auth/ws-ticket`)
- `apps/api/cmd/server/{main,bootstrap}.go`, `apps/api/cmd/seed/main.go`, `apps/api/internal/platform/config/config.go`, `apps/api/internal/platform/errors/problem.go`
- Cross-checked call sites (router → handler → service → store) in `content`, `community`, `taxonomy`, `analytics`, `messaging`, `notifications` where they decide tenant scope.

---

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 1 | AUTH-1 |
| Medium | 5 | AUTH-2 … AUTH-6 |
| Low | 5 | AUTH-7 … AUTH-11 |

No unauthenticated remote-compromise or authentication-bypass defect was found: JWT verification is correctly pinned (EdDSA only, `kid` pinned, `iss` enforced), refresh rotation uses a conditional (compare-and-set) update, and the double-submit CSRF token is compared in constant time. The most serious issue is a **tenant-isolation gap**: site-scoped access tokens are never checked against the site the request host resolves to.

---

## AUTH-1 — High — Site-bound access token is never matched against the host-resolved site (`RequireSiteMatch` is dead code)

**Evidence**

`apps/api/internal/transport/http/gin/router.go:78-81` — the only guard mounted on every service group is plain bearer verification:

```go
		var guard, optionalAuth gin.HandlerFunc
		if deps.AccessTokens != nil {
			guard = middleware.RequireAuth(deps.AccessTokens)
			optionalAuth = middleware.OptionalAuth(deps.AccessTokens)
```

`apps/api/internal/transport/http/gin/middleware/auth.go:64-91` — the cross-site guard exists and documents exactly this threat, but it is used **nowhere outside tests**:

```go
// RequireSiteMatch rejects a principal whose token was issued for another site.
//
// This is the check that stops a token minted on site A from acting on site B when
// the site is selected by hostname.
func RequireSiteMatch() gin.HandlerFunc {
	...
		if principal.SiteID != resolved.ID {
```

Verified by a repository-wide content search for `RequireSiteMatch` and `RequireRole`: the only matches outside their definitions in `middleware/auth.go` are in `middleware/auth_test.go:110,119,129,138,147,155` (tests). `router.go` never references them, and no production call site exists in `apps/api`. `docs/superpowers/plans/2026-10-18-practacu-press-progress.md:59` claims this control is implemented ("跨站令牌拒绝"), which makes the omission a regression against the stated design rather than an intentional choice.

**Why it is exploitable**

The request's site comes from the `Host` header (`middleware/site.go:70-76` → `ResolveSite` → `site.Service.Resolve`), while the caller's site comes from the `sid` claim of the bearer token (`auth/tokens.go:196-200`). Nothing compares them, so a token minted for tenant A is accepted on tenant B's hostname.

The concrete cross-tenant read is `apps/api/internal/site/handler.go:68` and `:188-200`:

```go
	r.GET("/users/:userID", optionalAuth, h.PublicUser)
...
	if _, _, authenticated := h.principal(c); !authenticated && resolved.IsMembersOnly() {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "members_only_site"))
		return
	}

	member, err := h.service.PublicMember(c.Request.Context(), resolved.ID, c.Param("userID"))
```

`PublicUser` treats **any** valid session as satisfying the `members_only` gate and then queries the **resolved** site (`resolved.ID`). Attack chain on a multi-tenant install where site B is `visibility_mode = members_only`:

1. Attacker self-registers on any public site A (`POST /api/v1/auth/register/email`, `auth/handler.go:81`) and receives an access token with `sid = <A>`, `role = member`.
2. Attacker calls `GET https://<B-domain>/api/v1/users/<any-user-id>` with `Authorization: Bearer <A-token>`.
3. `ResolveSite` resolves host → B, `OptionalAuth` attaches the A principal (`middleware/auth.go:53-63`), so the members-only rejection is skipped, and `PublicMember` reads B's membership row.
4. Response discloses `user_id`, `display_name`, `role`, `created_at` for members of B, including which accounts are `platform_admin`/`site_admin` (target selection), and works as a user-id membership oracle for site B.

Note the asymmetry that shows this is a defect and not policy: `taxonomy/handler.go:102-109` and `analytics/service.go:79-82` re-implement the site comparison locally, and `content`/`community` avoid the leak only because they key every query off the token's `actor.SiteID`. `PublicUser` is the one site-scoped handler that mixes "principal from token" with "site from host" without a comparison.

**Minimal fix**

Mount the existing check on every authenticated group, which is what its doc comment prescribes:

```go
guard      = middleware.RequireAuth(deps.AccessTokens)
siteGuard  = ... // chi/gin chain: RequireAuth, then RequireSiteMatch()
```
i.e. in `router.go` build `guard = chain(middleware.RequireAuth(...), middleware.RequireSiteMatch())` before `deps.Auth/Sites/Content/...Routes(...)`, and additionally require membership of the *resolved* site in `site.Handler.PublicUser` (`h.service.Membership(ctx, resolved.ID, principal.UserID)`), not merely "some session exists".

---

## AUTH-2 — Medium — Refresh-token lineage has no absolute lifetime; rotation extends the window forever

**Evidence**

The declared invariant, `apps/api/internal/auth/tokens.go:28-29`:

```go
	// RefreshTTL is the absolute lifetime of one refresh lineage.
	RefreshTTL = 30 * 24 * time.Hour
```

The implementation re-derives `expires_at` from `now` on **every** rotation, `apps/api/internal/auth/service.go:449-459` (`buildSession`, reached from `Refresh` at `service.go:363` with the existing `record.FamilyID`):

```go
	now := s.now()
	record := SessionRecord{
		...
		ExpiresAt: now.Add(s.refreshTTL),
```

`Refresh` (`service.go:320-380`) only checks the *current row* (`record.RevokedAt != nil || record.Expired(now)`, `service.go:342`). There is no family-level deadline to check: `apps/api/ent/schema/session.go:29` stores only `field.Time("expires_at"),` per row, and no `family_created_at`/`family_expires_at` exists anywhere in the schema.

**Why it is exploitable**

`RefreshTTL` therefore behaves as a 30-day **sliding idle timeout**: as long as the holder of a stolen `pp_refresh` cookie refreshes at least once every 30 days, the lineage is extended indefinitely (`now.Add(s.refreshTTL)` each time), and reuse-detection never fires because the attacker keeps rotating the newest token. A token exfiltrated from a backup, a log-adjacent store, or a compromised endpoint becomes a permanent account takeover for as long as the attacker keeps the loop alive — contrary to the stated "absolute lifetime of one refresh lineage" guarantee.

**Minimal fix**

Persist the lineage start (`family_created_at`, or reuse the first row's `created_at`/`expires_at` by walking `family_id` on rotation) and refuse rotation when `now >= familyCreatedAt + RefreshTTL`.

---

## AUTH-3 — Medium — Login has no per-account throttling or lockout; the only control is a per-process, per-IP counter

**Evidence**

`apps/api/internal/transport/http/gin/router.go:46-51` is the single rate-limit mount in the whole API:

```go
	if deps.Config.RateLimitPerMinute > 0 {
		r.Use(middleware.RateLimit(
			middleware.NewMemoryRateLimitStore(nil),
			middleware.Policy{Limit: deps.Config.RateLimitPerMinute, Window: time.Minute},
		))
	}
```

The key is the client IP (`middleware/rate_limit.go:105-108`):

```go
	keyOf := policy.Key
	if keyOf == nil {
		keyOf = func(c *gin.Context) string { return c.ClientIP() }
	}
```

and the store is explicitly single-process (`middleware/rate_limit.go:14-17`):

```go
// It is an interface because the in memory implementation below is only correct
// for a single process. A multi replica deployment needs a shared store, and that
// swap must not touch the middleware.
```

`auth/service.go:257-313` (`LoginPassword`) contains no failed-attempt counter, backoff, or account lock; a wrong password simply returns (`service.go:290-292`):

```go
	if !matches {
		return Session{}, ErrInvalidCredentials
	}
```

**Why it is exploitable**

The only barrier to online password guessing is `RATE_LIMIT_PER_MINUTE` (default `240`, `config/config.go:190`) **per source IP**. Consequences:

- A distributed/rotating-IP attack (or any client with a large IPv6 /64, where each source address is a fresh key) gets unlimited attempts against `POST /api/v1/auth/login/password`.
- Even a single IP gets 240 attempts/minute — 345,600/day — against an 8-character-minimum password (`auth/validation.go:16-17`), with no per-account lock.
- On a multi-replica deployment the counter is per process, so the effective budget multiplies by replica count (documented above).

**Minimal fix**

Track failures per account (`email` + `site_id`) with exponential backoff or a temporary lock after N failures, and enforce it inside `Service.LoginPassword` (store-side, so it survives restarts and replicas). Keep the IP limiter as a secondary control.

---

## AUTH-4 — Medium — Account enumeration through login: early return before hashing, plus a distinct "disabled" response

**Evidence**

`apps/api/internal/auth/service.go:270-303` — the unknown-email path returns **before** any password hashing, and the disabled-account path returns a distinguishable sentinel:

```go
	identity, err := s.repo.FindEmailIdentity(ctx, email)
	if err != nil {
		if errors.Is(err, ErrAccountNotFound) {
			return Session{}, ErrInvalidCredentials     // no Argon2 / no RPC
		}
		return Session{}, err
	}

	if identity.PasswordHash == "" {
		return Session{}, ErrInvalidCredentials
	}
	...
	matches, err := s.hasher.Verify(ctx, in.Password, identity.PasswordHash)   // ~64 MiB Argon2id or a gRPC round trip
	...
	if user.Status != AccountStatusActive {
		return Session{}, ErrAccountDisabled
	}
```

The two sentinels map to different, machine-readable responses, `apps/api/internal/auth/handler.go:464-468`:

```go
	case errors.Is(err, ErrAccountDisabled):
		return apperr.PermissionDenied().WithDetail("reason", "account_disabled")
	...
	case errors.Is(err, ErrInvalidCredentials), errors.Is(err, ErrAccountNotFound):
		return apperr.Unauthenticated().WithDetail("reason", "invalid_credentials")
```

**Why it is exploitable**

Two oracles against `POST /api/v1/auth/login/password`:

1. **Direct**: an existing-but-disabled account returns `403 permission_denied` with `reason: account_disabled`; an unknown address returns `401 unauthenticated` with `reason: invalid_credentials`. No timing needed — the attacker learns the address is registered.
2. **Timing**: an unknown address returns before `s.hasher.Verify`; a registered address pays one Argon2id evaluation (`auth/password.go:70-78`: 64 MiB, t=3) or a gRPC call to the Rust service in production (`cmd/server/main.go:470-473`). The response-time delta is on the order of tens of milliseconds, which is trivially measurable over repeated requests.

This contradicts the stated intent in `auth/service.go:252-256` ("An unknown account, a wrong password and a missing password credential all return `ErrInvalidCredentials` with identical shape, so the endpoint cannot be used to enumerate accounts") and the whole reset-flow design (`password_reset.go:77-126`), which goes to considerable lengths to avoid the same oracle.

**Minimal fix**

- Return the same `invalid_credentials` problem for a disabled account, or gate the disabled state behind a successful password check.
- On the unknown-account branch, still perform one dummy hash verification (a fixed placeholder PHC string) so both branches pay the same cost before responding.

---

## AUTH-5 — Medium — The in-memory rate-limit store does not enforce its memory bound (and eviction is O(n) under the global mutex)

**Evidence**

`apps/api/internal/transport/http/gin/middleware/rate_limit.go:24-26` promises a hard cap:

```go
// defaultRateLimitEntries bounds the in memory store so a key flood cannot exhaust
// memory. Expired windows are evicted first when the bound is reached.
const defaultRateLimitEntries = 50000
```

`Allow` only evicts **expired** windows and then inserts unconditionally (`rate_limit.go:68-75`):

```go
	current, ok := s.windows[key]
	if !ok || !now.Before(current.resetAt) {
		if !ok && len(s.windows) >= s.maxEntries {
			s.evictExpiredLocked(now)
		}
		s.windows[key] = &fixedWindow{count: 1, resetAt: now.Add(window)}
		return true, 0
	}
```

`evictExpiredLocked` deletes nothing when every entry is still inside its one-minute window (`rate_limit.go:85-91`):

```go
func (s *MemoryRateLimitStore) evictExpiredLocked(now time.Time) {
	for key, window := range s.windows {
		if !now.Before(window.resetAt) {
			delete(s.windows, key)
		}
	}
}
```

**Why it is exploitable**

The key is the client IP (`rate_limit.go:107`). A client that can source requests from many addresses — any IPv6-capable host has a /64 (or larger) available; a deployment behind a trusted proxy keys on the forwarded client IP — can create unbounded distinct keys *within one window*:

- `len(s.windows) >= 50000` with zero expired entries → the sweep deletes nothing → the map keeps growing without limit, so the advertised bound never applies (memory exhaustion; the comment's guarantee is false).
- Each new key at/over the bound triggers a full scan of ≥50 000 map entries while holding `s.mu`, which serialises every request in the process — an O(n)-per-request CPU/latency amplification.
- The same address multiplicity also defeats the rate limit itself: 240/min is per key, so throughput scales with the number of source addresses.

**Minimal fix**

Replace "evict if possible" with a hard bound: when `len(windows) >= maxEntries` and nothing is expired, reject the new key (fail closed) or evict by earliest `resetAt` (a cheap ring/heap instead of a full scan). Consider a sharded clock-cached map so the lock is not held during the sweep.

---

## AUTH-6 — Medium — Any site administrator can claim an arbitrary unclaimed hostname and it is stored as "verified" with no ownership proof

**Evidence**

`apps/api/internal/site/handler.go:77` exposes the operation to every site admin:

```go
	group.PUT("/:siteID/domain", h.UpdateDomain)
```

`apps/api/internal/site/service.go:503-516, 537-538` — the domain is written with `domain_verified_at = now` purely because an administrator sent it:

```go
// A non-empty domain is treated as operator declared ownership: it is stored together
// with domain_verified_at = now, because an unverified domain would fail
// ValidateForServing and take the site offline.
...
		verifiedAt := s.now()
		in.VerifiedAt = &verifiedAt
```

The same path exists through the general settings endpoint (`site/service.go:474-487`, `normalized.DomainVerifiedAt = &verifiedAt`). `ent/schema/site.go:35` defines `domain_verification_token`, but a search of `apps/api/internal` for `DomainVerification`/`domain_verification` returns **no** writer for it: no DNS/TXT/file challenge flow is implemented anywhere. The only guard is uniqueness against domains already taken by another site (`site/service.go:528-536`).

Because host-based tenant selection trusts exactly this field (`site/domain.go:102-116`: `if s.DomainVerifiedAt == nil { return ErrDomainUnverified }`), the verification flag is self-asserted.

**Why it is exploitable**

On a multi-tenant install, a tenant administrator (any `site_admin`, not just a platform administrator — `UpdateDomain` only requires `ActionManageSite`, `site/service.go:514`) can claim a hostname that no site has registered yet, e.g. a customer domain whose DNS already points at the platform, or a hostname the operator plans to use. After the claim, `ResolveSite` serves *their* site — content, members, cookies — under that hostname, and the legitimate owner cannot register it afterwards (`ErrDomainTaken`, `site/service.go:531`). Preconditions: at least one other site exists (desktop single-site installs are not affected), and the target hostname is still unclaimed.

**Minimal fix**

Implement the verification challenge that the schema already anticipates: on `PUT /sites/{id}/domain`, store `domain_verification_token` and leave `domain_verified_at` NULL; only set it after a TXT-record/file fetch proves control (or restrict the endpoint to `RolePlatformAdmin` and treat it as an operator-only action, documented as such).

---

## AUTH-7 — Low — `POST /auth/logout` has no CSRF protection (cross-site forced logout)

**Evidence**

`apps/api/internal/auth/handler.go:357-368`:

```go
// Logout revokes the session and clears the cookies.
func (h *Handler) Logout(c *gin.Context) {
	token, _ := c.Cookie(RefreshCookieName)

	if err := h.service.Logout(c.Request.Context(), token); err != nil {
```

Compare the refresh endpoint, which does check the double-submit token (`handler.go:338-345`). Logout is mounted unauthenticated (`handler.go:84`: `group.POST("/logout", h.Logout)`), so the only credential required is the refresh cookie — which is sent automatically cross-site because it is issued with `SameSite=None` whenever cookies are `Secure` (`handler.go:410-418`).

**Why it is exploitable**

A malicious page can `POST` (form/fetch no-cors) to `https://<site>/api/v1/auth/logout`; the browser attaches `pp_refresh`, the server revokes the session and clears the cookies, logging the victim out repeatedly (nuisance/availability, not confidentiality). Impact is limited: no state is disclosed and the attacker learns nothing.

**Minimal fix**

Apply the same CSRF double-submit check as `Refresh` (cookie `pp_csrf` must equal `X-CSRF-Token`) before revoking, or require a valid access token for logout.

---

## AUTH-8 — Low — Registration discloses whether an email is already registered

**Evidence**

`apps/api/internal/auth/handler.go:456-459`:

```go
	case errors.Is(err, ErrIdentityExists):
		return apperr.Conflict(apperr.CodeConflict).
			WithDetail("reason", "identity_exists").
			WithMessage("\u8be5\u90ae\u7bb1\u5df2\u88ab\u6ce8\u518c")
```

The uniqueness check behind it is install-global, not site-scoped (`infrastructure/authstore/store.go:58-64`), so the answer is authoritative for every site on the install.

**Why it is exploitable**

`POST /api/v1/auth/register/email` with an arbitrary address returns `409` for a registered address and `201` (plus a session) for an unknown one — an enumeration oracle that the login and password-reset flows deliberately avoid. Exploitable by any unauthenticated caller, but the response is inherent to most registration UX; the practical impact is confirming membership of an address on the install.

**Minimal fix**

If enumeration resistance is a product requirement, always answer `202 accepted` and deliver an "address already in use — use password reset" email instead of returning `409`. Otherwise document the tradeoff explicitly and keep the per-IP rate limit in front of it.

---

## AUTH-9 — Low — Admin email change does not clear the identity's verification timestamp

**Evidence**

`apps/api/internal/infrastructure/sitestore/store.go:287-292` rewrites the login identity without touching `verified_at`:

```go
		if _, err := tx.UserIdentity.UpdateOneID(identity.ID).
			SetProviderSubject(*in.Email).
			SetEmail(*in.Email).
			Save(ctx); err != nil {
			return err
		}
```

Contrast with the correct (NULL-guarded) behaviour used by the password-reset path, `infrastructure/authstore/store.go:153-160`:

```go
	if verifiedAt == nil {
		return nil
	}
	_, err = s.client.UserIdentity.Update().
		Where(useridentity.IDEQ(identityID), useridentity.VerifiedAtIsNil()).
		SetVerifiedAt(*verifiedAt).
		Save(ctx)
```

**Why it is exploitable**

When `RequireEmailVerification` is enabled (the `auth.ServiceConfig` flag exists and is honoured at `auth/service.go:282-284`), an administrator changing a member's address to one they do not control leaves `verified_at` set, so the new address is treated as proven. Only reachable by a `platform_admin` for a lower-ranked member (`site/service.go:414-433`), hence Low; it silently defeats the address-proof invariant the rest of the code is careful about.

**Minimal fix**

In the same transaction, clear the verification timestamp whenever `provider_subject` changes (`SetVerifiedAt(*time.Time(nil))` / `ClearVerifiedAt()`).

---

## AUTH-10 — Low — `PATCH /sites/{id}/settings` writes an unvalidated duplicate domain and returns 500 instead of 409

**Evidence**

The settings path normalises and stores the domain without the ownership check that `UpdateDomain` performs (`site/service.go:474-487`):

```go
	if in.Domain != "" {
		domain, domainErr := normalizeDomain(in.Domain)
		if domainErr != nil {
			return domainErr
		}
		normalized.Domain = domain
		if domain != "" {
			verifiedAt := s.now()
			normalized.DomainVerifiedAt = &verifiedAt
		}
	}
```

versus `site/service.go:528-536`, which does check:

```go
		existing, findErr := s.repo.FindByDomain(ctx, normalized)
		switch {
		case findErr == nil && existing.ID != siteID:
			return ErrDomainTaken
```

`ent/schema/site.go:56` declares `index.Fields("domain").Unique()`.

**Why it is exploitable**

Not an authorization bypass, but a missing check that turns a client mistake into an unhandled constraint violation: `PATCH /api/v1/sites/{id}/settings` with a domain already owned by another site reaches the database and surfaces as `apperr.Internal` (500) through `site/handler.go:470-474`, instead of the intended `409 domain_taken`. Combined with AUTH-6 it also lets a tenant move another tenant's domain into contention without the friendlier error path.

**Minimal fix**

Reuse the `FindByDomain` check (or a single `setDomain` service helper) for both endpoints, and translate a unique-constraint error into `ErrDomainTaken`.

---

## AUTH-11 — Low — Password-reset link origin is derived from the attacker-controllable `Host` header

**Evidence**

`apps/api/internal/auth/handler.go:273-287`:

```go
// Only the Host header is trusted, never Origin or Referer: a reset link must never
// be pointed at an attacker supplied host.
func requestOrigin(c *gin.Context, secure bool) string {
	host := c.Request.Host
```

and `auth/password_reset.go:242-247` uses it when `PUBLIC_BASE_URL` is unset:

```go
func (s *Service) resetOrigin(requestOrigin string) string {
	if s.publicBaseURL != "" {
		return s.publicBaseURL
	}
	return requestOrigin
}
```

**Why it is exploitable (conditional)**

`Host` is client-controlled; the origin is then embedded in the mailed link. Whether an arbitrary `Host` reaches the handler depends on site resolution:

- If the site has a verified `domain`, `site/domain.go:109-111` rejects any other host, so the header cannot be forged to an attacker domain.
- In the single-site, **domain-less** fallback (`site/service.go:118-134`), `ResolveSite` accepts *any* hostname when `requirePublicAddress` is off — which is the default outside production (`cmd/server/main.go:119`: `site.RequirePublicAddress(cfg.AppEnv == config.EnvProduction && !cfg.DesktopMode)`). There, `POST /api/v1/auth/password-reset/request` with `Host: attacker.example` mails the victim a link on the attacker's host; when the victim clicks it, the reset token appears in the attacker's logs (`resetLink`, `password_reset.go:250-255`, puts the token in the query string) — full account takeover.

That combination (mail configured, domain-less site, non-production environment, victim clicks) is a legitimate but narrow precondition set, so this is Low with a defence-in-depth fix. It is also the only place where the request origin is trusted, which makes it easy to harden.

**Minimal fix**

Prefer `PUBLIC_BASE_URL`; when it is unset, build the link from the site's verified `Domain` (and `COOKIE_SECURE`/TLS state) rather than from the request `Host`, and require the resolved site's domain to match `RequestHost(c, trusted)` (`middleware/site.go:70-76`) before generating a link.

---

## Verified safe (checked, and found correct — absence of a finding above is meaningful)

**Access-token validation** — `auth/tokens.go:177-205`: algorithm pinned to `EdDSA` (`tokens.go:40`, `jwt.WithValidMethods`), `kid` must equal the issuer's key id (`tokens.go:186-189`), issuer enforced (`jwt.WithIssuer`), 30 s leeway, `sub`/`sid`/`role` re-validated and unknown roles rejected (`tokens.go:201-203`). No `alg: none` or HMAC confusion path exists; the public key is the only key ever returned.
**Refresh rotation and replay** — `authstore/store.go:278-291` conditions the rotation update on `rotated_at IS NULL AND revoked_at IS NULL` inside a transaction that also inserts the successor, so two concurrent refreshes cannot both win; reuse of a rotated token revokes the whole family (`auth/service.go:335-340`, `authstore/store.go:321-328`). Refresh is bound to the site resolved from the request host (`auth/service.go:346-350`), so a cookie minted on A cannot be rotated on B.
**Session issuance** — role is read from the live membership row on every issuance (`service.go:418-424` → `authstore/store.go:176-191`, active membership only), so a suspended/removed member cannot obtain a new session; `RegisterEmail` hashes before opening the transaction and never lets a client choose its role (`service.go:139-156`); `CreateMember` enforces same-site, ≥`site_admin`, and "only a platform admin may grant `platform_admin`" (`service.go:203-219`).
**Cookie flags** — `auth/handler.go:404-422`: refresh cookie is `HttpOnly`, `Path=/api/v1/auth`, `Secure` whenever `CookieSecure` (default true in production, `config.go:416-420`); CSRF cookie is intentionally JS-readable and scoped to `/`; `SameSite=None` is only used together with `Secure`.
**CSRF on refresh** — `auth/handler.go:340-345` requires a non-empty `pp_csrf` cookie and `X-CSRF-Token` header that satisfy `TokensEqual`, which is `subtle.ConstantTimeCompare` (`tokens.go:261-263`), and the check runs before any database access.
**Password reset** — 32 random bytes (`password_reset.go:26-28, 128-131`), only the SHA-256 hash persisted (`:144`), 30-minute TTL and single use via a conditional `consumed_at` update (`authstore/store.go:407-416`, `password_reset.go:197-203`), earlier links invalidated on re-request (`password_reset.go:136-139`), every live session revoked after a successful reset (`password_reset.go:225-227`), identical responses for unknown/unverified/undeliverable addresses (`password_reset.go:99-126`), and no token content is logged.
**Cookie/CSRF-independent credential handling** — passwords are never logged or echoed (`clientMeta`, `handler.go:430-435`, records UA and IP only); `ValidatePassword`/`NormalizeEmail` bound input before hashing (`auth/validation.go:29-72`); malformed PHC hashes are treated as a mismatch, not an error (`password.go:117-121`).
**RBAC in the site aggregate** — a single `Can` table (`site/service.go:26-41`), `CanAssignRole` reserving `platform_admin` for platform admins (`:47-55`), demotion of a platform admin requires a platform admin and a surviving active admin (`:248-262`), `manageableTarget` forbidding self-management and platform-admin targets (`:414-433`), and every mutation re-checking `actor.SiteID == siteID` (`:556-564`). The route layer additionally compares the path `siteID` with the token `siteID` before any membership lookup (`site/handler.go:390-407`), and `CreateMember` repeats the comparison in the service (`auth/service.go:203-205`) — no IDOR found on `/sites/{id}/members*`.
**CORS** — exact-origin allowlist, no reflection of unlisted origins, preflights from unlisted origins rejected (`middleware/cors.go:31-73`), and `CORS_ALLOW_CREDENTIALS` + `*` is rejected at startup (`config/config.go:273-282`).
**Trusted proxies / host selection** — empty `TRUSTED_PROXIES` disables `X-Forwarded-*` entirely (`router.go:134-140`, `middleware/site.go:70-76`), CIDR parsing rejects garbage at startup (`trusted_proxies.go:19-45`), and `ResolveSite` never falls back to a default site on an unknown host (`site/service.go:101-137`).
**Error handling / information leaks** — the API never serialises an internal cause (`platform/errors/problem.go:108-117`), panics are logged with a stack and answered as an opaque 500 (`middleware/recovery.go:32-49`), and inbound `X-Request-ID` is sanitised and length-bounded (`middleware/request_id.go:33-47`).
**WebSocket ticket** — `POST /auth/ws-ticket` is behind `requireAuth` (`ws/handler.go:47`), the ticket is 32 random bytes, stored hashed, 60 s TTL, deleted before the expiry check so every path is single use (`ws/hub.go:63-106`), and events are filtered by site and audience on publish (`ws/hub.go:174-195`).
**Bootstrap paths** — `cmd/seed` creates only a site (no account, no credential); desktop auto-promotion requires `PP_DESKTOP`, which config refuses to combine with `APP_ENV=production` (`config.go:406-415`), and only promotes the earliest active member when the site has no administrator at all (`cmd/server/bootstrap.go:76-109`).
**Desktop-only elevation races** — the "first account becomes `platform_admin`" check is not transactional (`auth/service.go:145-156`, acknowledged in its comment); it is reachable only with `PP_DESKTOP=1` outside production, so it is not exploitable in a server deployment.

---

## Needs runtime confirmation (suspected, not asserted)

1. **Magnitude of the AUTH-4 timing delta.** The code path difference is certain, but the per-request delta depends on the active hasher: local Argon2id (`auth/password.go:70-78`, 64 MiB × 3) versus a gRPC round trip to the Rust service (`cmd/server/main.go:469-483`). It should be measured before choosing mitigation.
2. **Whether any deployment actually runs more than one site** (relevant to the impact of AUTH-1, AUTH-6 and AUTH-8). `site.Service.Resolve` supports multi-tenant host resolution (`site/service.go:101-137`) and the schema enforces per-site uniqueness, but the only site-creation code shipped is the seed and the desktop bootstrap (`cmd/seed/main.go:62-68`, `cmd/server/bootstrap.go:57-66`) — no HTTP route creates a site. If operators cannot create a second site through the API, AUTH-1's cross-tenant read and AUTH-6's domain claim are only reachable on installs provisioned out-of-band.
3. **Behaviour of `RotateSession` under SQLite's single-writer lock** (`authstore/store.go:266-318`): the conditional update is correct for MySQL/Postgres; on SQLite a concurrent writer makes the transaction fail rather than return `updated == 0`, which would surface as a 500 on a benign double refresh instead of `ErrSessionRevoked`. Functional, not a vulnerability.
4. **`Refresh` clears cookies on every error** (`handler.go:347-352`): a legitimate client whose refresh races with itself is logged out. Availability/UX only, verified by reading, not by execution.

## Hardening notes (informational, below Low)

- **`RequireRole` is also unused** (`middleware/auth.go:94-111`): role gates currently live only inside services. That is consistent today (every service checks), but the middleware's existence implies a route-level guarantee that is not in force; either wire it or delete it to prevent a future route from relying on it.
- **No `aud` claim and no required `exp`/`iat` validation** (`auth/tokens.go:154-163, 179-183`): `jwt.WithAudience`/`WithExpirationRequired`/`WithIssuedAt` are not set. Not exploitable without the signing key (the signature is pinned), but a token minted by this issuer is valid at any relying party that shares the key, and a future key-handling mistake would not be contained by an audience.
- **WebSocket accepts any `Origin` when `CORS_ALLOWED_ORIGINS` is empty** (`ws/handler.go:83`: `InsecureSkipVerify: len(h.origins) == 0`). Not exploitable as cross-site WebSocket hijacking today because the socket is authorised by a single-use ticket, not by a cookie; it becomes exploitable the moment cookie-based upgrade auth is added.
- **Password policy is length-only** (8–128 characters, `auth/validation.go:16-22`): no breach-list or composition check, which matters more given AUTH-3.
- **No re-authentication for sensitive account operations**: `PATCH /sites/{id}/members/{userID}` (profile/email) and role changes accept any valid access token regardless of age (`site/handler.go:73-76`), and the 15-minute access token is not revocable (`tokens.go:25-27`), so a removed member keeps nominal access for up to 15 minutes (session revocation on removal at `sitestore/store.go:381-391` only stops the next refresh).
