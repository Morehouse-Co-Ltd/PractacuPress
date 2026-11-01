# Security service audit — Rust sanitizer, Argon2 and the Go↔Rust contract

**Scope:** `services/security/**` (content.rs, password.rs, transport/grpc.rs, main.rs, lib.rs, build.rs, Cargo.toml), `packages/contracts/security/v1/security.proto`, and the Go consumer `apps/api/internal/infrastructure/securityclient/**` plus the call sites that interpret its answers (`apps/api/internal/content/service.go`, `apps/api/internal/media/service.go`, `apps/api/cmd/server/main.go`).

**Method and limits — read this first.** The shell in this environment is broken (`pwsh` exits `0xC0000142`, PTY sessions fail), so **nothing in this report was executed**: no `cargo build`, no `cargo test`, no `go test`, no request was sent to the service. Every statement below is derived from reading source and, where crate behaviour mattered, from reading the exact pinned crate source (ammonia **4.2.4**, html5ever **0.40.1**, argon2 **0.5.3** — per `services/security/Cargo.lock`). Claims that need execution to settle are quarantined in §4 and never presented as findings. `services/security/target/**` was not touched.

**Severity counts:** Critical **0** · High **1** · Medium **5** · Low **6** (12 total).

**Headline:** I could not construct a sanitizer bypass. The allow-list in `content.rs` is genuinely tight and ammonia 4.2.4 closes the classic mXSS/namespace-confusion class; the per-vector trace is in §3 so the negative result is auditable rather than asserted. The real weaknesses are around the sanitizer: (a) unbounded, un-offloaded Argon2 work that any unauthenticated login request can drive, (b) an audit trail ("violations") that is a 7-substring keyword scan over the raw source and is then thrown away by Go, (c) a `policy_version` that is recorded but never verified by anyone, and (d) a `markdown` format that is not markdown at all.

---

## 1. Findings

### SEC-1 — Argon2 runs as blocking CPU work on the async runtime, uncapped: one login burst takes the whole service down
**Severity: High** · `services/security/src/transport/grpc.rs:46`, `services/security/src/password.rs:51`, `services/security/src/main.rs:14-17`, `apps/api/internal/infrastructure/securityclient/grpc.go:20`

Evidence:

- `password.rs:51` — `Self { memory_kib: 64 * 1024, iterations: 3, parallelism: 2 }` (64 MiB per hash).
- `grpc.rs:41-47` — `async fn hash_password(...)` calls `password::hash_password(plain, password::Params2::default())` **directly inside the async fn**. Same shape at `grpc.rs:55-60` for `verify_password`.
- `main.rs:14-17` — `tonic::transport::Server::builder().add_service(...).serve(socket)`: no `max_decoding_message_size`, no `timeout`, no `concurrency_limit_per_connection`, no layer at all.
- `grpc.go:20` — the only bound is a client-side `DefaultTimeout = 3 * time.Second` on the Go side; nothing bounds the server.
- `apps/api/internal/transport/http/gin/router.go:46-51` — the API rate-limits per client at `RateLimitPerMinute` (default 240) in a **fixed one-minute window**, so a single client may legitimately issue ~240 requests in the first second.

Failure mode (all static facts, no guessing):

1. **Runtime starvation.** Argon2 is CPU-bound and synchronous. `tokio::main` with `rt-multi-thread` gives roughly one worker per core; each in-flight hash occupies a worker for the full 64 MiB × 3-pass computation. A handful of concurrent `HashPassword`/`VerifyPassword` calls therefore occupy every worker thread, and *every other RPC* — including `SanitizeContent` — queues behind them. The `3s` client timeout does not help: the in-flight future cannot be cancelled mid-hash, and the server keeps the worker busy after the caller has given up.
2. **Memory amplification.** Every in-flight call allocates its own 64 MiB block vector (`argon2` `hash_password_into` → `vec![Block::default(); self.params.block_count()]`). With tonic advertising no concurrency limit, a 240-request burst ≈ 15 GiB of transient allocations.
3. Both operations are reachable **unauthenticated**: `HashPassword` and `VerifyPassword` are called from registration and login, which need no credentials.

Blast radius is cross-tenant and systemic: when this process dies or stalls, sanitization fails, so publishing is held (`content/service.go:461-468`, fail-closed) and logins fail (`fail-closed`), for every site.

Minimal fix: move both calls to `tokio::task::spawn_blocking` and bound them, e.g. a `tower::limit::ConcurrencyLimitLayer` + `tower::timeout::TimeoutLayer` on the server, plus `Server::builder().max_decoding_message_size(...)`. A semaphore sized to `num_cpus` (not unbounded) in front of `password::*` is the smallest change that removes the starvation.

---

