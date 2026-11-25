package securitygo

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

// Complete leading bytes, as an on-disk file of each type starts.
var (
	pngMagic   = []byte("\x89PNG\r\n\x1a\n")
	gif87Magic = []byte("GIF87a")
	gif89Magic = []byte("GIF89a")
	jpegMagic  = []byte("\xff\xd8\xff\xe0\x00\x10JFIF")
	webpMagic  = []byte("RIFF____WEBPVP8")
	pdfMagic   = []byte("%PDF-1.7\n")
)

func requireDecision(t *testing.T, mime string, size int64, head []byte, decision ScanDecision, reason string) {
	t.Helper()
	verdict, err := InspectUpload(mime, size, head)
	require.NoError(t, err)
	require.Equal(t, decision, verdict.Decision, "mime %s reason %s", mime, verdict.ReasonCode)
	require.Equal(t, reason, verdict.ReasonCode, "mime %s", mime)
}

func TestUploadAcceptsCompleteSignaturesForEveryBinaryType(t *testing.T) {
	cases := []struct {
		mime string
		head []byte
	}{
		{"image/png", pngMagic},
		{"image/gif", gif87Magic},
		{"image/gif", gif89Magic},
		{"image/jpeg", jpegMagic},
		{"image/webp", webpMagic},
		{"application/pdf", pdfMagic},
	}
	for _, tc := range cases {
		requireDecision(t, tc.mime, 1024, tc.head, ScanClean, "ok")
	}
}

func TestUploadAcceptsMatchingMagicWithAFullFileHead(t *testing.T) {
	head := append([]byte{}, pngMagic...)
	head = append(head, 0x00, 0x00, 0x00, 0x0D, 'I', 'H', 'D', 'R')
	requireDecision(t, "image/png", 1024, head, ScanClean, "ok")
}

func TestUploadRejectsExecutableDisguisedAsImage(t *testing.T) {
	exe := []byte("MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00")
	requireDecision(t, "image/png", 1024, exe, ScanRejected, "magic_mismatch")
}

func TestUploadRejectsDisallowedMIMEs(t *testing.T) {
	for _, mime := range []string{
		"application/x-msdownload",
		"image/svg+xml",
		"text/html",
		"application/x-sh",
	} {
		requireDecision(t, mime, 10, pngMagic, ScanRejected, "mime_not_allowed")
	}
}

func TestUploadAcceptsPDFAndPlainText(t *testing.T) {
	requireDecision(t, "application/pdf", 10, pdfMagic, ScanClean, "ok")
	requireDecision(t, "text/plain", 10, []byte("hello"), ScanClean, "ok")
	requireDecision(t, "text/plain", 10, []byte("第一段中文正文"), ScanClean, "ok")
}

func TestUploadRejectsBinaryDeclaredAsText(t *testing.T) {
	for _, head := range [][]byte{{0x00, 0x01}, {0xFF, 0xFE}, {0xC3, 0x28}} {
		verdict, err := InspectUpload("text/plain", 10, head)
		require.NoError(t, err)
		require.Equal(t, ScanRejected, verdict.Decision, "head %02X", head)
		require.Equal(t, "magic_mismatch", verdict.ReasonCode, "head %02X", head)
	}
}

func TestUploadAcceptsTextWhoseHeadCutAMultibyteCharacter(t *testing.T) {
	// The reader samples a fixed byte budget, so a CJK text file routinely ends
	// the sample in the middle of a character. That must not look like binary.
	text := strings.Repeat("中文测试正文", 200)
	bytes := []byte(text)
	for _, cut := range []int{511, 512, 385} {
		head := bytes[:cut]
		require.False(t, utf8.Valid(head), "cut %d should split a character", cut)
		requireDecision(t, "text/plain", int64(len(bytes)), head, ScanClean, "ok")
	}
}

func TestUploadRejectsEmpty(t *testing.T) {
	requireDecision(t, "image/png", 0, pngMagic, ScanRejected, "size_out_of_range")
	requireDecision(t, "image/png", -1, pngMagic, ScanRejected, "size_out_of_range")
}

// TestUploadAcceptsVideoContainers covers the containers article media now
// accepts. Size is a storage-settings policy, not a security verdict, so a large
// video is clean here as long as its signature matches.
func TestUploadAcceptsVideoContainers(t *testing.T) {
	mp4 := []byte("\x00\x00\x00\x18ftypisom")
	webm := []byte{0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88}
	requireDecision(t, "video/mp4", 1<<30, mp4, ScanClean, "ok")
	requireDecision(t, "video/webm", 1<<30, webm, ScanClean, "ok")
	requireDecision(t, "video/mp4", 1024, []byte("not-an-mp4"), ScanRejected, "magic_mismatch")
	requireDecision(t, "video/quicktime", 1024, mp4, ScanRejected, "mime_not_allowed")
}

