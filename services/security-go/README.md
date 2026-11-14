# Go security service (preferred)

This directory implements the same gRPC contract as the Rust service
(`packages/contracts/security/v1/security.proto`):

- Argon2id password hashing / verification in the same PHC format as Rust;
- allow-list HTML sanitization (policy `2026-11-02.1`);
- upload inspection (MIME allow-list, magic bytes, markup rejection);
- Argon2 concurrency and deadline bounds, panic recovery, graceful shutdown.

The API calls this service first and falls back to the Rust service on an
availability error. Validation rejections (bad password, rejected content, rejected
upload) are final and never retried against Rust.

## Run

```sh
go run ./services/security-go/cmd/security-go -addr 127.0.0.1:9002
```

Environment alternatives:

- `SECURITY_GO_GRPC_BIND` selects the listen address (default `127.0.0.1:9002`).
- `SECURITY_GO_GRPC_ADDR` on the API points at this service; the API also needs
  `SECURITY_GRPC_ADDR` for the Rust fallback.
- `SECURITY_ARGON2_CONCURRENCY` / `SECURITY_ARGON2_TIMEOUT_MS` mirror the Rust bounds.

`scripts/dev.ps1` starts this service on 9002 and the Rust service on 9001. If the Go
service fails to build or start, the script degrades to Rust-only.

## Rust stays as the fallback

The original Rust implementation is intentionally kept in `services/security`.
See [`../security/README.md`](../security/README.md) and the project documentation
`docs/security/go-security-service.md` for the routing rule, parity differences,
rollout and rollback notes. The Rust tests remain the behavioural specification for
this package; do not change one side without checking the other.
