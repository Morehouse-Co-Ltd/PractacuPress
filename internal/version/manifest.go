package version

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
)

// Manifest mirrors web/public/version.json. Channel and VersionCode are the
// canonical fields; Style is accepted only for older manifests.
type Manifest struct {
	Title    string  `json:"title"`
	Describe string  `json:"describe"`
	Version  string  `json:"version"`
	Channel  Channel `json:"channel,omitempty"`
	Style    string  `json:"style,omitempty"`
	Code     int     `json:"version_code,omitempty"`
}

// ErrInvalidManifest is returned when a version manifest is incomplete or its
// integer version does not match its version string.
var ErrInvalidManifest = fmt.Errorf("%w: invalid version manifest", ErrInvalidVersion)

// ParseManifest decodes and validates a version manifest. Fail-closed: a
// corrupted manifest can never be reported as "up to date".
func ParseManifest(data []byte) (Info, Manifest, error) {
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Info{}, Manifest{}, fmt.Errorf("%w: %v", ErrInvalidManifest, err)
	}
	info, err := Parse(manifest.Version)
	if err != nil {
		return Info{}, Manifest{}, fmt.Errorf("%w: %v", ErrInvalidManifest, err)
	}
	if manifest.Title == "" || manifest.Describe == "" {
		return Info{}, Manifest{}, fmt.Errorf("%w: title and describe are required", ErrInvalidManifest)
	}

	channel := manifest.Channel
	if channel == "" {
		// Older manifests used style: stable|beta|local.
		switch manifest.Style {
		case string(Beta):
			channel = Beta
		default:
			channel = Stable
		}
	}
	if channel != Stable && channel != Beta {
		return Info{}, Manifest{}, fmt.Errorf("%w: unsupported channel %q", ErrInvalidManifest, channel)
	}
	if channel != info.Channel {
		return Info{}, Manifest{}, fmt.Errorf(
			"%w: channel %q does not match version %q", ErrInvalidManifest, channel, info.Version)
	}
	if manifest.Code != 0 && manifest.Code != info.Code {
		return Info{}, Manifest{}, fmt.Errorf(
			"%w: version_code %d does not match %q (%d)",
			ErrInvalidManifest, manifest.Code, info.Version, info.Code)
	}
	return info, manifest, nil
}

// LoadFS reads version.json from fsys (usually the embedded frontend dist).
func LoadFS(fsys fs.FS, name string) (Info, error) {
	if fsys == nil {
		return Info{}, fmt.Errorf("%w: no filesystem", ErrInvalidManifest)
	}
	data, err := fs.ReadFile(fsys, path.Clean(name))
	if err != nil {
		return Info{}, err
	}
	info, _, err := ParseManifest(data)
	return info, err
}

// LoadFile reads a version manifest from disk.
func LoadFile(name string) (Info, error) {
	data, err := os.ReadFile(name)
	if err != nil {
		return Info{}, err
	}
	info, _, err := ParseManifest(data)
	return info, err
}