func TestUploadWithoutASampleAsksAHuman(t *testing.T) {
	requireDecision(t, "image/png", 1024, nil, ScanNeedsManualReview, "no_content_sample")
}

func TestUploadWEBPNeedsBothMarkers(t *testing.T) {
	requireDecision(t, "image/webp", 20, webpMagic, ScanClean, "ok")
	requireDecision(t, "image/webp", 20, []byte("RIFF____XXXX"), ScanRejected, "magic_mismatch")
}

func TestUploadIgnoresDeclaredCaseAndSpacing(t *testing.T) {
	requireDecision(t, "  IMAGE/PNG ", 10, pngMagic, ScanClean, "ok")
}

func TestUploadRejectsTruncatedHeads(t *testing.T) {
	cases := []struct {
		mime string
		head []byte
	}{
		{"image/png", pngMagic[:len(pngMagic)-1]},
		{"image/jpeg", jpegMagic[:2]},
		{"image/gif", gif89Magic[:len(gif89Magic)-1]},
		{"application/pdf", pdfMagic[:4]},
		{"image/webp", webpMagic[:11]},
	}
	for _, tc := range cases {
		requireDecision(t, tc.mime, 1024, tc.head, ScanRejected, "truncated_sample")
	}
}

func TestUploadRejectsMislabelledBinaryTypes(t *testing.T) {
	cases := []struct {
		mime string
		head []byte
	}{
		{"image/png", []byte("GIF89a\x01\x00\x01\x00\x00\x00\x00")},
		{"image/gif", []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")},
		{"image/jpeg", []byte("RIFF\x24\x00\x00\x00WEBPVP8 ")},
		{"image/webp", []byte("\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01")},
		{"application/pdf", []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR")},
	}
	for _, tc := range cases {
		requireDecision(t, tc.mime, 1024, tc.head, ScanRejected, "magic_mismatch")
	}
}

func TestUploadRejectsHTMLDisguisedAsEveryBinaryType(t *testing.T) {
	heads := [][]byte{
		[]byte("<html><body>click</body></html>"),
		[]byte("  \n<!DOCTYPE html><script>alert(1)</script>"),
		[]byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">`),
	}
	for _, head := range heads {
		for _, mime := range []string{
			"image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
		} {
			requireDecision(t, mime, 1024, head, ScanRejected, "dangerous_content")
		}
	}
}

func TestUploadRejectsSignaturePrefixedPolyglots(t *testing.T) {
	polyglots := []struct {
		mime string
		head []byte
	}{
		{"image/png", append(append([]byte{}, pngMagic...), []byte("<!doctype html><script>alert(1)</script>")...)},
		{"image/gif", append(append([]byte{}, gif89Magic...), []byte(`<svg onload="alert(1)">`)...)},
		{"image/jpeg", append(append([]byte{}, jpegMagic...), []byte("<script>alert(1)</script>")...)},
		{"image/webp", append(append([]byte{}, webpMagic...), []byte("<html><body>pwned</body></html>")...)},
		{"application/pdf", append(append([]byte{}, pdfMagic...), []byte("<html><script>alert(1)</script>")...)},
	}
	for _, tc := range polyglots {
		requireDecision(t, tc.mime, 1024, tc.head, ScanRejected, "dangerous_content")
	}
}

func TestUploadRejectsHTMLAndSVGDeclaredAsText(t *testing.T) {
	heads := [][]byte{
		[]byte("<html><body>x</body></html>"),
		[]byte("   <script>alert(1)</script>"),
		[]byte(`<svg xmlns="http://www.w3.org/2000/svg">`),
		[]byte("hello <!DOCTYPE html>"),
	}
	for _, head := range heads {
		requireDecision(t, "text/plain", 20, head, ScanRejected, "dangerous_content")
	}
}

func TestUploadPlainTextMentioningAngleBracketsIsStillText(t *testing.T) {
	requireDecision(t, "text/plain", 20, []byte("if a < b then done\n"), ScanClean, "ok")
}

func TestValidUTF8Prefix(t *testing.T) {
	prefix, ok := validUTF8Prefix([]byte("abc\xe4\xb8"))
	require.True(t, ok)
	require.Equal(t, []byte("abc"), prefix)

	_, ok = validUTF8Prefix([]byte("abc\xe4X"))
	require.False(t, ok)

	prefix, ok = validUTF8Prefix([]byte("plain ascii"))
	require.True(t, ok)
	require.Equal(t, "plain ascii", string(prefix))
}
