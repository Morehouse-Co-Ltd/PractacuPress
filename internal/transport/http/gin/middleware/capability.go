package middleware

import (
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/internal/site"
)

// requiredCapability maps a protected request to the capability that authorizes it.
//
// The matrix has to be enforced by the server, not only by the dashboard. Rather
// than duplicate a check inside every module, the guard classifies the request
// with the same vocabulary the dashboard uses. A route with no rule keeps the
// module's own role check: member-level surfaces such as comments, bookmarks and
// messages must stay usable by anyone, and they never required a dashboard
// capability.
func requiredCapability(c *gin.Context) (site.Capability, bool) {
	path := c.FullPath()
	if path == "" {
		path = c.Request.URL.Path
	}
	trimmed := strings.TrimPrefix(path, "/api/v1")
	segments := splitPath(trimmed)
	if len(segments) == 0 {
		return "", false
	}
	method := c.Request.Method

	// Site administration surface.
	if segments[0] == "sites" && len(segments) >= 3 {
		rest := segments[2:]
		switch rest[0] {
		case "members":
			return site.CapabilityManageMember, true
		case "permission-groups":
			// Reading the matrix is needed by every signed-in member so the
			// dashboard can hide what its group cannot do; writing it is the
			// privileged action.
			if method == "GET" {
				return "", false
			}
			return site.CapabilityManagePermission, true
		case "settings", "customization", "site-config", "domain":
			return site.CapabilityManageSite, true
		case "audit-logs", "activity":
			// Reading the ledger and the dashboard feed is one capability. The
			// service checks it too, so the two layers can never disagree about
			// who may see a site's audit trail.
			return site.CapabilityViewLog, true
		case "analytics":
			// 访问洞察 is a read model over the same traffic records as the audit
			// trail: view_log admits it, and the analytics service re-checks the
			// same capability for defence in depth.
			return site.CapabilityViewLog, true
		case "redirects", "newsletter":
			return site.CapabilityManageSite, true
		}
		return "", false
	}

	switch segments[0] {
	case "audit-logs":
		return site.CapabilityViewLog, true
	case "articles", "posts":
		if method == "GET" && len(segments) == 1 {
			return "", false
		}
		if len(segments) >= 3 && method == "POST" {
			switch segments[len(segments)-1] {
			case "publish", "reject", "archive":
				return site.CapabilityModerateContent, true
			}
		}
		return site.CapabilityWriteContent, true
	case "media":
		if method == "GET" {
			return "", false
		}
		return site.CapabilityWriteContent, true
	case "comments":
		if len(segments) >= 3 && method == "POST" {
			last := segments[len(segments)-1]
			if last == "approve" || last == "reject" {
				return site.CapabilityModerateComment, true
			}
		}
		if method == "POST" || method == "PATCH" || method == "DELETE" {
			return site.CapabilityComment, true
		}
		return "", false
	case "reports":
		// Filing a report is member behaviour; reading and resolving the queue is
		// moderation.
		if method == "POST" && len(segments) == 1 {
			return "", false
		}
		return site.CapabilityModerateContent, true
	case "taxonomy", "safety", "backups":
		return site.CapabilityManageSite, true
	case "analytics":
		// The dashboard shows 访问洞察 to whoever holds view_log, and that is the
		// authority the analytics service is meant to honour; analytics is a read
		// model over the same traffic records as the audit trail, not a setting.
		return site.CapabilityViewLog, true
	}
	return "", false
}

// splitPath splits a URL path into its non-empty segments.
func splitPath(path string) []string {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}
