// Package securitygo implements the in-process security primitives used by the
// API: Argon2id password hashing, allow-list HTML sanitization and upload
// inspection.
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
// It is kept stable across implementation changes: existing published content
// records the policy that produced it, and an unrelated change to the version
// would look like a policy change to stored content.
//
// 2026-11-02.1: V-22 — class values are filtered token by token
// (pp-*/language-* plus a small Markdown ecosystem allow-list) and upload
// inspection uses the complete file signatures plus HTML/SVG polyglot
// rejection.
//
// 2026-11-21.1: collapsible text — <details>/<summary> and the details-only
// `open` attribute are allowed so the editor's collapse block survives; no
// other tag or attribute changed.
const PolicyVersion = "2026-11-21.1"

// MaxSourceChars is the content API's maximum source length in Unicode code points.
const MaxSourceChars = 1_000_000

// MaxSanitizedInputChars bounds the HTML fragment passed to the sanitizer. Markdown
// rendering can expand a valid source through generated tags and attributes, so this
// limit is larger than the API's source-body limit.
const MaxSanitizedInputChars = 8_000_000

// MaxUploadBytes is the maximum accepted upload size in bytes.
const MaxUploadBytes int64 = 25 * 1024 * 1024
