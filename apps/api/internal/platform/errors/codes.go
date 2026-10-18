package apperr

import (
	"net/http"
	"sort"
)

// Code is a stable, machine readable error identifier.
//
// Clients branch on Code, never on Message: Message is localised and may change.
type Code string

// The complete set of error codes the API can return.
const (
	CodeValidationFailed       Code = "validation_failed"
	CodeUnauthenticated        Code = "unauthenticated"
	CodePermissionDenied       Code = "permission_denied"
	CodeNotFound               Code = "not_found"
	CodeConflict               Code = "conflict"
	CodeRateLimited            Code = "rate_limited"
	CodeInternal               Code = "internal"
	CodeInvalidCursor          Code = "invalid_cursor"
	CodeIdempotencyKeyReuse    Code = "idempotency_key_reuse"
	CodeSiteNotFound           Code = "site_not_found"
	CodeSiteDomainUnverified   Code = "site_domain_unverified"
	CodeContentStateInvalid    Code = "content_state_invalid"
	CodeSecurityUnavailable    Code = "security_unavailable"
	CodeProviderNotConfigured  Code = "provider_not_configured"
	CodeInvalidDatabaseDriver  Code = "invalid_database_driver"
)

// spec is the fixed HTTP projection of a code. Keeping it in one table is what
// makes status codes consistent across the whole API.
type spec struct {
	status  int
	title   string
	message string
}

var specs = map[Code]spec{
	CodeValidationFailed: {
		status:  http.StatusBadRequest,
		title:   "Validation failed",
		message: "请求参数不符合要求",
	},
	CodeUnauthenticated: {
		status:  http.StatusUnauthorized,
		title:   "Unauthenticated",
		message: "请先登录",
	},
	CodePermissionDenied: {
		status:  http.StatusForbidden,
		title:   "Permission denied",
		message: "当前用户没有执行此操作的权限",
	},
	CodeNotFound: {
		status:  http.StatusNotFound,
		title:   "Not found",
		message: "请求的资源不存在",
	},
	CodeConflict: {
		status:  http.StatusConflict,
		title:   "Conflict",
		message: "资源状态冲突",
	},
	CodeRateLimited: {
		status:  http.StatusTooManyRequests,
		title:   "Rate limited",
		message: "请求过于频繁，请稍后重试",
	},
	CodeInternal: {
		status:  http.StatusInternalServerError,
		title:   "Internal error",
		message: "服务器内部错误",
	},
	CodeInvalidCursor: {
		status:  http.StatusBadRequest,
		title:   "Invalid cursor",
		message: "分页游标无效",
	},
	CodeIdempotencyKeyReuse: {
		status:  http.StatusConflict,
		title:   "Idempotency key reuse",
		message: "相同的幂等键已用于不同的请求内容",
	},
	CodeSiteNotFound: {
		status:  http.StatusNotFound,
		title:   "Site not found",
		message: "站点不存在",
	},
	CodeSiteDomainUnverified: {
		status:  http.StatusForbidden,
		title:   "Site domain unverified",
		message: "站点域名尚未通过验证",
	},
	CodeContentStateInvalid: {
		status:  http.StatusConflict,
		title:   "Invalid content state",
		message: "当前内容状态不允许该操作",
	},
	CodeSecurityUnavailable: {
		status:  http.StatusServiceUnavailable,
		title:   "Security check unavailable",
		message: "安全检查服务暂不可用，请稍后重试",
	},
	CodeProviderNotConfigured: {
		status:  http.StatusConflict,
		title:   "Provider not configured",
		message: "该登录方式尚未配置",
	},
	CodeInvalidDatabaseDriver: {
		status:  http.StatusInternalServerError,
		title:   "Invalid database driver",
		message: "数据库驱动配置无效",
	},
}

// AllCodes returns every error code the API can emit.
//
// It exists so contract tests can prove the documented enum and the implementation
// stay in step; a code that is added here without a document entry fails the build.
func AllCodes() []Code {
	codes := make([]Code, 0, len(specs))
	for code := range specs {
		codes = append(codes, code)
	}
	sort.Slice(codes, func(i, j int) bool { return codes[i] < codes[j] })
	return codes
}