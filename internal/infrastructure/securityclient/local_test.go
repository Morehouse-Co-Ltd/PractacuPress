package securityclient

import (
	"context"
	"testing"
)

func TestLocalRunsTheSecurityPolicyInProcess(t *testing.T) {
	client := NewLocal()
	ctx := context.Background()

	hash, err := client.HashPassword(ctx, "correct horse battery")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	matches, err := client.VerifyPassword(ctx, "correct horse battery", hash)
	if err != nil || !matches {
		t.Fatalf("VerifyPassword = %v, %v", matches, err)
	}

	sanitized, err := client.SanitizeContent(ctx, ContentInput{
		Format: FormatHTML,
		Source: `<h1>Hello</h1><script>alert(1)</script>`,
	})
	if err != nil {
		t.Fatalf("SanitizeContent: %v", err)
	}
	if sanitized.HTML == "" || sanitized.PolicyVersion == "" {
		t.Fatalf("sanitized result is incomplete: %+v", sanitized)
	}
	if containsScript(sanitized.HTML) {
		t.Fatalf("sanitized HTML still contains a script: %s", sanitized.HTML)
	}

	scan, err := client.InspectUpload(ctx, UploadInput{
		FileName:     "pixel.png",
		DeclaredMIME: "image/png",
		Size:         8,
		Content:      []byte("\x89PNG\r\n\x1a\n"),
	})
	if err != nil || scan.Status != ScanClean {
		t.Fatalf("InspectUpload = %+v, %v", scan, err)
	}
	if err := client.Ping(ctx); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

func containsScript(html string) bool {
	for i := 0; i+8 <= len(html); i++ {
		if html[i:i+8] == "<script>" {
			return true
		}
	}
	return false
}
