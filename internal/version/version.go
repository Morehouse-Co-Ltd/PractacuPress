// Package version implements the single version scheme Practacu Press uses.
//
// There are exactly two kinds of release: a stable version (MAJOR.MINOR.PATCH)
// and a beta (MAJOR.MINOR.PATCH-beta or MAJOR.MINOR.PATCH-beta.N). Comparisons
// never parse strings at call sites: Parse assigns the integer VersionCode and
// every comparison uses it. web/src/lib/version.ts implements the same rules and
// the two must stay in sync.
package version

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Channel is the release channel of a version.
type Channel string

const (
	// Stable is a production release: MAJOR.MINOR.PATCH.
	Stable Channel = "stable"
	// Beta is a pre-release: MAJOR.MINOR.PATCH-beta[.N].
	Beta Channel = "beta"
)

// Info is the canonical description of one build.
type Info struct {
	// Version is the canonical version without a leading v: 0.1.2 or 0.1.2-beta.2.
	Version string `json:"version"`
	Channel Channel `json:"channel"`
	// Code is the monotonically comparable integer form of Version.
	Code int `json:"version_code"`
}

// Limits keep VersionCode within the documented decimal layout.
const (
	maxMajor = 999
	maxMinor = 99
	maxPatch = 99
	maxBeta  = 98
	stableSt = 99
)

var pattern = regexp.MustCompile(`^[vV]?(\d{1,3})\.(\d{1,2})\.(\d{1,2})(?:-beta(?:[.-]?(\d{1,2}))?)?$`)

// ErrInvalidVersion is returned by Parse for anything outside the scheme.
var ErrInvalidVersion = errors.New("version: invalid version")

// Parse accepts the documented inputs and returns the canonical Info.
//
// Accepted: 1.2.3, v1.2.3, V1.2.3, 0.1.2-beta, 0.1.2-beta1, 0.1.2-beta.1,
// 0.1.2-beta.02. A bare -beta is beta 1. Everything else is rejected.
func Parse(raw string) (Info, error) {
	value := strings.TrimSpace(raw)
	match := pattern.FindStringSubmatch(value)
	if match == nil {
		return Info{}, fmt.Errorf("%w: %q", ErrInvalidVersion, raw)
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	patch, _ := strconv.Atoi(match[3])
	if major > maxMajor || minor > maxMinor || patch > maxPatch {
		return Info{}, fmt.Errorf("%w: %q (minor/patch must be <= 99)", ErrInvalidVersion, raw)
	}

	beta := 0
	if strings.Contains(strings.ToLower(value), "-beta") {
		beta = 1
		if match[4] != "" {
			beta, _ = strconv.Atoi(match[4])
		}
		if beta < 1 || beta > maxBeta {
			return Info{}, fmt.Errorf("%w: %q (beta number must be 1..98)", ErrInvalidVersion, raw)
		}
	}

	canonical := fmt.Sprintf("%d.%d.%d", major, minor, patch)
	stage := stableSt
	channel := Stable
	if beta > 0 {
		channel = Beta
		stage = beta
		canonical = fmt.Sprintf("%s-beta", canonical)
		if beta > 1 {
			canonical = fmt.Sprintf("%s.%d", canonical, beta)
		}
	}
	return Info{
		Version: canonical,
		Channel: channel,
		Code:    major*1_000_000 + minor*10_000 + patch*100 + stage,
	}, nil
}

// VersionCode returns the integer form of a version string, or 0 when invalid.
func VersionCode(raw string) int {
	info, err := Parse(raw)
	if err != nil {
		return 0
	}
	return info.Code
}

// Compare orders two Info values: a > b returns a positive number.
func Compare(a, b Info) int {
	switch {
	case a.Code > b.Code:
		return 1
	case a.Code < b.Code:
		return -1
	default:
		return 0
	}
}

// String renders the canonical version, e.g. 0.1.2-beta.2.
func (i Info) String() string { return i.Version }

// Label renders the display form with a leading v.
func (i Info) Label() string { return "v" + i.Version }

// IsZero reports whether the Info is the zero value.
func (i Info) IsZero() bool { return i.Version == "" }

// Dev is the placeholder used by development builds without a version manifest.
func Dev() Info {
	return Info{Version: "0.0.0", Channel: Stable, Code: 99}
}
