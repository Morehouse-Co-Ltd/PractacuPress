package storageadmin

import (
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/practacu/practacu-press/internal/platform/config"
)

func invalid(field, rule, message string) error {
	return &ValidationError{Field: field, Rule: rule, Message: message}
}

// normalizeRequest turns the dashboard payload into a validated Settings,
// carrying a previously saved secret forward when the caller left the field
// blank and did not change the access key.
func normalizeRequest(in UpdateRequest, previous Settings, now time.Time) (Settings, error) {
	maxContentChars := config.DefaultMaxContentSourceChars
	if previous.MaxContentChars > 0 {
		maxContentChars = previous.MaxContentChars
	}
	if in.MaxContentChars != nil {
		maxContentChars = *in.MaxContentChars
	}
	if maxContentChars < 1 || maxContentChars > config.DefaultMaxContentSourceChars {
		return Settings{}, invalid("max_content_chars", "range", "正文长度上限必须在 1 到 1000000 个字符之间")
	}

	mediaLimits := []struct {
		field    string
		label    string
		incoming *int64
		previous int64
	}{
		{"media_user_quota_bytes", "单个用户媒体总量上限", in.MediaUserQuotaBytes, previous.MediaUserQuotaBytes},
		{"media_user_upload_bytes", "单个用户单次媒体上传上限", in.MediaUserUploadBytes, previous.MediaUserUploadBytes},
		{"media_user_article_bytes", "单个用户单次文章额度上限", in.MediaUserArticleBytes, previous.MediaUserArticleBytes},
	}
	mediaValues := make(map[string]int64, len(mediaLimits))
	for _, limit := range mediaLimits {
		value := limit.previous
		if limit.incoming != nil {
			value = *limit.incoming
		}
		if value < 0 || value > MaxMediaLimitBytes {
			return Settings{}, invalid(limit.field, "range", limit.label+"必须在 0 到 4611686018427387904 字节之间（0 表示不限）")
		}
		mediaValues[limit.field] = value
	}
	if len(in.Strategies) == 0 {
		return Settings{}, invalid("strategies", "required", "至少需要一套储存策略")
	}
	if len(in.Strategies) > MaxStrategies {
		return Settings{}, invalid("strategies", "max", fmt.Sprintf("最多允许 %d 套储存策略", MaxStrategies))
	}

	previousByID := make(map[string]Strategy, len(previous.Strategies))
	for _, strategy := range previous.Strategies {
		previousByID[strategy.ID] = strategy
	}

	strategies := make([]Strategy, 0, len(in.Strategies))
	seen := make(map[string]struct{}, len(in.Strategies))
	for index, raw := range in.Strategies {
		id := strings.TrimSpace(raw.ID)
		if id == "" {
			return Settings{}, invalid(fmt.Sprintf("strategies[%d].id", index), "required", "策略 id 不能为空")
		}
		if !strategyIDPattern.MatchString(id) {
			return Settings{}, invalid(fmt.Sprintf("strategies[%d].id", index), "pattern", "策略 id 只能包含小写字母、数字、下划线与连字符")
		}
		if _, exists := seen[id]; exists {
			return Settings{}, invalid(fmt.Sprintf("strategies[%d].id", index), "unique", "策略 id 不能重复")
		}
		seen[id] = struct{}{}

		driver := strings.ToLower(strings.TrimSpace(raw.Driver))
		if driver != config.StorageDriverLocal && driver != config.StorageDriverS3 {
			return Settings{}, invalid(fmt.Sprintf("strategies[%d].driver", index), "enum", "驱动只能是 local 或 s3")
		}
		name := strings.TrimSpace(raw.Name)
		if utf8.RuneCountInString(name) > 40 {
			return Settings{}, invalid(fmt.Sprintf("strategies[%d].name", index), "max_length", "策略名称最多 40 个字符")
		}

		target := Target{
			Driver:      driver,
			LocalDir:    strings.TrimSpace(raw.LocalDir),
			S3Bucket:    strings.Trim(strings.TrimSpace(raw.S3Bucket), "/"),
			S3Prefix:    strings.Trim(strings.TrimSpace(raw.S3Prefix), "/"),
			S3Endpoint:  strings.TrimRight(strings.TrimSpace(raw.S3Endpoint), "/"),
			S3Region:    strings.TrimSpace(raw.S3Region),
			S3AccessKey: strings.TrimSpace(raw.S3AccessKey),
			S3SecretKey: strings.TrimSpace(raw.S3SecretKey),
		}
		if target.Driver == config.StorageDriverLocal {
			if target.LocalDir == "" {
				return Settings{}, invalid(fmt.Sprintf("strategies[%d].local_dir", index), "required", "本地策略必须填写目录")
			}
			target.S3Bucket, target.S3Prefix, target.S3Endpoint, target.S3Region = "", "", "", ""
			target.S3AccessKey, target.S3SecretKey = "", ""
		} else {
			if target.S3Bucket == "" {
				return Settings{}, invalid(fmt.Sprintf("strategies[%d].s3_bucket", index), "required", "云策略必须填写桶名")
			}
			if target.S3Region == "" {
				target.S3Region = "us-east-1"
			}
			if target.S3Endpoint != "" {
				parsed, err := url.Parse(target.S3Endpoint)
				if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
					return Settings{}, invalid(fmt.Sprintf("strategies[%d].s3_endpoint", index), "url", "S3 端点必须是 http(s) 地址")
				}
			}
		}

		// The dashboard never receives the stored credentials, so an omitted access
		// key means "keep the saved one". Only carry the secret forward when the
		// access key did not change; a new access key with no secret is an error.
		if previousStrategy, ok := previousByID[id]; ok && target.Driver == config.StorageDriverS3 {
			if target.S3AccessKey == "" {
				target.S3AccessKey = previousStrategy.S3AccessKey
			}
			if target.S3SecretKey == "" && target.S3AccessKey == previousStrategy.S3AccessKey {
				target.S3SecretKey = previousStrategy.S3SecretKey
			}
		}
		if target.Driver == config.StorageDriverS3 {
			if target.S3AccessKey != "" && target.S3SecretKey == "" {
				return Settings{}, invalid(fmt.Sprintf("strategies[%d].s3_secret_key", index), "required", "填写 Access Key 后必须提供 Secret Key")
			}
			if target.S3AccessKey == "" && target.S3SecretKey != "" {
				return Settings{}, invalid(fmt.Sprintf("strategies[%d].s3_access_key", index), "required", "填写 Secret Key 后必须提供 Access Key")
			}
		}

		strategies = append(strategies, Strategy{ID: id, Name: name, Target: target})
	}

	allocations := make(map[string]Allocation, len(config.StorageScopeNames()))
	for _, scope := range config.StorageScopeNames() {
		raw, provided := in.Allocations[scope]
		if !provided || len(raw.Entries) == 0 {
			primary := strings.TrimSpace(in.Scopes[scope])
			if primary == "" {
				primary = strings.TrimSpace(in.GlobalStrategyID)
			}
			if primary == "" {
				primary = strategies[0].ID
			}
			if _, ok := seen[primary]; !ok {
				return Settings{}, invalid("scopes."+scope, "reference", "用途引用的策略不存在")
			}
			allocations[scope] = singleAllocation(primary)
			continue
		}

		mode := strings.ToLower(strings.TrimSpace(raw.Mode))
		if mode == "" {
			mode = ModeSingle
		}
		if mode != ModeSingle && mode != ModeQuota {
			return Settings{}, invalid("allocations."+scope+".mode", "enum", "分配方式只能是 single 或 quota")
		}
		overflow := strings.ToLower(strings.TrimSpace(raw.Overflow))
		if overflow == "" {
			overflow = OverflowSwitch
		}
		if overflow != OverflowSwitch && overflow != OverflowStop {
			return Settings{}, invalid("allocations."+scope+".overflow", "enum", "写满后的规则只能是 switch 或 stop")
		}
		if len(raw.Entries) > MaxAllocationEntries {
			return Settings{}, invalid("allocations."+scope+".entries", "max", fmt.Sprintf("每个用途最多 %d 套策略", MaxAllocationEntries))
		}

		entries := make([]AllocationEntry, 0, len(raw.Entries))
		entrySeen := make(map[string]struct{}, len(raw.Entries))
		for index, item := range raw.Entries {
			id := strings.TrimSpace(item.StrategyID)
			if _, ok := seen[id]; !ok {
				return Settings{}, invalid(fmt.Sprintf("allocations.%s.entries[%d].strategy_id", scope, index), "reference", "引用的策略不存在")
			}
			if _, dup := entrySeen[id]; dup {
				return Settings{}, invalid(fmt.Sprintf("allocations.%s.entries[%d].strategy_id", scope, index), "unique", "同一用途不能重复引用同一套策略")
			}
			entrySeen[id] = struct{}{}
			quota := item.QuotaGB
			if quota < 0 || quota > MaxQuotaGB {
				return Settings{}, invalid(fmt.Sprintf("allocations.%s.entries[%d].quota_gb", scope, index), "range", fmt.Sprintf("容量上限必须在 0 到 %d GB 之间", MaxQuotaGB))
			}
			entries = append(entries, AllocationEntry{StrategyID: id, QuotaGB: quota})
		}
		allocations[scope] = Allocation{Mode: mode, Entries: entries, Overflow: overflow}
	}

	globalID := strings.TrimSpace(in.GlobalStrategyID)
	if globalID == "" {
		firstScope := config.StorageScopeNames()[0]
		globalID = allocations[firstScope].Entries[0].StrategyID
	}
	if _, ok := seen[globalID]; !ok {
		return Settings{}, invalid("global_strategy_id", "reference", "全局策略不存在")
	}

	scopes := make(map[string]string, len(allocations))
	for scope, allocation := range allocations {
		scopes[scope] = allocation.Entries[0].StrategyID
	}

	return Settings{
		Version:               settingsVersion,
		UpdatedAt:             now,
		MaxContentChars:       maxContentChars,
		MediaUserQuotaBytes:   mediaValues["media_user_quota_bytes"],
		MediaUserUploadBytes:  mediaValues["media_user_upload_bytes"],
		MediaUserArticleBytes: mediaValues["media_user_article_bytes"],
		GlobalStrategyID:      globalID,
		Strategies:            strategies,
		Scopes:                scopes,
		Allocations:           allocations,
	}, nil
}

