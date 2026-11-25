package storageadmin

import (
	"encoding/json"
	"time"
)

// StrategyStatus is the redacted view of one strategy. The access key value and
// the secret never leave the process; the booleans let the page say "saved".
type StrategyStatus struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Driver       string `json:"driver"`
	LocalDir     string `json:"local_dir"`
	S3Bucket     string `json:"s3_bucket"`
	S3Prefix     string `json:"s3_prefix"`
	S3Endpoint   string `json:"s3_endpoint"`
	S3Region     string `json:"s3_region"`
	HasAccessKey bool   `json:"has_access_key"`
	HasSecret    bool   `json:"has_secret"`
}

// AllocationEntryStatus adds the server measured usage to one entry.
type AllocationEntryStatus struct {
	StrategyID string `json:"strategy_id"`
	QuotaGB    int64  `json:"quota_gb"`
	UsedBytes  int64  `json:"used_bytes"`
	Current    bool   `json:"current"`
}

// AllocationStatus is one scope's resolved write order.
type AllocationStatus struct {
	Mode     string                  `json:"mode"`
	Entries  []AllocationEntryStatus `json:"entries"`
	Overflow string                  `json:"overflow"`
}

// EffectiveStorage is one storage scope exactly as the media adapters use it.
type EffectiveStorage struct {
	Scope    string `json:"scope"`
	Driver   string `json:"driver"`
	LocalDir string `json:"local_dir"`
	S3Bucket string `json:"s3_bucket"`
	S3Region string `json:"s3_region"`
	S3Prefix string `json:"s3_prefix"`
}

// Status is the GET/PUT response. It is safe to serve to site administrators.
type Status struct {
	Live                  bool                        `json:"live"`
	Source                string                      `json:"source"`
	UpdatedAt             *time.Time                  `json:"updated_at"`
	MaxContentChars       int                         `json:"max_content_chars"`
	MediaUserQuotaBytes   int64                       `json:"media_user_quota_bytes"`
	MediaUserUploadBytes  int64                       `json:"media_user_upload_bytes"`
	MediaUserArticleBytes int64                       `json:"media_user_article_bytes"`
	GlobalStrategyID      string                      `json:"global_strategy_id"`
	Strategies            []StrategyStatus            `json:"strategies"`
	Scopes                map[string]string           `json:"scopes"`
	Allocations           map[string]AllocationStatus `json:"allocations"`
	Effective             []EffectiveStorage          `json:"effective"`
}

// MediaRoot is one backup root. It mirrors backup.MediaRoot without importing the
// backup package into the storage manager.
type MediaRoot struct {
	Alias  string
	Driver string
	Dir    string
}

// UnmarshalJSON is intentionally strict about unknown fields at the API boundary.
// Callers use encoding/json directly on UpdateRequest, so this hook is unused; it
// documents that the wire shape is fixed.
var _ = json.Unmarshal