### SEC-2 — "Violations" is a 7-substring scan over the raw source, not a record of what was removed — and Go discards it
**Severity: Medium** · `services/security/src/content.rs:112-128`, `services/security/src/content.rs:85`, `apps/api/internal/content/service.go:470-471`, `apps/api/cmd/server/main.go:460`

Evidence (`content.rs:114-122`):

```rust
let markers = [
    ("<script", "script"), ("<iframe", "iframe"), ("<object", "object"),
    ("<embed", "embed"), ("onerror=", "onerror"), ("onload=", "onload"),
    ("javascript:", "javascript_url"),
];
```

The result is advertised as "Constructs that were removed, for the audit trail" (`content.rs:15-16`) and the module doc says it records "which dangerous constructs were present" (`content.rs:110-111`). It does not: it is a literal substring test on the *input string* (`content.rs:85` passes `&html`, the pre-sanitization text), compared against seven lowercase markers.

**False negatives** (a stored-XSS attempt that ammonia *does* neutralise is recorded as "no violations"):

| Malicious input | What ammonia does | Reported |
|---|---|---|
| `<img src=x onerror =alert(1)>` (space before `=`) | `onerror` dropped | `[]` |
| `<img src=x onfocus=alert(1) autofocus>` | attribute dropped | `[]` |
| `<a href="&#106;avascript:alert(1)">x</a>` | entity decoded to `javascript:`, `href` dropped | `[]` |
| `<iframe srcdoc="<script>…">` | `<iframe` marker matches → this one *is* reported | `["iframe"]` |
| `<style>@import url(//evil)</style>` | element **and content** removed (`clean_content_tags` = script,style) | `[]` |
| `<form action=//evil><input></form>`, `<meta http-equiv=refresh>`, `<base href=//evil>`, `<svg onload=…>` | dropped | `[]` (or only `onload` for the last) |

**False positives:** the markers are matched in text nodes, so an article *about* security that contains the literal string `javascript:` inside `<code>` is flagged as an XSS attempt while its HTML is unchanged.

**Also:** for `format == "plain"` the scanned string is the already-escaped HTML (`content.rs:72-74`), so `<script>` in plain text can never be reported even though the source contained it.

**And the field is dead end-to-end:** `violations` is carried into `content.Sanitized` (`service.go:17`), assigned in the adapter (`main.go:460`) — and never read. `applySanitization` stores only `RenderedHTML` and `PolicyVersion` (`service.go:470-471`), so nothing is persisted and no audit entry is written. The service therefore cannot answer "was this article attacked?".

Minimal fix: derive violations from the sanitizer's own decisions (compare parsed-before vs parsed-after, or ask ammonia via an `attribute_filter`/`Tag` callback), and persist them next to `policy_version`. Until then, document the field as "expressions present in the source" and do not use it for triage.

---

### SEC-3 — `policy_version` is recorded but never verified, by the service or by Go
**Severity: Medium** · `services/security/src/lib.rs:18`, `services/security/src/content.rs:89`, `apps/api/internal/content/service.go:490-493`, `apps/api/internal/content/service.go:207`, `apps/api/cmd/server/main.go:501-506`

Evidence:

- `lib.rs:18` — `pub const POLICY_VERSION: &str = "2026-10-18.1";` a hand-maintained string, copied into every response at `content.rs:89`.
- The comment at `lib.rs:14-17` and `client.go:38-41` promises that a policy change "can invalidate previously published HTML instead of leaving it silently unverified".
- The only consumer is `service.go:490-493`:

```go
func (c Content) IsSanitized() bool {
	return c.RenderedHTML != "" && c.PolicyVersion != ""
}
```

That is a *non-emptiness* check, not a version check. Publishing gates on it (`service.go:207`), and the reader path serves `RenderedHTML` regardless.

Consequences: (a) if `ALLOWED_TAGS`/`ALLOWED_SCHEMES` is ever tightened, every previously published row still passes `IsSanitized()` and keeps serving HTML produced under the old policy — the invalidation mechanism the design claims simply does not exist; (b) `POLICY_VERSION` is not derived from the policy (it is a constant, and the unit test at `content.rs:266-272` only asserts it equals itself), so forgetting the manual bump is silent; (c) a mixed/rolled-back deployment serving an older policy binary is undetectable, because Go throws away the version the service reports — `main.go:501-506` calls `client.Ping` (which calls `ValidateSecurityPolicy`) purely as a liveness probe and discards `policy_version`, `max_source_chars` and both password bounds.

Minimal fix: have Go keep the expected version (from `ValidateSecurityPolicy` at startup, or compiled in), refuse to publish when `result.PolicyVersion != expected`, and include the version in a re-sanitize migration when it changes. Derive the constant from a policy hash if you want it to be tamper-evident.

---

