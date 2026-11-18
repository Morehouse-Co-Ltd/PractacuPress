package site_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	entgen "github.com/practacu/practacu-press/ent"
	"github.com/practacu/practacu-press/internal/notifications"
	"github.com/practacu/practacu-press/internal/site"
)

// The public contact form.
//
// The brief's four cases are all here, each one asserted through the real router, the
// real site store and the real notification store: what matters is that a submission
// ends up as exactly one inbox row per administrator, and that the three anti-abuse
// paths (honeypot, cooldown, validation) each answer without delivering anything.

// contactPath is the endpoint a visitor's browser posts to.
func contactPath(siteID string) string {
	return "/api/v1/sites/" + siteID + "/contact"
}

// postContact sends one submission. An empty token keeps the request anonymous, which
// is how a reader without an account uses the form.
func (h *harness) postContact(t *testing.T, token string, body map[string]string) *httptest.ResponseRecorder {
	t.Helper()

	payload, err := json.Marshal(body)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, contactPath(h.siteID), strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	// A fixed address keeps the cooldown scope identical between two submissions.
	req.RemoteAddr = "203.0.113.7:3456"
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	return w
}

// inbox returns every notification row currently stored.
func (h *harness) inbox(t *testing.T) []*entgen.Notification {
	t.Helper()
	rows, err := h.db.Client.Notification.Query().All(context.Background())
	require.NoError(t, err)
	return rows
}

// promoteUser makes one registered account a site administrator.
func (h *harness) promoteUser(t *testing.T, token string, role site.Role) string {
	t.Helper()
	userID := h.userID(t, token)
	h.setRole(t, userID, role)
	return userID
}

// validMessage is what a reader actually types.
func validMessage() map[string]string {
	return map[string]string{
		"name":    "林可",
		"email":   "linke@example.com",
		"message": "你们的排版我很喜欢，想问问封面照片是谁拍的？",
		"website": "",
	}
}

// TestContactFormNotifiesTheSiteAdministrator is the reason the endpoint exists: an
// anonymous visitor writes once, the site owner finds one plain text row in the inbox.
func TestContactFormNotifiesTheSiteAdministrator(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	adminID := h.promoteUser(t, token, site.RoleSiteAdmin)

	w := h.postContact(t, "", validMessage())
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	rows := h.inbox(t)
	require.Len(t, rows, 1, "one message means one notification")

	row := rows[0]
	require.Equal(t, string(notifications.TypeContact), row.Type)
	require.Equal(t, adminID, row.UserID, "delivery is addressed to the administrator")

	require.Equal(t, "站点来信：林可", row.Payload["subject"])
	require.Equal(t, validMessage()["message"], row.Payload["message"])
	require.Equal(t, "linke@example.com", row.Payload["email"])
	require.Equal(t, "林可", row.Payload["name"])
	// The body is plain text: no markup is added, and user input is never HTML.
	require.NotContains(t, row.Payload["message"], "<")
}

// TestContactFormAcceptsAMessageWithoutNameOrAddress covers the block's toggles: the
// panel can hide the name and the email field, so neither may be required.
func TestContactFormAcceptsAMessageWithoutNameOrAddress(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promoteUser(t, token, site.RoleSiteAdmin)

	w := h.postContact(t, "", map[string]string{"message": "只是想说一声辛苦了。"})
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	rows := h.inbox(t)
	require.Len(t, rows, 1)
	require.Equal(t, "站点来信", rows[0].Payload["subject"])
	require.NotContains(t, rows[0].Payload, "email")
}

// TestContactFormOnlyReachesAdministrators keeps plain members out of the fan-out.
func TestContactFormOnlyReachesAdministrators(t *testing.T) {
	h := newHarness(t)
	memberToken := h.register(t, "reader@example.com")
	adminToken := h.register(t, "owner@example.com")
	adminID := h.promoteUser(t, adminToken, site.RoleSiteAdmin)
	memberID := h.userID(t, memberToken)

	require.Equal(t, http.StatusAccepted, h.postContact(t, "", validMessage()).Code)

	rows := h.inbox(t)
	require.Len(t, rows, 1)
	require.Equal(t, adminID, rows[0].UserID)
	require.NotEqual(t, memberID, rows[0].UserID)
}

// TestContactFormRejectsAnOverlongMessage is the brief's 400 case.
func TestContactFormRejectsAnOverlongMessage(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promoteUser(t, token, site.RoleSiteAdmin)

	body := validMessage()
	// One character past the bound; the handler must not store a truncated version.
	body["message"] = strings.Repeat("长", site.MaxContactMessageLength+1)

	w := h.postContact(t, "", body)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Empty(t, h.inbox(t), "a rejected submission must not notify anyone")
}

