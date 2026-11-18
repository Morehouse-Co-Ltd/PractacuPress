package apperr

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestProblemJSONShape(t *testing.T) {
	p := PermissionDenied()
	p.RequestID = "req_01"

	b, err := json.Marshal(p)
	require.NoError(t, err)
	require.JSONEq(t, `{
		"type":"https://docs.practacu.press/errors/permission_denied",
		"title":"Permission denied",
		"status":403,
		"code":"permission_denied",
		"message":"当前用户没有执行此操作的权限",
		"details":{},
		"request_id":"req_01"
	}`, string(b))
}

func TestProblemEmptyDetailsIsObject(t *testing.T) {
	var p Problem
	p.Status = http.StatusTeapot

	b, err := json.Marshal(p)
	require.NoError(t, err)
	require.Contains(t, string(b), `"details":{}`)
	require.NotContains(t, string(b), `"details":null`)
}

func TestUnknownCodeDegradesToInternal(t *testing.T) {
	p := New(Code("no_such_code"))
	require.Equal(t, CodeInternal, p.Code)
	require.Equal(t, http.StatusInternalServerError, p.Status)
}

func TestFromErrorPassesProblemThrough(t *testing.T) {
	in := NotFound("article")
	require.Same(t, in, FromError(in))
	require.Nil(t, FromError(nil))
}

func TestFromErrorHidesInternalDetail(t *testing.T) {
	p := FromError(errors.New(`pq: relation "users" does not exist`))
	require.Equal(t, http.StatusInternalServerError, p.Status)
	require.Equal(t, CodeInternal, p.Code)
	require.NotContains(t, p.Message, "relation")

	b, err := json.Marshal(p)
	require.NoError(t, err)
	require.NotContains(t, string(b), "relation")

	// The cause is still available to the logger.
	require.Error(t, p.Cause())
}

func TestProblemIsMatchable(t *testing.T) {
	err := error(PermissionDenied())
	require.True(t, Is(err, CodePermissionDenied))
	require.False(t, Is(err, CodeNotFound))
	require.False(t, Is(errors.New("x"), CodeInternal))
}

func TestConstructorsUseStableStatuses(t *testing.T) {
	cases := map[*Problem]int{
		Validation("title"):          http.StatusBadRequest,
		Unauthenticated():            http.StatusUnauthorized,
		PermissionDenied():           http.StatusForbidden,
		NotFound("article"):          http.StatusNotFound,
		Conflict(""):                 http.StatusConflict,
		RateLimited():                http.StatusTooManyRequests,
		Internal(errors.New("boom")): http.StatusInternalServerError,
	}
	for p, want := range cases {
		require.Equal(t, want, p.Status, string(p.Code))
	}
}

func TestEveryCodeHasSpec(t *testing.T) {
	codes := []Code{
		CodeValidationFailed, CodeUnauthenticated, CodePermissionDenied,
		CodeNotFound, CodeConflict, CodeRateLimited, CodeInternal,
		CodeInvalidCursor, CodeIdempotencyKeyReuse, CodeSiteNotFound,
		CodeSiteDomainUnverified, CodeContentStateInvalid, CodeSecurityUnavailable,
		CodeProviderNotConfigured, CodeInvalidDatabaseDriver, CodeEmailNotConfigured,
		CodeQuotaExceeded,
	}
	for _, c := range codes {
		_, ok := specs[c]
		require.True(t, ok, string(c))
	}
}
