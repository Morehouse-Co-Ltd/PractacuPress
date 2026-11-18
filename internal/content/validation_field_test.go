package content

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
)

// TestValidateDraftNamesTheFailingField pins the machine readable vocabulary the client
// uses to explain a rejected editor form. The sentinel must stay matchable for the
// transport, while the FieldError names the input and the rule it broke. The english
// reason stays for operators and must not be lost.
func TestValidateDraftNamesTheFailingField(t *testing.T) {
	valid := func() DraftInput {
		return DraftInput{
			Title:        "Hello World",
			SourceFormat: FormatMarkdown,
			SourceBody:   "body",
		}
	}

	tests := []struct {
		name   string
		mutate func(*DraftInput)
		field  string
		rule   string
	}{
		{
			name:   "empty title",
			mutate: func(in *DraftInput) { in.Title = "   " },
			field:  "title",
			rule:   "required",
		},
		{
			name:   "over-long title",
			mutate: func(in *DraftInput) { in.Title = strings.Repeat("长", 300) },
			field:  "title",
			rule:   "too_long",
		},
		{
			name:   "over-long summary",
			mutate: func(in *DraftInput) { in.Summary = strings.Repeat("长", 600) },
			field:  "summary",
			rule:   "too_long",
		},
		{
			name:   "uppercase slug",
			mutate: func(in *DraftInput) { in.Slug = "Bad Slug" },
			field:  "slug",
			rule:   "malformed",
		},
		{
			name:   "over-long slug",
			mutate: func(in *DraftInput) { in.Slug = strings.Repeat("a", MaxSlugLength+1) },
			field:  "slug",
			rule:   "too_long",
		},
		{
			name: "over-long tag",
			mutate: func(in *DraftInput) {
				in.Tags = []string{strings.Repeat("a", MaxTagLength+1)}
			},
			field: "tags",
			rule:  "too_long",
		},
		{
			name: "too many tags",
			mutate: func(in *DraftInput) {
				in.Tags = make([]string, 0, MaxTags+1)
				for index := 0; index <= MaxTags; index++ {
					in.Tags = append(in.Tags, fmt.Sprintf("tag-%02d", index))
				}
			},
			field: "tags",
			rule:  "out_of_range",
		},
		{
			name:   "missing body",
			mutate: func(in *DraftInput) { in.SourceBody = "" },
			field:  "body",
			rule:   "required",
		},
		{
			name:   "over-long body",
			mutate: func(in *DraftInput) { in.SourceBody = strings.Repeat("a", MaxSourceLength+1) },
			field:  "body",
			rule:   "too_long",
		},
		{
			name:   "unknown source format",
			mutate: func(in *DraftInput) { in.SourceFormat = SourceFormat("excel") },
			field:  "body",
			rule:   "unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := valid()
			tt.mutate(&in)

			_, err := ValidateDraft(in)
			require.ErrorIs(t, err, ErrInvalidInput, "the transport still matches the sentinel")

			var fieldErr *apperr.FieldError
			require.ErrorAs(t, err, &fieldErr, "the error names the failing field")
			require.Equal(t, tt.field, fieldErr.Field)
			require.Equal(t, tt.rule, fieldErr.Rule)
			require.NotEmpty(t, fieldErr.Reason, "operators keep the english reason")
		})
	}
}

// TestCreateArticleHandlerNamesTheFailingField is the wire contract: the handler must
// project the FieldError into details, not collapse it to the generic reason. The
// status, code and message are unchanged.
func TestCreateArticleHandlerNamesTheFailingField(t *testing.T) {
	engine := newQuotaEngine(t, newFakeRepo(), &fakeQuota{})

	body := []byte(`{"title":"   ","source_format":"markdown","source_body":"hello"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/articles", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())

	var payload struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Details map[string]any `json:"details"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))

	require.Equal(t, "validation_failed", payload.Code)
	require.Equal(t, "请求参数不符合要求", payload.Message, "the message must stay unchanged")
	require.Equal(t, "title", payload.Details["field"])
	require.Equal(t, "required", payload.Details["rule"])
	require.NotEmpty(t, payload.Details["reason"])
}
