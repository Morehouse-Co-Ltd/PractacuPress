package securitygo

import (
	"bytes"
	"strings"
	"unicode/utf8"
)

// ScanDecision is the verdict of upload inspection.
type ScanDecision int

// Inspection verdicts.
const (
	// ScanClean means the declared type was believable.
	ScanClean ScanDecision = iota + 1
	// ScanRejected means the upload is not acceptable.
	ScanRejected
	// ScanNeedsManualReview means the service could not decide from the sample.
	ScanNeedsManualReview
)

// UploadVerdict is one inspection verdict with its machine readable reason.
type UploadVerdict struct {
	Decision   ScanDecision
	ReasonCode string
}

// allowedUploadMIME lists the MIME types the application accepts at all.
var allowedUploadMIME = map[string]struct{}{
	"image/png":       {},
	"image/jpeg":      {},
	"image/webp":      {},
	"image/gif":       {},
	"application/pdf": {},
	"text/plain":      {},
}

// signatureLen is the length of the complete leading signature for each
// declared binary MIME type.
//
// The signatures are the full on-disk magic, not a prefix: a truncated file (or
// one whose signature the sampling budget cannot cover) is refused instead of
// half-matching. text/plain has no signature and is handled separately.
func signatureLen(mime string) int {
	switch mime {
	case "image/png":
		return 8
	case "image/jpeg":
		return 3
	case "image/gif":
		return 6
	case "image/webp":
		return 12
	case "application/pdf":
		return 5
	default:
		return 0
	}
}

// hasSignature reports whether the head starts with the complete signature of
// the declared type.
func hasSignature(mime string, head []byte) bool {
	switch mime {
	case "image/png":
		return bytes.HasPrefix(head, []byte("\x89PNG\r\n\x1a\n"))
	case "image/jpeg":
		return bytes.HasPrefix(head, []byte("\xff\xd8\xff"))
	case "image/gif":
		return bytes.HasPrefix(head, []byte("GIF87a")) || bytes.HasPrefix(head, []byte("GIF89a"))
	case "image/webp":
		return len(head) >= 12 &&
			string(head[0:4]) == "RIFF" &&
			string(head[8:12]) == "WEBP"
	case "application/pdf":
		return bytes.HasPrefix(head, []byte("%PDF-"))
	default:
		return false
	}
}

// dangerousMarkers must never appear in a file declared as an image or PDF.
//
// A polyglot can start with a valid signature and still carry an HTML/SVG
// document the browser would parse once the declared type is no longer
// enforced, so the marker scan closes that gap. Matching is case-insensitive.
var dangerousMarkers = []string{"<!doctype html", "<html", "<script", "<svg"}

// looksLikeMarkup reports whether a byte sample looks like markup.
func looksLikeMarkup(sample []byte) bool {
	for _, b := range sample {
		if isASCIIWhitespace(b) {
			continue
		}
		if b == '<' {
			return true
		}
		break
	}
	lowered := strings.ToLower(string(sample))
	for _, marker := range dangerousMarkers {
		if strings.Contains(lowered, marker) {
			return true
		}
	}
	return false
}

// isASCIIWhitespace matches reference's u8::is_ascii_whitespace: space, horizontal
// tab, line feed, form feed and carriage return (not vertical tab).
func isASCIIWhitespace(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r', '\f':
		return true
	default:
		return false
	}
}

// InspectUpload inspects an upload from its declared metadata and leading
// bytes.
//
// The declared MIME is only a claim: the complete leading bytes decide whether
// it is believable. A file whose content does not match its declared type is
// rejected, which is what stops an executable or an HTML polyglot renamed to
// .png.
func InspectUpload(declaredMIME string, size int64, head []byte) (UploadVerdict, error) {
	mime := strings.ToLower(strings.TrimSpace(declaredMIME))

	if size <= 0 || size > MaxUploadBytes {
		return rejectedVerdict("size_out_of_range"), nil
	}
	if _, allowed := allowedUploadMIME[mime]; !allowed {
		return rejectedVerdict("mime_not_allowed"), nil
	}
	if len(head) == 0 {
		// Without a sample no claim can be verified, so it goes to a human
		// rather than being called clean on trust.
		return UploadVerdict{Decision: ScanNeedsManualReview, ReasonCode: "no_content_sample"}, nil
	}

	if mime == "text/plain" {
		return inspectPlainText(head), nil
	}
	return inspectBinary(mime, head), nil
}

// rejectedVerdict builds a rejection.
func rejectedVerdict(reasonCode string) UploadVerdict {
	return UploadVerdict{Decision: ScanRejected, ReasonCode: reasonCode}
}

// cleanVerdict builds a clean verdict.
func cleanVerdict() UploadVerdict {
	return UploadVerdict{Decision: ScanClean, ReasonCode: "ok"}
}

// inspectBinary inspects a binary upload: no markup markers, a head long enough
// for the complete signature, and the signature itself.
func inspectBinary(mime string, head []byte) UploadVerdict {
	if looksLikeMarkup(head) {
		return rejectedVerdict("dangerous_content")
	}
	if len(head) < signatureLen(mime) {
		return rejectedVerdict("truncated_sample")
	}
	if !hasSignature(mime, head) {
		return rejectedVerdict("magic_mismatch")
	}
	return cleanVerdict()
}

// inspectPlainText inspects a text/plain upload: valid UTF-8, no NUL, and not
// HTML/SVG in disguise.
//
// The sample can end in the middle of a multi-byte character (the reader takes a
// fixed byte budget), which is normal for CJK text. A valid prefix whose only
// defect is an incomplete trailing sequence is accepted; genuinely invalid
// UTF-8 is not.
func inspectPlainText(head []byte) UploadVerdict {
	for _, b := range head {
		if b == 0 {
			return rejectedVerdict("magic_mismatch")
		}
	}

	prefix, ok := validUTF8Prefix(head)
	if !ok {
		return rejectedVerdict("magic_mismatch")
	}
	if looksLikeMarkup(prefix) {
		return rejectedVerdict("dangerous_content")
	}
	return cleanVerdict()
}

// validUTF8Prefix returns the largest valid UTF-8 prefix of sample.
//
// It accepts a sample that ends in the middle of a multi-byte character — the
// normal case for a byte-budgeted sample — and rejects genuinely invalid
// sequences anywhere before the end.
func validUTF8Prefix(sample []byte) ([]byte, bool) {
	if utf8.Valid(sample) {
		return sample, true
	}
	for i := 0; i < len(sample); {
		r, size := utf8.DecodeRune(sample[i:])
		if r == utf8.RuneError && size == 1 {
			// An incomplete sequence at the very end of the sample is the
			// expected artifact of a fixed byte budget.
			if !utf8.FullRune(sample[i:]) {
				return sample[:i], true
			}
			return nil, false
		}
		i += size
	}
	return sample, true
}
