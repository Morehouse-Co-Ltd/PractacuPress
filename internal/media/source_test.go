package media

import (
	"reflect"
	"testing"
)

func TestAssetIDsInSource(t *testing.T) {
	source := `<p><img src="/api/v1/media/ast_1" /></p>` +
		`<video src="https://example.test/api/v1/media/ast_2"></video>` +
		`<p>repeat /api/v1/media/ast_1 and /media/not-an-asset</p>`

	got := AssetIDsInSource(source)
	want := []string{"ast_1", "ast_2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("AssetIDsInSource() = %v, want %v", got, want)
	}
	if ids := AssetIDsInSource("no media here"); ids != nil {
		t.Fatalf("AssetIDsInSource(no media) = %v, want nil", ids)
	}
}
