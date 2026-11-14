# Rust security service (fallback)

This crate is the original implementation of the security gRPC contract
(`packages/contracts/security/v1/security.proto`): Argon2id password hashing, allow-list
content sanitization, upload inspection, and the Argon2 concurrency/deadline bounds in
`src/transport/grpc.rs`.

**It stays in place and is not deprecated in this change.** The Go API now has a Go
implementation of the same service (`services/security-go`) and prefers it, falling back
to this Rust service on a transport/availability error. See
[`docs/security/go-security-service.md`](../../docs/security/go-security-service.md) for
the routing rule, parity differences and rollout/rollback.

Operational contract that must not drift:

- `SECURITY_GRPC_BIND` selects the listen address (default `127.0.0.1:9001`).
- `SECURITY_ARGON2_CONCURRENCY` and `SECURITY_ARGON2_TIMEOUT_MS` bound password hashing.
- `POLICY_VERSION` is `2026-11-02.1`; the Go service reports the same version.

Run it with `cargo run --release` (or `scripts/dev.ps1`, which starts it next to the Go
service) and keep `cargo test` green: these tests are the behavioural spec the Go
implementation is checked against.
