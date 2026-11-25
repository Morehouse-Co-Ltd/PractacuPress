package media

import "regexp"

// sourceAssetPattern finds media asset URLs in a content body. The API serves
// assets at /api/v1/media/{id}; both the relative form and an absolute origin form
// contain that path, so one pattern covers both.
var sourceAssetPattern = regexp.MustCompile(`/api/v1/media/([A-Za-z0-9_-]{1,64})`)

// AssetIDsInSource returns the distinct asset ids referenced by a content body.
//
// It is intentionally a text scan: the body is Markdown or sanitized HTML and the
// media URL is the only stable reference. Unknown ids are ignored by the caller's
// size lookup rather than treated as an error, so stale URLs do not block a save.
func AssetIDsInSource(source string) []string {
	matches := sourceAssetPattern.FindAllStringSubmatch(source, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(matches))
	ids := make([]string, 0, len(matches))
	for _, match := range matches {
		id := match[1]
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}
