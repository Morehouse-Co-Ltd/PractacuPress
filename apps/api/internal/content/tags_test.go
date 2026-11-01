package content

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeTags(t *testing.T) {
	tags, err := NormalizeTags([]string{" Go ", "", "go", "Go", "Web"})
	require.NoError(t, err)
	require.Equal(t, []string{"Go", "go", "Web"}, tags, "order is kept and blank values are dropped")

	labels := make([]string, 0, MaxTags+1)
	for index := 0; index <= MaxTags; index++ {
		labels = append(labels, string(rune('a'+index)))
	}
	_, err = NormalizeTags(labels)
	require.Error(t, err, "more than MaxTags labels is rejected")

	_, err = NormalizeTags([]string{string(make([]rune, MaxTagLength+1))})
	require.Error(t, err, "one label longer than MaxTagLength is rejected")

	tags, err = NormalizeTags(nil)
	require.NoError(t, err)
	require.NotNil(t, tags)
	require.Empty(t, tags)
}

func TestEncodeDecodeTags(t *testing.T) {
	raw := EncodeTags([]string{"Go", "Web"})
	require.JSONEq(t, `["Go","Web"]`, raw)
	require.Equal(t, []string{"Go", "Web"}, DecodeTags(raw))

	require.Equal(t, "[]", EncodeTags(nil))
	require.Empty(t, DecodeTags(""))
	require.Empty(t, DecodeTags("not json"))
	require.Empty(t, DecodeTags("null"))
	require.Empty(t, DecodeTags(`{"unexpected":"object"}`))
}

func TestValidateDraftNormalizesTags(t *testing.T) {
	in, err := ValidateDraft(DraftInput{
		Title:      "Hello",
		SourceBody: "body",
		Tags:       []string{"  Go ", "Go", "Web"},
	})
	require.NoError(t, err)
	require.Equal(t, []string{"Go", "Web"}, in.Tags)

	_, err = ValidateDraft(DraftInput{
		Title:      "Hello",
		SourceBody: "body",
		Tags:       []string{string(make([]rune, MaxTagLength+1))},
	})
	require.Error(t, err)
}
