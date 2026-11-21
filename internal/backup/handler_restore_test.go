package backup

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

func restoreContext(t *testing.T) *gin.Context {
	t.Helper()
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/platform/backups/backup-1/restore", nil)
	c.Params = gin.Params{{Key: "backupID", Value: "backup-1"}}
	return c
}

// TestRestoreRequiresPlatformAdminAndStepUp pins the two gates that must hold even
// when the site's high-threat setting is off: the caller is a platform
// administrator, and the request carries a valid grant.
func TestRestoreRequiresPlatformAdminAndStepUp(t *testing.T) {
	gin.SetMode(gin.TestMode)
	verifier := func(raw, userID, siteID string) bool {
		return raw == "grant" && userID == "admin-1" && siteID == "site-1"
	}

	t.Run("platform admin without grant", func(t *testing.T) {
		handler := &Handler{
			principal: func(*gin.Context) (Actor, bool) {
				return Actor{UserID: "admin-1", SiteID: "site-1", Role: site.RolePlatformAdmin}, true
			},
			stepUp: verifier,
		}
		c := restoreContext(t)
		handler.restore(c)

		require.Len(t, c.Errors, 1)
		var problem *apperr.Problem
		require.True(t, errors.As(c.Errors[0].Err, &problem))
		require.Equal(t, http.StatusForbidden, problem.Status)
		require.Equal(t, "step_up_required", problem.Details["reason"])
	})

	t.Run("site admin with grant", func(t *testing.T) {
		handler := &Handler{
			principal: func(*gin.Context) (Actor, bool) {
				return Actor{UserID: "admin-1", SiteID: "site-1", Role: site.RoleSiteAdmin}, true
			},
			stepUp: verifier,
		}
		c := restoreContext(t)
		c.Request.Header.Set(site.StepUpHeaderName, "grant")
		handler.restore(c)

		require.Len(t, c.Errors, 1)
		var problem *apperr.Problem
		require.True(t, errors.As(c.Errors[0].Err, &problem))
		require.Equal(t, http.StatusForbidden, problem.Status)
		require.Equal(t, "platform_admin_required", problem.Details["reason"])
	})

	t.Run("missing verifier fails closed", func(t *testing.T) {
		handler := &Handler{
			principal: func(*gin.Context) (Actor, bool) {
				return Actor{UserID: "admin-1", SiteID: "site-1", Role: site.RolePlatformAdmin}, true
			},
		}
		c := restoreContext(t)
		c.Request.Header.Set(site.StepUpHeaderName, "grant")
		handler.restore(c)

		require.Len(t, c.Errors, 1)
		var problem *apperr.Problem
		require.True(t, errors.As(c.Errors[0].Err, &problem))
		require.Equal(t, http.StatusInternalServerError, problem.Status)
	})
}
