package version

import (
	"errors"
	"os"
	"testing"
)

func TestParseCanonical(t *testing.T) {
	cases := []struct {
		in      string
		version string
		channel Channel
		code    int
	}{
		{"0.1.2", "0.1.2", Stable, 10299},
		{"v0.1.2", "0.1.2", Stable, 10299},
		{"V1.0.0", "1.0.0", Stable, 1000099},
		{"0.1.2-beta", "0.1.2-beta", Beta, 10201},
		{"0.1.2-beta1", "0.1.2-beta", Beta, 10201},
		{"0.1.2-beta.1", "0.1.2-beta", Beta, 10201},
		{"v0.1.2-beta.02", "0.1.2-beta.2", Beta, 10202},
		{"0.1.2-beta.98", "0.1.2-beta.98", Beta, 10298},
		{" 0.2.0 ", "0.2.0", Stable, 20099},
		{"0.1.99", "0.1.99", Stable, 19999},
	}
	for _, tc := range cases {
		got, err := Parse(tc.in)
		if err != nil {
			t.Fatalf("Parse(%q): %v", tc.in, err)
		}
		if got.Version != tc.version || got.Channel != tc.channel || got.Code != tc.code {
			t.Fatalf("Parse(%q) = %+v, want %s/%s/%d", tc.in, got, tc.version, tc.channel, tc.code)
		}
	}
}

func TestParseRejects(t *testing.T) {
	bad := []string{
		"", "1.2", "1.2.3.4", "1.2.3-rc1", "1.2.3-alpha",
		"1.2.3-beta.0", "1.2.3-beta.99", "1.100.0", "1.2.100",
		"1.2.3+build", "x1.2.3", "1.2.3-beta.x", "1.2.3-beta1.2",
	}
	for _, in := range bad {
		if _, err := Parse(in); err == nil {
			t.Fatalf("Parse(%q) accepted an invalid version", in)
		} else if !errors.Is(err, ErrInvalidVersion) {
			t.Fatalf("Parse(%q) error = %v, want ErrInvalidVersion", in, err)
		}
	}
}

func TestCompare(t *testing.T) {
	b, _ := Parse("0.1.2-beta.2")
	beta1, _ := Parse("0.1.2-beta")
	stable, _ := Parse("0.1.2")
	nextMinor, _ := Parse("0.2.0-beta")
	patch99, _ := Parse("0.1.99")

	if Compare(beta1, b) >= 0 || Compare(b, beta1) <= 0 {
		t.Fatal("beta.2 must be newer than beta")
	}
	if Compare(b, stable) >= 0 {
		t.Fatal("stable must be newer than its betas")
	}
	if Compare(patch99, nextMinor) >= 0 {
		t.Fatal("0.1.99 must be older than 0.2.0-beta")
	}
	if Compare(stable, stable) != 0 {
		t.Fatal("identical versions must compare equal")
	}
	if got, _ := Parse("0.1.2-beta1"); Compare(got, beta1) != 0 {
		t.Fatal("-beta and -beta.1 must be the same version")
	}
}

func TestParseManifest(t *testing.T) {
	valid := []byte(`{"title":"Practacu Press","describe":"站点","version":"0.1.2-beta","channel":"beta","version_code":10201}`)
	info, manifest, err := ParseManifest(valid)
	if err != nil {
		t.Fatalf("ParseManifest: %v", err)
	}
	if info.Code != 10201 || manifest.Channel != Beta {
		t.Fatalf("unexpected manifest: %+v %+v", info, manifest)
	}

	legacy := []byte(`{"title":"Practacu Press","describe":"站点","version":"0.1.2","style":"stable"}`)
	info, _, err = ParseManifest(legacy)
	if err != nil || info.Code != 10299 {
		t.Fatalf("legacy manifest: %+v %v", info, err)
	}

	bad := []string{
		`{"title":"","describe":"x","version":"0.1.2"}`,
		`{"title":"x","describe":"","version":"0.1.2"}`,
		`{"title":"x","describe":"y","version":"0.1.2","version_code":10298}`,
		`{"title":"x","describe":"y","version":"0.1.2-beta","channel":"stable"}`,
		`{"title":"x","describe":"y","version":"0.1.2","channel":"nightly"}`,
		`not json`,
	}
	for _, data := range bad {
		if _, _, err := ParseManifest([]byte(data)); err == nil {
			t.Fatalf("ParseManifest accepted %s", data)
		}
	}
}

func TestLoadFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/version.json"
	if err := os.WriteFile(path, []byte(`{"title":"t","describe":"d","version":"1.0.0","channel":"stable","version_code":1000099}`), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}
	if info.Label() != "v1.0.0" || info.Code != 1000099 {
		t.Fatalf("unexpected info: %+v", info)
	}
}
