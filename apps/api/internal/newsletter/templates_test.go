package newsletter_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/newsletter"
)

func TestBuiltinTemplatesContainTheDocumentedKeys(t *testing.T) {
	keys := make([]string, 0, 5)
	for _, template := range newsletter.BuiltinTemplates() {
		keys = append(keys, template.Key)
		require.True(t, template.Builtin)
		require.True(t, template.Enabled)
		require.NotEmpty(t, template.Name)
		require.NotEmpty(t, template.Subject)
		require.NotEmpty(t, template.BodyHTML)
		require.NotEmpty(t, template.BodyText)
	}
	require.ElementsMatch(t, []string{
		"subscriber_confirm",
		"subscriber_welcome",
		"newsletter_post",
		"password_reset",
		"email_verify",
	}, keys)
}

func TestRenderReplacesPlaceholdersAndBlanksUnknownOnes(t *testing.T) {
	vars := map[string]string{
		newsletter.VarSiteName:       "站点 <测试>",
		newsletter.VarUnsubscribeURL: "https://press.example.com/newsletter/unsubscribe?token=abc",
	}

	rendered := newsletter.Render(
		"{{site_name}} / {{ site_name }} / {{missing}} / {{unsubscribe_url}}",
		vars,
		false,
	)
	require.Equal(t, "站点 <测试> / 站点 <测试> /  / https://press.example.com/newsletter/unsubscribe?token=abc", rendered)
}

func TestRenderEscapesValuesInHTMLBodies(t *testing.T) {
	vars := map[string]string{newsletter.VarSiteName: `<script>alert(1)</script>`}
	require.Equal(t,
		"&lt;script&gt;alert(1)&lt;/script&gt;",
		newsletter.Render("{{site_name}}", vars, true),
	)
	// The text body must not be escaped: a plain text reader would see the entities.
	require.Equal(t, `<script>alert(1)</script>`,
		newsletter.Render("{{site_name}}", vars, false))
}

func TestRenderTemplateRendersSubjectHTMLAndText(t *testing.T) {
	template := newsletter.EmailTemplate{
		Subject:  "欢迎来到 {{site_name}}",
		BodyHTML: `<a href="{{site_url}}">{{site_name}}</a>`,
		BodyText: "{{site_name}}: {{site_url}}",
	}
	vars := map[string]string{
		newsletter.VarSiteName: "张三的博客",
		newsletter.VarSiteURL:  "https://press.example.com",
	}
	subject, bodyHTML, bodyText := newsletter.RenderTemplate(template, vars)
	require.Equal(t, "欢迎来到 张三的博客", subject)
	require.Contains(t, bodyHTML, `href="https://press.example.com"`)
	require.Contains(t, bodyHTML, "张三的博客")
	require.Contains(t, bodyText, "张三的博客: https://press.example.com")
}

func TestBuiltinConfirmTemplateCarriesBothLinks(t *testing.T) {
	template, ok := newsletter.BuiltinTemplate(newsletter.KeySubscriberConfirm)
	require.True(t, ok)
	vars := map[string]string{
		newsletter.VarSiteName:       "测试站点",
		newsletter.VarEmail:          "reader@example.com",
		newsletter.VarConfirmURL:     "https://press.example.com/newsletter/confirm?token=t1",
		newsletter.VarUnsubscribeURL: "https://press.example.com/newsletter/unsubscribe?token=t1",
	}
	subject, bodyHTML, bodyText := newsletter.RenderTemplate(template, vars)
	require.Contains(t, subject, "测试站点")
	require.Contains(t, bodyHTML, "newsletter/confirm?token=t1")
	require.Contains(t, bodyHTML, "newsletter/unsubscribe?token=t1")
	require.Contains(t, bodyText, "newsletter/confirm?token=t1")
}

func TestWrapCampaignFooterAddsUnsubscribeLink(t *testing.T) {
	bodyHTML, bodyText := newsletter.WrapCampaignFooter("<p>正文</p>", "正文")
	require.Contains(t, bodyHTML, "{{unsubscribe_url}}")
	require.Contains(t, bodyHTML, "退订")
	require.Contains(t, bodyText, "{{unsubscribe_url}}")
	require.True(t, strings.HasPrefix(strings.TrimSpace(bodyHTML), "<p>正文</p>"))
}
