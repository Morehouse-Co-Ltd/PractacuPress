package permalink

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPathRendersBuiltInStructures(t *testing.T) {
	date := time.Date(2026, 11, 19, 8, 30, 0, 0, time.UTC)
	item := Item{Kind: "article", ID: "art_42", Slug: "quiet-yard", Date: date}
	cases := []struct {
		structure Structure
		want      string
	}{
		{StructureLegacy, "/a/quiet-yard"},
		{StructureDateName, "/2026/11/19/quiet-yard"},
		{StructureMonthName, "/2026/11/quiet-yard"},
		{StructureNumeric, "/archives/art_42"},
		{StructurePostName, "/quiet-yard"},
	}
	for _, test := range cases {
		settings := Defaults()
		settings.ArticleStructure = test.structure
		require.Equal(t, test.want, Path(settings, item))
	}
}

func TestCustomStructureAndPostFollowSettings(t *testing.T) {
	settings := Defaults()
	settings.ArticleStructure = StructureCustom
	settings.ArticleCustom = "/stories/%year%/%postname%-%post_id%"
	settings.PostsFollow = true
	item := Item{
		Kind: "post", ID: "post_9", Slug: "release", Date: time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC),
	}
	require.Equal(t, "/stories/2026/release-post_9", Path(settings, item))

	matches := Match("/stories/2026/release-post_9", settings)
	require.Equal(t, []Candidate{{Kind: "article", Key: "release"}, {Kind: "post", Key: "release"}}, matches)
}

func TestMatchKeepsPreviousStructureAliases(t *testing.T) {
	settings := Defaults()
	settings.ArticleStructure = StructurePostName
	settings.ArticleAliases = []Pattern{{Structure: StructureDateName}}

	require.Equal(t, []Candidate{{Kind: "article", Key: "hello"}}, Match("/2025/05/01/hello", settings))
}

func TestValidateCustomizationRejectsMalformedTemplate(t *testing.T) {
	err := ValidateCustomization([]byte(`{"seo":{"permalinks":{"article_structure":"custom","article_custom":"/news/%unknown%"}}}`))
	require.ErrorIs(t, err, ErrInvalidSettings)
	require.Error(t, ValidateCustom("/%year%"))
	require.NoError(t, ValidateCustom("/%year%/%postname%"))
}

func TestParseCustomizationKeepsDefaultsForLegacyDocument(t *testing.T) {
	require.Equal(t, Defaults(), ParseCustomization([]byte(`{"seo":{"indexable":true}}`)))
}