### SEC-4 — `ErrUnavailable` does not cover the failures it claims to, and no caller checks it
**Severity: Medium** · `apps/api/internal/infrastructure/securityclient/grpc.go:188-201`, `apps/api/internal/infrastructure/securityclient/client.go:12-17`

Evidence (`grpc.go:196-201`):

```go
switch status.Code(err) {
case codes.Unavailable, codes.DeadlineExceeded, codes.Canceled:
	return fmt.Errorf("%w: %w", ErrUnavailable, err)
default:
	return err
}
```

`client.go:12-16` states the contract: *"Callers must treat it as fail closed… Continuing as if the check had passed converts an outage into a security incident."* Two gaps:

1. **Incomplete mapping.** The codes a *dead or panicking* peer produces are not `Unavailable`: a killed process or a handler panic surfaces as `codes.Unknown` ("stream terminated", "connection closed"), and a Rust panic inside a handler surfaces as `codes.Internal`/`Unknown`. `ResourceExhausted` (the SEC-1 overload) is likewise passed through raw. Those cases return a generic error that is not `ErrUnavailable`.
2. **Nobody checks it.** A repository-wide grep finds `ErrUnavailable` only inside `securityclient` itself plus comments; `content/service.go:461-468`, `media/service.go:218-221` and `auth/password.go` all fail closed by treating *any* error as failure. That is correct behaviour today, by accident.

So the documented invariant is unenforced: the first future call site that writes `if errors.Is(err, ErrUnavailable) { hold } else { log and continue }` will fail **open** on exactly the most likely outage (a crashed service), and the tests only cover `codes.Unavailable` (`grpc_test.go:139-160`).

Minimal fix: map every non-application code to `ErrUnavailable` (whitelist `InvalidArgument`/`NotFound` if they carry meaning), and add a `securityclient` helper/`errors.Is`-based guard that call sites must use, with a test for `codes.Unknown` and `codes.Internal`.

---

### SEC-5 — The service is plaintext, unauthenticated, and trusts every caller on the socket
**Severity: Medium** · `services/security/src/main.rs:9-17`, `services/security/src/transport/grpc.rs:3-4`, `apps/api/internal/infrastructure/securityclient/grpc.go:57`

Evidence:

- `main.rs:9` — `std::env::var("SECURITY_GRPC_BIND").unwrap_or_else(|_| "127.0.0.1:9001".to_string())`. The default is loopback, but a single env var moves it to `0.0.0.0:9001`, and there is no TLS anywhere in `main.rs` (plain h2c) and no authentication or authorization interceptor.
- `grpc.go:57` — `grpc.WithTransportCredentials(insecure.NewCredentials())`, documented as "expected to sit on the same private network" (`grpc.go:42-44`).
- `grpc.rs:3-4` — *"the Go caller is trusted to ask, never trusted to have validated"*. That is true for validation, but there is no notion of *who* is asking.

Impact: any process that can reach the socket gets a free CPU/memory sink (`HashPassword` at 64 MiB, §SEC-1), can sanitize arbitrary content, and can call `VerifyPassword` as an offline password-checking oracle against any PHC string it can obtain. The crate-level comment in `lib.rs:5-8` ("the Go API decides who may do what") is not enforced at this boundary because there is no boundary.

Minimal fix: keep the loopback default *and* fail startup on a non-loopback bind unless an explicit flag is set; add mTLS or a shared-token interceptor; add the concurrency/size limits from SEC-1.

---

### SEC-6 — `format: "markdown"` is not converted to HTML; the contract says it is
**Severity: Medium (latent — currently unreachable through the Go API)** · `services/security/src/content.rs:71-75`, `packages/contracts/security/v1/security.proto:55-57`, `apps/api/internal/content/service.go:451-459`

Evidence (`content.rs:71-75`):

```rust
let html = match format {
	"markdown" | "html" => source.to_string(),
	"plain" => format!("<p>{}</p>", escape_html(source)),
	_ => return Err(ContentError::UnknownFormat),
};
```

Markdown is aliased to HTML: the bytes are fed to ammonia as-is. The proto says `// One of markdown, html or plain` and the doc comment says the RPC "turns source content into allow-listed HTML" (`content.rs:60`), so a caller may reasonably believe the markdown was interpreted.

Today this is harmless **only because** the Go layer renders markdown itself before calling the service (`service.go:453-459`, goldmark with `html.WithUnsafe()` — render *then* sanitize, which is the correct order). The `"markdown"` arm is dead code from the only production caller.

The hazard is the contract: any direct caller (a future service, a CLI, a test, another language binding) that passes `format="markdown"` receives markdown **text** labelled as sanitized HTML. The sanitizer will happily pass through `[click me](javascript:alert(1))`, `![x](data:text/html,…)` and `{{template}}`-style constructs because to ammonia they are just text; the moment a client renders that string with any markdown renderer, the sanitizer is bypassed entirely — including `link_rel`, which ammonia only applies to real `<a>` elements. The same is true of the reverse pipeline mistake: sanitize-then-render is exactly what `service.go:451-459` avoids.

