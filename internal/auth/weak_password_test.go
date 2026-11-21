package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/site"
)

// jsonBodyConfirm is jsonBody with arbitrary JSON values, which the confirmation
// flag needs: map[string]string cannot carry a boolean.
func jsonBodyConfirm(t *testing.T, values map[string]any) *bytes.Buffer {
	t.Helper()
	raw, err := json.Marshal(values)
	require.NoError(t, err)
	return bytes.NewBuffer(raw)
}

func TestRegisterAllowsConfirmedWeakPassword(t *testing.T) {
	h := newAPIHarness(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register/email", jsonBodyConfirm(t, map[string]any{
		"email":                 "weak@example.com",
		"password":              "short",
		"display_name":          "Weak",
		"confirm_weak_password": true,
	}))
	req.Header.Set("Content-Type", "application/json")
	w := h.do(t, req)
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	// The whole point of the confirmation: this exact password is now usable.
	require.Equal(t, http.StatusOK, login(t, h, "weak@example.com", "short").Code)
}

func TestRegisterConfirmedWeakPasswordKeepsHardBounds(t *testing.T) {
	tests := map[string]struct {
		password string
		wantRule string
	}{
		"empty":      {"", "too_short"},
		"whitespace": {strings.Repeat(" ", 12), "blank"},
		"overlong":   {strings.Repeat("a", 129), "too_long"},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			h := newAPIHarness(t)
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register/email", jsonBodyConfirm(t, map[string]any{
				"email":                 name + "@example.com",
				"password":              tt.password,
				"display_name":          "Weak",
				"confirm_weak_password": true,
			}))
			req.Header.Set("Content-Type", "application/json")
			w := h.do(t, req)
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())

			details := decode(t, w)["details"].(map[string]any)
			require.Equal(t, "password", details["field"])
			require.Equal(t, tt.wantRule, details["rule"])
		})
	}
}

func TestChangePasswordAllowsConfirmedWeakPassword(t *testing.T) {
	h := newAPIHarness(t)

	first := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, first.Code)
	token := sessionToken(t, first)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password/change", jsonBodyConfirm(t, map[string]any{
		"current_password":      "correct horse battery",
		"new_password":          "short",
		"confirm_weak_password": true,
	}))
	req.Header.Set("Content-Type", "application/json")
	bearer(req, token)
	w := h.do(t, req)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())

	require.Equal(t, http.StatusUnauthorized, login(t, h, "alice@example.com", "correct horse battery").Code)
	require.Equal(t, http.StatusOK, login(t, h, "alice@example.com", "short").Code)
}

func TestCreateMemberAllowsConfirmedWeakPassword(t *testing.T) {
	h := newAPIHarness(t)

	_, err := h.service.CreateMember(context.Background(), auth.Principal{
		UserID: "admin", SiteID: h.siteID, Role: site.RolePlatformAdmin,
	}, h.siteID, auth.CreateMemberInput{
		Email:               "weak-member@example.com",
		DisplayName:         "Weak member",
		Password:            "short",
		ConfirmWeakPassword: true,
	})
	require.NoError(t, err)

	// The account exists and can authenticate with the confirmed weak password.
	require.Equal(t, http.StatusOK, login(t, h, "weak-member@example.com", "short").Code)
}

func TestPasswordResetAllowsConfirmedWeakPassword(t *testing.T) {
	sender := &recordingMailer{}
	h := newAPIHarnessWithMail(t, sender)
	require.Equal(t, http.StatusCreated, register(t, h, "reset-weak@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "reset-weak@example.com").Code)

	token := resetToken(t, resetMail(t, sender))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/password-reset/confirm", jsonBodyConfirm(t, map[string]any{
		"token":                 token,
		"password":              "short",
		"confirm_weak_password": true,
	}))
	req.Header.Set("Content-Type", "application/json")
	w := h.do(t, req)
	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())

	require.Equal(t, http.StatusOK, login(t, h, "reset-weak@example.com", "short").Code)
}
