package taxonomy

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidate(t *testing.T) {
	in, err := Validate(Input{
		Kind:        KindCategory,
		Name:        "  Craft Notes ",
		Description: "  essays ",
		Color:       " #2F6B4F ",
	})
	require.NoError(t, err)
	require.Equal(t, "Craft Notes", in.Name)
	require.Equal(t, "craft-notes", in.Slug, "slug is derived from an ASCII name")
	require.Equal(t, "essays", in.Description)
	require.Equal(t, "#2f6b4f", in.Color)

	// Chinese names have no ASCII slug; the caller must provide one.
	_, err = Validate(Input{Kind: KindTag, Name: "独立出版"})
	require.Error(t, err)

	in, err = Validate(Input{Kind: KindTag, Name: "独立出版", Slug: "indie-press"})
	require.NoError(t, err)
	require.Equal(t, "indie-press", in.Slug)

	for name, in := range map[string]Input{
		"unknown kind": {Kind: "topic", Name: "x", Slug: "x"},
		"missing name": {Kind: KindTag, Slug: "x"},
		"bad slug":     {Kind: KindTag, Name: "x", Slug: "Not A Slug"},
		"bad color":    {Kind: KindCategory, Name: "x", Slug: "x", Color: "green"},
		"long description": {
			Kind: KindCategory, Name: "x", Slug: "x",
			Description: string(make([]rune, MaxDescriptionLength+1)),
		},
	} {
		_, err := Validate(in)
		require.Error(t, err, name)
	}
}

func TestPatchApply(t *testing.T) {
	term := Term{
		Kind:        KindCategory,
		Name:        "Craft",
		Slug:        "craft",
		Description: "old",
		Color:       "#112233",
	}

	name := "Craft Notes"
	description := ""
	color := ""
	updated, err := PatchInput{Name: &name, Description: &description, Color: &color}.Apply(term)
	require.NoError(t, err)
	require.Equal(t, "Craft Notes", updated.Name)
	require.Equal(t, "craft", updated.Slug, "an existing slug stays stable when the name changes")
	require.Empty(t, updated.Description)
	require.Empty(t, updated.Color)

	// Clearing the only slug is allowed when the name still derives one.
	cleared := ""
	updated, err = PatchInput{Slug: &cleared}.Apply(Term{Name: "Craft Notes"})
	require.NoError(t, err)
	require.Equal(t, "craft-notes", updated.Slug)

	bad := "Not A Slug"
	_, err = PatchInput{Slug: &bad}.Apply(term)
	require.Error(t, err)
}

func TestSlugFromName(t *testing.T) {
	require.Equal(t, "hello-world", SlugFromName(" Hello World "))
	require.Equal(t, "a-b-c", SlugFromName("a__b  c"))
	require.Equal(t, "v2-notes", SlugFromName("V2 Notes"))
	require.Empty(t, SlugFromName("中文标题"))
}