Minimal fix: either implement the conversion in Rust (pulldown-cmark, then clean, as ammonia's own docs recommend) or reject `"markdown"` with `ContentError::UnknownFormat` so the responsibility is unambiguous. Add a contract test asserting that a `javascript:` markdown link cannot survive `SanitizeContent(format="markdown")`.

---

### SEC-7 — Upload inspection is a 4-byte prefix match on a 64-byte sample; a magic-number match is reported as `Clean`
**Severity: Low** · `services/security/src/content.rs:184-205`, `apps/api/internal/media/storage.go:39`, `apps/api/internal/media/service.go:203-217`, `apps/api/internal/media/handler.go:125`

Evidence (`content.rs:190-198`):

```rust
"image/png" => head.starts_with(&[0x89, 0x50, 0x4E, 0x47]),
"image/jpeg" => head.starts_with(&[0xFF, 0xD8, 0xFF]),
"image/gif"  => head.starts_with(b"GIF8"),
"application/pdf" => head.starts_with(b"%PDF"),
"text/plain" => is_plain_text(head),
```

- PNG is checked on 4 of its 8 signature bytes; GIF on 4 ASCII bytes; PDF on 4. Any file whose first bytes are `GIF89a` then an HTML/JS payload is `ScanDecision::Clean`, `reason_code: "ok"`.
- The sample is only 64 bytes (`storage.go:39` `HeadSampleSize = 64`, read via a ranged GET at `media/service.go:203-208`), so nothing beyond the prefix is ever examined — no entropy check, no embedded-JS detection in PDFs, no dimensions for images. "Clean" means "the declared type is on the allow-list and the prefix agrees", which is weaker than the name implies.
- The `head.is_empty()` branch (`content.rs:184-188`) correctly returns `NeedsManualReview` — but nothing in the API implements a manual-review queue, so such uploads are simply never referenceable (fail-closed, but the label is misleading).

Mitigations that keep this Low: the asset serves the **declared** MIME from a fixed allow-list (`media/service.go:227`), `X-Content-Type-Options: nosniff` is set on the download path (`handler.go:125`), SVG is not allowed (`content.rs:157-164`), declared size must equal the stored stream size (`media/service.go:163-165`). A polyglot served as `image/gif` with `nosniff` does not execute.

Minimal fix: check the full 8-byte PNG signature and the 6-byte GIF87a/89a signature, require the PDF header plus a `%%EOF` probe or a page-dimension parse, and rename the verdict to `signature_matched` (or add a real AV/hook) so that downstream code cannot mistake it for a content scan.

---

### SEC-8 — `verify_password` builds a policy that argon2 then ignores; nothing enforces the KDF bounds on verify
**Severity: Low** · `services/security/src/password.rs:88-93`, `services/security/src/password.rs:55-59`, `services/security/src/transport/grpc.rs:60`

Evidence (`password.rs:88-92`):

```rust
let parsed = PasswordHash::new(encoded).map_err(|_| PasswordError::InvalidHash)?;
let argon = build(Params2::default())?;
Ok(argon.verify_password(plain.as_bytes(), &parsed).is_ok())
```

argon2 0.5.3's own documentation states: *"NOTE: hash params from `parsed_hash` are used instead of what is configured in the `Argon2` instance."* Therefore the constructed `Params2::default()` is irrelevant to verification: the `m`/`t`/`p` that get used come from the PHC string. Two consequences:

1. There is no rehash-on-login and no policy enforcement on the verify path — if `Params2::default()` is ever lowered or raised, existing hashes keep verifying under their stored cost forever, and the apparent "policy" in `password.rs:90` is a maintenance trap that reads as if it did something.
2. A stored PHC string is trusted for its cost parameters. `Params::new` accepts `m_cost` up to the crate maximum, and `hash_password_into` allocates `vec![Block::default(); block_count]` accordingly; a hostile or corrupted record (imported rows, a future "bring your own hash" endpoint) becomes an allocation of up to ~4 TiB at verify time. Also note `MIN_LENGTH`/`MAX_LENGTH` are enforced only in `hash_password` (`password.rs:65-69`), never on the verify path (`grpc.rs:60`), so an arbitrarily large `plain` is accepted.

Today the only hashes in play are produced by `hash_password` (`grpc.rs:46`) with the fixed default params, so this is defence-in-depth, not a live exploit.

Minimal fix: parse the PHC params, reject any hash whose `m`/`t` exceed the current policy, rehash on successful verify when they differ, and enforce the length bounds before calling argon2 on both paths.

---

### SEC-9 — `argon2` is built without its `zeroize` feature, so KDF state is never wiped
**Severity: Low** · `services/security/Cargo.toml:8`, `services/security/src/password.rs:63,79`

Evidence: `Cargo.toml:8` is `argon2 = "0.5"` with no features. argon2 0.5.3's default features are `alloc`, `password-hash`, `rand` — **`zeroize` is not default** (verified against the crate's feature list for 0.5.3). In the crate source, every wipe is behind `#[cfg(feature = "zeroize")]`:

