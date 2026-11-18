package taxonomy

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
)

// TestValidateNamesTheFailingField pins the machine readable vocabulary for taxonomy
// terms: errors.Is keeps matching the sentinel for the transport while errors.As
// recovers the field and rule the client translates.
func TestValidateNamesTheFailingField(t *testing.T) {
	valid := func() Input {
		return Input{Kind: KindCategory, Name: "Craft", Slug: "craft"}
	}

	tests := []struct {
		name   string
		mutate func(*Input)
		field  string
		rule   string
	}{
		{
			name:   "missing name",
			mutate: func(in *Input) { in.Name = "   " },
			field:  "name",
			rule:   "required",
		},
		{
			name:   "over-long name",
			mutate: func(in *Input) { in.Name = strings.Repeat("长", MaxNameLength+1) },
			field:  "name",
			rule:   "too_long",
		},
		{
			name:   "malformed slug",
			mutate: func(in *Input) { in.Slug = "Not A Slug" },
			field:  "slug",
			rule:   "malformed",
		},
		{
			name:   "over-long slug",
			mutate: func(in *Input) { in.Slug = strings.Repeat("a", MaxSlugLength+1) },
			field:  "slug",
			rule:   "too_long",
		},
		{
			name: "unsluggable name leaves the slug required",
			mutate: func(in *Input) {
				in.Name = "独立出版"
				in.Slug = ""
			},
			field: "slug",
			rule:  "required",
		},
		{
			name:   "malformed color",
			mutate: func(in *Input) { in.Color = "green" },
			field:  "color",
			rule:   "malformed",
		},
		{
			name:   "over-long color",
			mutate: func(in *Input) { in.Color = "#" + strings.Repeat("a", MaxColorLength) },
			field:  "color",
			rule:   "too_long",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := valid()
			tt.mutate(&in)

			_, err := Validate(in)
			require.ErrorIs(t, err, ErrInvalidInput, "the transport still matches the sentinel")

			var fieldErr *apperr.FieldError
			require.ErrorAs(t, err, &fieldErr, "the error names the failing field")
			require.Equal(t, tt.field, fieldErr.Field)
			require.Equal(t, tt.rule, fieldErr.Rule)
			require.NotEmpty(t, fieldErr.Reason, "operators keep the english reason")
		})
	}
}

// TestHandlerCreateNamesTheFailingField proves the taxonomy mapError projects the
// FieldError instead of the generic "invalid taxonomy term" reason.
func TestHandlerCreateNamesTheFailingField(t *testing.T) {
	engine := newHandlerEngine(t, &fakeRepo{})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/sites/site_1/taxonomy",
		bytes.NewReader([]byte(`{"kind":"category","name":"   ","slug":"craft"}`)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Test-Principal", "1")
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
	require.Equal(t, "name", payload.Details["field"])
	require.Equal(t, "required", payload.Details["rule"])
	require.NotEmpty(t, payload.Details["reason"])
}
