// Package securitygo is the Go implementation of the Practacu Press security
// service.
//
// It is a drop-in replacement for the Rust service in
// services/security for the gRPC contract in
// packages/contracts/security/v1: the Go API prefers this service and falls
// back to the Rust one when a call fails with a transport error.
//
// The package deliberately holds no business data: it owns password hashing,
// content sanitization and upload inspection only, and every entry point
// re-validates its input because a caller that has already validated is still
// just a caller.
package securitygo

// PolicyVersion identifies the rule set that produced a result.
//
// It is stored next to sanitized content so a later policy change can
// invalidate previously published HTML instead of leaving it silently
// unverified.
//
// It is kept identical to the Rust service's POLICY_VERSION: both
// implementations must report the same policy for the same rules, otherwise
// switching between them would look like a policy change to stored content.
//
// 2026-11-02.1: V-22 — class values are filtered token by token
// (pp-*/language-* plus a small Markdown ecosystem allow-list) and upload
// inspection uses the complete file signatures plus HTML/SVG polyglot
// rejection.
const PolicyVersion = "2026-11-02.1"

// MaxSourceChars is the maximum accepted source length in Unicode code points.
const MaxSourceChars = 200_000

// MaxUploadBytes is the maximum accepted upload size in bytes.
const MaxUploadBytes int64 = 25 * 1024 * 1024