```rust
#[cfg(feature = "zeroize")]
initial_hash.zeroize();
...
#[cfg(feature = "zeroize")]
{ blockhash.zeroize(); blockhash_bytes.zeroize(); }
```

and the 64 MiB working buffer is a plain `Vec<Block>` whose drop does not scrub it. So while `password.rs:79` (`plain.zeroize()`) does wipe the input `String` as its comment claims, the most sensitive artefact — the password-derived block memory — is left in freed heap pages, where it can surface in a core dump or another allocation.

Minimal fix: `argon2 = { version = "0.5", features = ["std", "zeroize"] }`. (Note the block memory still needs explicit wiping or a `ZeroizeOnDrop` wrapper to be fully covered; enabling the feature at least stops the crate from silently skipping it.)

---

### SEC-10 — The verify path never zeroizes the plaintext
**Severity: Low** · `services/security/src/transport/grpc.rs:59-61`, `services/security/src/password.rs:88`

Evidence: `hash_password` takes `String` by value and zeroizes it (`password.rs:64,79`); `verify_password` takes `&str`, and the `VerifyPasswordRequest` that owns those bytes is dropped un-wiped when the handler returns (`grpc.rs:59-61`), as are prost's decode buffers. Every login therefore leaves a plaintext password copy in the request message's allocation.

Minimal fix: take `mut String` on the verify path too, wrap request handling in something that zeroizes on drop (e.g. `zeroize::Zeroizing`), or accept `Secrets`-style types; at minimum document that verify does not have the same guarantee as hash.

---

### SEC-11 — `class` is allowed on every tag with arbitrary values
**Severity: Low** · `services/security/src/content.rs:47-53`, `services/security/src/content.rs:94-108`, `apps/web/src/pages/site/ContentDetail.tsx:514`

Evidence (`content.rs:49`): `"class" => true,` — the first arm, matching any tag, with no `allowed_classes` restriction configured (`content.rs:77-83` sets `tags`, `tag_attributes`, `url_schemes` and `link_rel` only; ammonia's default for `allowed_classes` is the empty map, and with an empty map the filter at ammonia's `adjust_node_attributes` is skipped entirely).

This is deliberate — the editor's own rich blocks rely on it (`apps/web/src/lib/htmlToMarkdown.test.ts` round-trips `class="pp-linkcard"`). It is not XSS. The residual risk is presentational: the reader page injects the server HTML with `dangerouslySetInnerHTML` (`ContentDetail.tsx:514`), so an author can attach the site's real component classes (buttons, cards, alerts, visibility/`hidden` helpers) to arbitrary markup and spoof UI inside their own article — useful for phishing a commenter or hiding a disclaimer.

