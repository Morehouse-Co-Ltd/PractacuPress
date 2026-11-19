package site

import "testing"

func TestCustomizationETag(t *testing.T) {
	a := customizationETag(3, []byte(`{"home":{"blocks":[]}}`))
	b := customizationETag(3, []byte(`{"home":{"blocks":[]}}`))
	c := customizationETag(4, []byte(`{"home":{"blocks":[]}}`))
	d := customizationETag(3, []byte(`{"home":{"blocks":[{"id":"x"}]}}`))

	if a != b {
		t.Fatal("the same revision and document must produce the same ETag")
	}
	if a == c || a == d {
		t.Fatal("a different revision or document must produce a different ETag")
	}
	if a[0] != '"' || a[len(a)-1] != '"' {
		t.Fatalf("ETag must be quoted, got %q", a)
	}
}

func TestIfNoneMatchHit(t *testing.T) {
	etag := `"abc"`
	cases := map[string]bool{
		`"abc"`:        true,
		`"zzz", "abc"`: true,
		`W/"abc"`:      false,
		`*`:            true,
		``:             false,
		`"abcd"`:       false,
	}
	for header, want := range cases {
		if got := ifNoneMatchHit(header, etag); got != want {
			t.Fatalf("ifNoneMatchHit(%q) = %v, want %v", header, got, want)
		}
	}
}