// TestContactFormKeepsALongMessageWhole is the regression guard for the payload bound:
// the notification payload caps its values by bytes, while this endpoint counts
// characters. A full-length Chinese message is 6000 bytes, so without the exception in
// the notifications package a legal submission would come back as a 500.
func TestContactFormKeepsALongMessageWhole(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promoteUser(t, token, site.RoleSiteAdmin)

	body := validMessage()
	body["message"] = strings.Repeat("长", site.MaxContactMessageLength)

	w := h.postContact(t, "", body)
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())

	rows := h.inbox(t)
	require.Len(t, rows, 1)
	require.Equal(t, body["message"], rows[0].Payload["message"],
		"the message must be stored whole, not truncated")
}

// TestContactFormRejectsAnAddressWithoutAt pins the only email rule the server has.
func TestContactFormRejectsAnAddressWithoutAt(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promoteUser(t, token, site.RoleSiteAdmin)

	body := validMessage()
	body["email"] = "not-an-address"

	w := h.postContact(t, "", body)
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Empty(t, h.inbox(t))
}

// TestContactFormRejectsAnEmptyMessage keeps a blank submission out of the inbox, and
// names the field and rule so the form can tell the reader what to fix.
func TestContactFormRejectsAnEmptyMessage(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promoteUser(t, token, site.RoleSiteAdmin)

	body := validMessage()
	body["message"] = "   "

	w := h.postContact(t, "", body)
	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Empty(t, h.inbox(t))

	var problem struct {
		Code    string            `json:"code"`
		Message string            `json:"message"`
		Details map[string]string `json:"details"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &problem))
	require.Equal(t, "validation_failed", problem.Code)
	require.Equal(t, "请求参数不符合要求", problem.Message)
	require.Equal(t, "message", problem.Details["field"])
	require.Equal(t, "required", problem.Details["rule"])
	require.NotEmpty(t, problem.Details["reason"])
}

// TestContactFormHoneypotIsSilentlyAccepted is the brief's "202 but deliver nothing":
// a bot learns nothing, and no administrator is woken up.
func TestContactFormHoneypotIsSilentlyAccepted(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promoteUser(t, token, site.RoleSiteAdmin)

	body := validMessage()
	body["website"] = "https://spam.example.com"

	w := h.postContact(t, "", body)
	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	require.Empty(t, h.inbox(t), "the honeypot must not deliver")
}

// TestContactFormThrottlesASecondSubmissionWithinAMinute is the brief's 429 case.
func TestContactFormThrottlesASecondSubmissionWithinAMinute(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promoteUser(t, token, site.RoleSiteAdmin)

	first := h.postContact(t, "", validMessage())
	require.Equal(t, http.StatusAccepted, first.Code, first.Body.String())

	second := h.postContact(t, "", validMessage())
	require.Equal(t, http.StatusTooManyRequests, second.Code, second.Body.String())

	require.Len(t, h.inbox(t), 1, "a throttled submission must not deliver again")

	var problem struct {
		Code    string            `json:"code"`
		Details map[string]string `json:"details"`
	}
	require.NoError(t, json.Unmarshal(second.Body.Bytes(), &problem))
	require.Equal(t, "rate_limited", problem.Code)
	require.Equal(t, "contact_cooldown", problem.Details["reason"])
}

// TestContactFormValidationRunsBeforeTheCooldown keeps a reader who typed too much from
// being locked out for a minute while they fix it.
func TestContactFormValidationRunsBeforeTheCooldown(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promoteUser(t, token, site.RoleSiteAdmin)

	tooLong := validMessage()
	tooLong["message"] = strings.Repeat("长", site.MaxContactMessageLength+1)
	require.Equal(t, http.StatusBadRequest, h.postContact(t, "", tooLong).Code)

	// The rejected attempt did not start the cooldown, so the corrected one goes through.
	require.Equal(t, http.StatusAccepted, h.postContact(t, "", validMessage()).Code)
	require.Len(t, h.inbox(t), 1)
}

// TestContactFormRejectsAnotherTenant keeps the path from selecting a site.
func TestContactFormRejectsAnotherTenant(t *testing.T) {
	h := newHarness(t)

	payload, err := json.Marshal(validMessage())
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/sites/other-site/contact", strings.NewReader(string(payload)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Empty(t, h.inbox(t))
}

// TestContactFormRejectsAMalformedBody answers 400 instead of an unreadable 500.
func TestContactFormRejectsAMalformedBody(t *testing.T) {
	h := newHarness(t)

	req := httptest.NewRequest(http.MethodPost, contactPath(h.siteID), strings.NewReader("{"))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
}
