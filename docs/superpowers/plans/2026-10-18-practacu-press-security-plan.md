# Practacu Press Rust Security Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the isolated Rust gRPC security service used by the Go API for password operations, content sanitization, upload inspection, and security policy validation.

**Architecture:** The service is stateless, does not access business databases, and exposes a versioned protobuf API. Go treats security checks as mandatory for publication and upload completion; if the service is unavailable, the operation pauses instead of bypassing the check.

**Tech Stack:** Rust 2024, tonic, prost, Argon2id, ammonia-style HTML policy, MIME inspection, cargo-fuzz, cargo test, clippy.

## Global Constraints

- Rust service never owns users, articles, sites, permissions, or business transactions.
- All requests are independently validated at the gRPC boundary.
- Passwords, tokens, provider secrets, and file contents are never logged.
- Sanitization and upload inspection are deterministic and covered by regression fixtures.
- Go calls use deadlines, bounded retries, circuit breaking, and fail-closed behavior for publish/upload.

---

### Task 1: Create the Rust crate and versioned protobuf contract

**Files:**
- Create: `services/security/Cargo.toml`
- Create: `services/security/build.rs`
- Create: `services/security/src/main.rs`
- Create: `services/security/src/transport/grpc.rs`
- Create: `packages/contracts/security/v1/security.proto`
- Create: `services/security/tests/grpc_smoke.rs`

**Interfaces:**
- `HashPassword`, `VerifyPassword`, `SanitizeContent`, `InspectUpload`, and `ValidateSecurityPolicy` are the v1 RPCs.
- Every response contains `policy_version` and a machine-readable status.

- [ ] **Step 1: Write the protobuf contract**

Define request/response messages with bounded byte and string fields, explicit enums for scan results, and no business table IDs beyond opaque references.

- [ ] **Step 2: Write the failing smoke test**

Start the server in-process, call `ValidateSecurityPolicy`, and assert the response contains a non-empty policy version.

- [ ] **Step 3: Generate tonic/prost bindings and implement the server shell**

Return `UNIMPLEMENTED` for methods not yet implemented; the smoke test must pass for the health/policy method.

- [ ] **Step 4: Run formatting and the smoke test**

Run: `cargo fmt --check; cargo test -p practacu-security grpc_smoke -- --nocapture`
Expected: PASS.

### Task 2: Implement Argon2id password operations

**Files:**
- Create: `services/security/src/application/password.rs`
- Create: `services/security/src/domain/password_policy.rs`
- Modify: `services/security/src/transport/grpc.rs`
- Create: `services/security/tests/password_tests.rs`

**Interfaces:**
- `hash_password(plain: &[u8], policy: &PasswordPolicy) -> Result<PasswordHash>`
- `verify_password(plain: &[u8], encoded: &str) -> Result<bool>`

- [ ] **Step 1: Write tests**

Cover successful verification, wrong password, malformed hash, password length limits, and policy-version output.

- [ ] **Step 2: Implement Argon2id with explicit parameters**

Load memory, iterations, and parallelism from validated configuration. Return generic failure messages to callers and never reveal which credential component failed.

- [ ] **Step 3: Add zeroization and bounded input handling**

Zeroize temporary password buffers where practical and reject oversized inputs before hashing.

- [ ] **Step 4: Run tests and clippy**

Run: `cargo test -p practacu-security password_tests; cargo clippy -p practacu-security -- -D warnings`
Expected: PASS.

### Task 3: Implement Markdown and HTML sanitization

**Files:**
- Create: `services/security/src/application/content.rs`
- Create: `services/security/src/domain/content_policy.rs`
- Create: `services/security/tests/content_fixtures.rs`
- Create: `services/security/tests/fixtures/xss-cases.json`

**Interfaces:**
- `sanitize_content(source_format: SourceFormat, source: &str, policy: &ContentPolicy) -> SanitizedContent`

- [ ] **Step 1: Add malicious fixtures**

Include script tags, event attributes, `javascript:` URLs, data URLs, SVG payloads, malformed nesting, oversized input, and safe code blocks.

- [ ] **Step 2: Write failing assertions**