// validateSettings re-checks a persisted document without inventing defaults: a
// corrupted data file must fail loudly rather than silently serve the wrong bucket.
func validateSettings(settings Settings) error {
	if settings.Version != settingsVersion {
		return fmt.Errorf("storage settings version %d is not supported", settings.Version)
	}
	in := UpdateRequest{
		MaxContentChars:       &settings.MaxContentChars,
		MediaUserQuotaBytes:   &settings.MediaUserQuotaBytes,
		MediaUserUploadBytes:  &settings.MediaUserUploadBytes,
		MediaUserArticleBytes: &settings.MediaUserArticleBytes,
		GlobalStrategyID:      settings.GlobalStrategyID,
		Strategies:            make([]StrategyInput, 0, len(settings.Strategies)),
		Scopes:                settings.Scopes,
		Allocations:           make(map[string]AllocationInput, len(settings.Allocations)),
	}
	for _, strategy := range settings.Strategies {
		in.Strategies = append(in.Strategies, StrategyInput{
			ID: strategy.ID, Name: strategy.Name, Driver: strategy.Driver,
			LocalDir: strategy.LocalDir, S3Bucket: strategy.S3Bucket, S3Prefix: strategy.S3Prefix,
			S3Endpoint: strategy.S3Endpoint, S3Region: strategy.S3Region,
			S3AccessKey: strategy.S3AccessKey, S3SecretKey: strategy.S3SecretKey,
		})
	}
	for scope, allocation := range settings.Allocations {
		entries := make([]AllocationEntryInput, 0, len(allocation.Entries))
		for _, entry := range allocation.Entries {
			entries = append(entries, AllocationEntryInput{StrategyID: entry.StrategyID, QuotaGB: entry.QuotaGB})
		}
		in.Allocations[scope] = AllocationInput{Mode: allocation.Mode, Entries: entries, Overflow: allocation.Overflow}
	}
	_, err := normalizeRequest(in, Settings{}, settings.UpdatedAt)
	return err
}