Related latent hazard: because no `style_properties` (ammonia's CSS filter) is configured, the day someone adds `"style"` to `is_allowed_attribute` it will be accepted *unfiltered*; the policy builder has no guard for that.

Minimal fix: restrict `class` to an allow-list per block type via ammonia's `allowed_classes`, or at least `add_allowed_classes` for the block classes the editor emits; add a comment/test that pins the current policy so widening it is a reviewed change.

---

### SEC-12 — `text/plain` uploads whose 64th byte splits a UTF-8 character are rejected as `magic_mismatch`
**Severity: Low** · `services/security/src/content.rs:207-210`, `apps/api/internal/media/storage.go:39`

Evidence (`content.rs:208-210`):

```rust
fn is_plain_text(head: &[u8]) -> bool {
	!head.contains(&0) && std::str::from_utf8(head).is_ok()
}
```

The sample is exactly 64 bytes (`HeadSampleSize = 64`, `storage.go:39`), and a ranged read truncates at an arbitrary byte boundary. For any multi-byte script the 64th byte frequently lands mid-character — with CJK text (3 bytes/char) 64 = 21×3 + 1, so *every* Chinese `text/plain` file of ≥64 bytes produces invalid UTF-8 in the sample and is rejected with `magic_mismatch`. This app's UI and seeded content are Chinese, so this will bite in practice.

Minimal fix: make `is_plain_text` tolerate a truncated tail (`std::str::from_utf8` on the longest valid prefix, or `String::from_utf8_lossy` plus a check that the only replacement is at the end), and/or request a sample size that is a multiple of 4 plus slack.

---

## 2. Secondary observations (not separately numbered)

- `content.rs:171-175` — `inspect_upload` returns `Result<_, ContentError>` but no arm ever returns `Err`; `grpc.rs:89-90`'s `map_err` is dead code. Harmless, but it advertises an error contract that does not exist.
- `grpc.rs:74-75` — `TooLarge` and `UnknownFormat` both collapse to `Status::invalid_argument`; the client cannot tell a permanent policy refusal from a transient one, and `mapError` (`grpc.go:196-200`) will hand both back as generic errors. `content/service.go:461-468` treats them identically (hold the item), which is safe but leaves a 200 001-character draft permanently un-savable with no distinct signal.
- `content.rs:94-108` — `allowed_attributes()` rebuilds ammonia's `tag_attributes` from scratch, so ammonia's defaults (`a[href,hreflang]`, `img[align,alt,height,src,width]`, `td[colspan,rowspan,headers]`, …) are *replaced*, not extended. That is the intended narrowing here, but it means `hreflang`, `colspan`, `rowspan`, `scope`, `start` and `align` are silently stripped from otherwise-allowed tables/lists — so authored `<td colspan=2>` is flattened. Worth knowing because the web client has a guard that assumes it (`apps/web/src/lib/htmlToMarkdown.ts:152` bails out on `[colspan]`/`[rowspan]`), i.e. the client and the sanitizer agree, but by coincidence rather than contract; nothing in Go or the UI documents the loss.
- `build.rs:10` uses a relative proto path (`../../packages/contracts/security/v1`), which depends on the build's working directory being `services/security`; harmless under cargo, fragile if the crate is ever built from another root or vendored.
- I found no `unsafe`, no `unwrap`/`expect`/slice-index panic reachable from gRPC input in `content.rs` (`content.rs:194`'s `head[0..4]`/`head[8..12]` are guarded by `head.len() >= 12`, and short-circuit evaluation holds), and no such panic in `password.rs`. Ammonia's own `assert!`s for contradictory policy (`generic_attributes` ∩ {rel}, `allowed_classes` ∩ tag_attributes, `tags` ∩ `clean_content_tags`) are all satisfied by this configuration, so the builder cannot panic at request time.

---

## 3. Sanitizer bypass assessment (the negative result, with the trace)

Policy actually in force (`content.rs:40-58,77-83`), after reading ammonia 4.2.4's `Builder::default()` and its `clean_dom`:

- tags = the 31-tag list at `content.rs:40-44` (`tags()` **replaces** ammonia's default 74-tag set);
- `tag_attributes` = per-tag map rebuilt by `allowed_attributes()` (replaces defaults): `class` on every allowed tag, `a[href,title]`, `img[src,alt,width,height]`;
- `generic_attributes` = ammonia's default, `{lang, title}` (not overridden; neither is dangerous);
- `url_schemes` = `{http, https, mailto}` (replaces defaults, so `ftp`/`tel`/`magnet`/… are gone);
- `clean_content_tags` = ammonia's default `{script, style}` (element **and** content removed);
- `link_rel = Some("noopener noreferrer")` (adds `rel` to every `<a>`), `strip_comments = true` (default), `url_relative = PassThrough` (default), `allowed_classes` empty, `style_properties` unset.

The relevant enforcement points in ammonia 4.2.4, read from source:

- `clean_child`: `if self.tags.contains(&*name.local)` → attributes are `retain`ed through `attr_filter`, which allows only generic/prefix/per-tag/per-value attributes and then, **for attributes where `is_url_attr(tag, attr)` is true, requires `Url::parse(value)` to succeed with a scheme in `url_schemes`** (relative URLs pass only because `url_relative` is `PassThrough`; `data:`/`javascript:`/`vbscript:` all parse to a scheme that is absent → attribute dropped).
- `clean_node_content` matches `clean_content_tags` on the **local name**, in any namespace.
- `check_expected_namespace` rejects illegal namespace transitions (html→svg only via `<svg>`, html→mathml only via `<math>`, foreign-content children only under the spec's integration points) — this is ammonia's fix for the `<svg><iframe>` mXSS class described in its own source comment.
- `clean_dom` cleans **iteratively**, and `SerializableHandle::serialize` (ammonia's `rcdom.rs`) serialises with an explicit `VecDeque<SerializeOp>` worklist — **no recursion**, so deeply nested input cannot overflow the stack in ammonia's own code.

| Vector from the task list | Verdict | Why (traced) |
|---|---|---|
| `<script>` | blocked | tag absent + in `clean_content_tags` → content removed; `content.rs:216-220` test |
| `onerror=`/`onload=`/any `on*` | blocked | not in `generic_attributes` (`lang`,`title`) nor any per-tag set; `retain` drops them |
| `<a href="javascript:…">`, `vbscript:`, `data:` | blocked | `is_url_attr("a","href")` → `Url::parse` succeeds with a non-allow-listed scheme → dropped |
| entity/whitespace obfuscation of `javascript:` (`&#106;avascript:`, `jav&#x09;ascript:`) | blocked | the HTML parser decodes entities **before** the attribute check, and the WHATWG `Url` parser strips ASCII tab/newline inside the scheme, so the scheme is still `javascript` |
| `srcdoc`, `formaction`, `action`, `poster`, `srcset`, `xlink:href`, `target`, `ping`, `background`, `style` | blocked | none are in the attribute allow-list. `xlink:href` deserves a note: the attribute's **local** name is `href`, so it would *pass* the allow-list on an `<a>`, but the only way to produce it is an SVG-namespaced `<a>`, which `check_expected_namespace` removes (html parent ↔ svg child requires `local == "svg"`), and it would also be scheme-checked like `href` |
| `<svg>`/`<math>`/`<foreignObject>`/`<animate>`/foreign namespace confusion | blocked | tags absent; children are re-parented under an HTML parent and then rejected by `check_expected_namespace`. The `animate`/`attributeName` special-casing in ammonia only runs for SVG-namespaced elements, which cannot survive here |
| `<template>` | blocked (and content **lost**) | `template` absent from `tags`; its children live in `template_contents`, not `children`, so ammonia's flattening drops the whole subtree rather than hoisting it. Safe, but authors lose content silently |
| `<noscript>` | blocked | not allowed; children hoisted as text/elements and then filtered. html5ever's serializer escapes `noscript` children because `SerializeOpts::scripting_enabled` defaults to `true` |
| `<style>` with `expression()`/`url()` | blocked | tag absent **and** in `clean_content_tags` → content removed; `style` *attribute* is not allowed either |
| `<iframe>`/`<object>`/`<embed>` | blocked | tags absent (not in `clean_content_tags`, so any text children survive as text) |
| `<form>`/`action` | blocked | tag absent, attribute absent |
| `<meta http-equiv=refresh>`, `<base href>` | blocked | tags absent; ammonia parses as a fragment "as if it were the contents of a `<div>`", so document-level tags never reach the output anyway |
| `target=_blank` without `noopener` | blocked | `target` not allowed; `link_rel` force-writes `rel="noopener noreferrer"` on every `<a>` |
| unclosed/misnested tags, re-parse tricks (mXSS) | blocked | output is produced by html5ever's serializer from a re-built DOM with `<`, `>`, `&`, `"` and NBSP escaped in text and attribute values — except inside `style/script/xmp/iframe/noembed/noframes/plaintext` parents, none of which can survive this policy |
| idempotence `sanitize(sanitize(x)) == sanitize(x)` | **likely yes**, not executed | the only re-added attribute is `rel` (stripped next pass, then re-added identically); entity forms normalise to the same serialisation. See §4 |
| unbounded input size | bounded | `content.rs:65` rejects > 200 000 chars, and Go caps at the same 200 000 runes (`apps/api/internal/content/domain.go:112`, validated at `:328`), so the gRPC 4 MiB default limit is never the binding constraint |
| deep nesting / quadratic blow-up / stack overflow | **no confirmable finding** | ammonia cleans and serialises iteratively (verified in 4.2.4 source). I initially hypothesised a stack overflow via recursive serialisation and it is **wrong** for this version — recorded here so nobody repeats it. Residual parser-level blow-up is unproven → §4 |
| panic reachable from input | none found | all slice indexes guarded; no `unwrap`/`expect` on request data; ammonia's config `assert!`s are satisfied |

**Conclusion:** with ammonia pinned at 4.2.4 and this configuration, I have no traced path from author-supplied HTML to executable script. The crown jewel is doing its job. Two caveats worth keeping in mind: the guarantee is *entirely* contingent on `format == "markdown"` never reaching a markdown renderer (SEC-6), and on the reader page never inserting `source_body` (as opposed to `rendered_html`) into the DOM.

---

## 4. Needs runtime confirmation

Nothing here is claimed as a finding; each item needs execution I could not perform.

1. **Parse-time blow-up.** Whether 200 000 characters of pathological-but-legal HTML (nested `<table>`/`<b>` misnesting and foster-parenting, `<svg>` breakout sequences, the formatting-element reconstruction algorithm) costs super-linear time in html5ever 0.40.1. Ammonia's cleaner/serialiser are iterative, so this is a *parser* question only. Test: time `sanitize("html", …)` on a corpus of adversarial 200 k inputs; enforce a wall-clock budget.
2. **Peak memory under concurrent logins.** SEC-1's arithmetic (≈64 MiB × in-flight calls, ~240-request fixable burst per client window) is derived from the code, but the actual peak RSS, and whether tonic/hyper's `max_concurrent_streams` defaults permit that many simultaneous streams on one connection, must be measured (`heaptrack`/`/proc/<pid>/status` under `hey -c 240`).
3. **Idempotence of `sanitize`.** Run `sanitize` twice over a large corpus (including foreign-content and entity-heavy inputs) and diff. Static reading says yes (§3), but this is exactly the property a one-line change to the policy can break.
4. **Constant-time comparison.** `argon2` 0.5.3's `impl PasswordVerifier for Argon2` was **not** in the portion of `lib.rs` I could read (the crate-level docs guarantee only that the PHC params are used, which I did read). Whether the final 32-byte comparison is constant-time, and whether the algorithm/version come from the hash or the instance, is therefore unverified. Risk is low — the compared value is a memory-hard KDF output, not a secret the attacker can probe byte-by-byte — but it should be confirmed by reading `password_hash`'s `Output` comparison in the pinned versions.
5. **`NeedsManualReview` end-to-end.** Whether an asset in that state can ever be released (no review queue was found in the media module) — a workflow gap rather than a vulnerability, and arguably outside this task's scope.
6. **Whether a Rust panic takes the whole process or one connection.** A panic inside a tonic handler unwinds the task; a `panic = "abort"` profile (not set in `Cargo.toml`) would abort instead. This changes SEC-4's blast radius, not its conclusion.

---

## 5. Verified safe (checked, no finding)

- **XSS through the sanitizer**: no traced bypass for any vector in §3's table, at ammonia 4.2.4 with this exact policy.
- **`javascript:`/`data:`/`vbscript:` URL smuggling** in `href`/`src`, including entity-, tab-, newline- and case-obfuscated forms: blocked by parse-then-`Url::parse`-then-scheme-allow-list.
- **mXSS via namespace confusion** (`<svg>`, `<math>`, `<foreignObject>`, `<template>`, `<noscript>`, integration points): blocked by tag removal plus ammonia's `check_expected_namespace`.
- **`rel`/`target` handling**: `link_rel` forces `noopener noreferrer`; `target` cannot be authored; ammonia's `a[rel]` assertion cannot trip because `rel` is in neither `generic_attributes` nor `tag_attributes["a"]`.
- **Policy-built panics**: all three contradiction assertions in ammonia's `clean_dom` are satisfied; no request-time panic path found in `content.rs` or `password.rs`.
- **Argon2id parameters**: `m = 65 536 KiB, t = 3, p = 2`, `Version::V0x13`, `Algorithm::Argon2id` explicitly (no argon2i/argon2d downgrade, no v0x10), 16-byte CSPRNG salt per hash (`SaltString::generate(&mut OsRng)`, `password.rs:71`), key length 32 by default. This meets/exceeds the OWASP Argon2id baseline; the commentary at `password.rs:40-41` is accurate.
- **Password length bounds** on the *hash* path (`MIN_LENGTH = 8`, `MAX_LENGTH = 128`) are enforced before any KDF work, with an explicit `zeroize` on both the too-short/too-long and the error paths (`password.rs:65-69,74-77`).
- **PHC handling**: a malformed/absent stored hash returns `PasswordError::InvalidHash` (`password.rs:89`) → `Status::invalid_argument` (`grpc.rs:61`) → Go error (`grpc.go:101-103`) → login denied. There is no path where a corrupt record verifies (`verify_password` returns `Ok(bool)`, never "true on error").
- **Upload allow-list and size bounds**: SVG/HTML/executable MIMEs are refused, `size <= 0` and `> 25 MiB` are refused, declared size must equal the stored stream length, and the `head` sample is read from **storage** (`media/service.go:203-208`), not from the client — so inspection is not self-attestation, even though the prefix check itself is weak (SEC-7).
- **Fail-closed on the write paths**: sanitize error → `RenderedHTML = ""`, `PolicyVersion = ""`, status held (`content/service.go:461-468`); publish requires `IsSanitized()` (`:207`); scan error → no asset (`media/service.go:218-221`); `Referenceable()` requires exact `ScanClean` (`media/domain.go:218`); unknown/empty proto status → `NeedsManualReview` (`grpc.go:148-151`), not clean. Timeouts fail closed in every case I traced.
- **Go's local Argon2id fallback** (`apps/api/internal/auth/password.go:85-127`) is only reachable when the security client is the `Unavailable` stub *and* `AppEnv != production` (`cmd/server/main.go:469-483`), and it uses the same parameters plus `subtle.ConstantTimeCompare` (`password.go:126`). No weaker production fallback exists.
- **Unused proto fields** (`file_name`, `storage_key` in `InspectUploadRequest`) are ignored by the Rust service, so a caller cannot redirect inspection at a different object; the sample is read by the Go layer from the purpose-derived storage adapter (`media/service.go:203`, `:100-105`).