Assert all dangerous constructs are removed, safe formatting remains, output is deterministic, and source length limits are enforced.

- [ ] **Step 3: Implement allow-list sanitization**

Permit only the documented tags, attributes, URL schemes, image source rules, and code-block classes. Return both cleaned HTML and a list of policy violations for audit display.

- [ ] **Step 4: Run fixture tests and fuzz target**

Run: `cargo test -p practacu-security content_fixtures`
Expected: PASS with no dangerous fixture surviving.

### Task 4: Implement upload inspection

**Files:**
- Create: `services/security/src/application/upload.rs`
- Create: `services/security/src/domain/upload_policy.rs`
- Create: `services/security/tests/upload_tests.rs`

**Interfaces:**
- `inspect_upload(metadata: UploadMetadata, content: &[u8], policy: &UploadPolicy) -> ScanResult`

- [ ] **Step 1: Write upload security tests**

Cover mismatched extension/MIME, executable content, path traversal names, oversized files, nested archives, valid image, and valid document cases.

- [ ] **Step 2: Implement bounded inspection**

Check byte size, normalized file name, magic bytes, declared MIME, extension allow-list, archive depth, and decompression budget. Never write the user name directly to disk.

- [ ] **Step 3: Return explicit scan states**

Use `clean`, `rejected`, and `needs_manual_review`; include a stable reason code and policy version.

- [ ] **Step 4: Run tests and fuzzing**

Run: `cargo test -p practacu-security upload_tests`
Expected: PASS.

### Task 5: Add the Go gRPC client and fail-closed integration

**Files:**
- Create: `apps/api/internal/infrastructure/securityclient/client.go`
- Create: `apps/api/internal/infrastructure/securityclient/circuit_breaker.go`
- Create: `apps/api/internal/infrastructure/securityclient/client_test.go`
- Modify: `apps/api/internal/content/service.go`
- Modify: `apps/api/internal/media/service.go`

**Interfaces:**
- `SecurityClient.HashPassword(ctx, plain string) (string, error)`
- `SecurityClient.SanitizeContent(ctx, input ContentInput) (SanitizedContent, error)`
- `SecurityClient.InspectUpload(ctx, input UploadInput) (ScanResult, error)`

- [ ] **Step 1: Write client tests**

Cover timeout, unavailable server, malformed response, successful scan, and circuit-open behavior.

- [ ] **Step 2: Implement deadlines and bounded retries**

Use a per-call timeout from configuration, retry only transient transport failures, and open the circuit after the configured failure threshold.

- [ ] **Step 3: Enforce fail-closed content and media behavior**

When sanitization or scanning is unavailable, retain the item as pending security review and return a retryable API error; never mark it published or clean.

- [ ] **Step 4: Run Go and Rust integration tests**

Run: `go test ./apps/api/internal/infrastructure/securityclient ./apps/api/internal/content ./apps/api/internal/media -v`
Expected: PASS with a fake gRPC server and a real service smoke test in CI.

### Task 6: Add security regression and fuzz coverage

**Files:**
- Create: `services/security/fuzz/fuzz_content.rs`
- Create: `services/security/fuzz/fuzz_upload.rs`
- Create: `tests/security/site_isolation_cases.md`

**Interfaces:**
- Fuzz targets must never panic and must preserve the size/time bounds in their policies.

- [ ] **Step 1: Add content and upload fuzz targets**

Generate arbitrary bytes and strings, call sanitizer and inspector, and assert no panic, unbounded allocation, or policy bypass marker.

- [ ] **Step 2: Add cross-site security scenarios**

Record request sequences for cross-site content, media, private message, notification, and admin access; the Go integration suite consumes these cases.

- [ ] **Step 3: Run the security gate**

Run: `cargo test --workspace; cargo clippy --workspace -- -D warnings; cargo fuzz run fuzz_content -- -max_total_time=60`
Expected: PASS with no panic or sanitizer failure.

- [ ] **Step 4: Commit**

Commit: `git add services/security packages/contracts/security apps/api/internal/infrastructure/securityclient tests/security; git commit -m "feat: add rust security service"`
