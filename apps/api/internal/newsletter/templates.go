package newsletter

import (
	"html"
	"regexp"
	"strings"
)

// Builtin template keys. These identifiers are the stable contract between the
// sending code and the stored override: renaming a template never breaks a send.
const (
	KeySubscriberConfirm = "subscriber_confirm"
	KeySubscriberWelcome = "subscriber_welcome"
	KeyNewsletterPost    = "newsletter_post"
	KeyPasswordReset     = "password_reset"
	KeyEmailVerify       = "email_verify"
)

// Template variable names. They are documented in the admin editor so an operator
// knows what can be interpolated.
const (
	// VarSiteName is the site display name.
	VarSiteName = "site_name"
	// VarSiteURL is the site public base URL (may be empty on an installation
	// without PUBLIC_BASE_URL).
	VarSiteURL = "site_url"
	// VarEmail is the subscriber's address.
	VarEmail = "email"
	// VarConfirmURL is the double opt in confirmation link.
	VarConfirmURL = "confirm_url"
	// VarUnsubscribeURL is the unsubscribe link valid without a session.
	VarUnsubscribeURL = "unsubscribe_url"
	// VarContentTitle is the linked content's title (newsletter default body).
	VarContentTitle = "content_title"
	// VarContentSummary is the linked content's summary.
	VarContentSummary = "content_summary"
	// VarContentURL is the linked content's public URL.
	VarContentURL = "content_url"
	// VarYear is the current year, for the footer line.
	VarYear = "year"
)

// builtinTemplates is the shipped template set, in display order.
//
// They are code constants rather than seeded rows on purpose: an installation that
// upgrades gets the newest default without a migration, and DELETE on an override
// simply reveals this list again.
var builtinTemplates = []EmailTemplate{
	{
		Key:      KeySubscriberConfirm,
		Name:     "订阅确认",
		Subject:  "请确认订阅 {{site_name}} 的邮件",
		Enabled:  true,
		Builtin:  true,
		BodyHTML: builtinConfirmHTML,
		BodyText: builtinConfirmText,
	},
	{
		Key:      KeySubscriberWelcome,
		Name:     "订阅欢迎",
		Subject:  "欢迎订阅 {{site_name}}",
		Enabled:  true,
		Builtin:  true,
		BodyHTML: builtinWelcomeHTML,
		BodyText: builtinWelcomeText,
	},
	{
		Key:      KeyNewsletterPost,
		Name:     "Newsletter 正文",
		Subject:  "{{site_name}} 的最新内容",
		Enabled:  true,
		Builtin:  true,
		BodyHTML: builtinNewsletterHTML,
		BodyText: builtinNewsletterText,
	},
	{
		Key:      KeyPasswordReset,
		Name:     "找回密码",
		Subject:  "重置 {{site_name}} 的登录密码",
		Enabled:  true,
		Builtin:  true,
		BodyHTML: builtinPasswordResetHTML,
		BodyText: builtinPasswordResetText,
	},
	{
		Key:      KeyEmailVerify,
		Name:     "邮箱验证",
		Subject:  "验证你的邮箱 · {{site_name}}",
		Enabled:  true,
		Builtin:  true,
		BodyHTML: builtinVerifyHTML,
		BodyText: builtinVerifyText,
	},
}

// BuiltinTemplates returns a copy of the shipped templates, in display order.
func BuiltinTemplates() []EmailTemplate {
	out := make([]EmailTemplate, len(builtinTemplates))
	copy(out, builtinTemplates)
	return out
}

// BuiltinTemplate returns one shipped template.
func BuiltinTemplate(key string) (EmailTemplate, bool) {
	for _, template := range builtinTemplates {
		if template.Key == key {
			return template, true
		}
	}
	return EmailTemplate{}, false
}

// IsBuiltinTemplateKey reports whether key names one of the shipped templates.
func IsBuiltinTemplateKey(key string) bool {
	_, ok := BuiltinTemplate(key)
	return ok
}

// campaignKeyPrefix marks the stored body of one queued newsletter.
//
// email_logs deliberately stores no body: the message is rebuilt from a template
// when it is delivered. A campaign is therefore persisted as a transient template
// override under an internal key, which keeps the queue restart safe without a
// schema change. The editor filters this prefix out, and no client may write it.
const campaignKeyPrefix = "campaign:"

// CampaignTemplateKey returns the internal template key of one campaign.
func CampaignTemplateKey(campaignID string) string { return campaignKeyPrefix + campaignID }

// IsCampaignTemplateKey reports whether the key belongs to the internal campaign
// namespace.
func IsCampaignTemplateKey(key string) bool { return strings.HasPrefix(key, campaignKeyPrefix) }

// placeholderPattern matches {{name}} with optional inner whitespace.
var placeholderPattern = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_]+)\s*\}\}`)

// Render substitutes {{key}} placeholders.
//
// An unknown placeholder becomes the empty string instead of leaking "{{key}}" into
// a reader's mailbox. When escapeHTML is true every substituted value is HTML
// escaped, because the template body is markup and the value is data.
func Render(body string, vars map[string]string, escapeHTML bool) string {
	if body == "" || !strings.Contains(body, "{{") {
		return body
	}
	return placeholderPattern.ReplaceAllStringFunc(body, func(match string) string {
		groups := placeholderPattern.FindStringSubmatch(match)
		if len(groups) != 2 {
			return ""
		}
		value := vars[groups[1]]
		if escapeHTML {
			return html.EscapeString(value)
		}
		return value
	})
}

// RenderTemplate renders a stored template into a deliverable message.
//
// The subject is plain text (mail clients do not render markup there), the HTML body
// escapes the values and the text body uses them verbatim.
func RenderTemplate(template EmailTemplate, vars map[string]string) (subject, bodyHTML, bodyText string) {
	subject = Render(template.Subject, vars, false)
	bodyHTML = Render(template.BodyHTML, vars, true)
	bodyText = Render(template.BodyText, vars, false)
	return strings.TrimSpace(subject), bodyHTML, bodyText
}

// WrapCampaignFooter appends the contact block every campaign must carry.
//
// The unsubscribe link is generated by code rather than left to the editable body so
// an operator cannot accidentally ship a mailing without a way out. The values are
// substituted later, per subscriber, because the link carries their token.
func WrapCampaignFooter(bodyHTML, bodyText string) (string, string) {
	htmlPart := strings.TrimSpace(bodyHTML)
	textPart := strings.TrimSpace(bodyText)

	htmlPart += `
<hr style="border:0;border-top:1px solid #eeeee8;margin:28px 0 16px">
<p style="font-size:12px;line-height:1.7;color:#8a8a82">你收到这封邮件是因为你订阅了 {{site_name}}。不想再收到？<a href="{{unsubscribe_url}}" style="color:#8a8a82">退订</a>。</p>`

	textPart += "\n\n——\n你收到这封邮件是因为你订阅了 {{site_name}}。\n退订：{{unsubscribe_url}}\n"
	return htmlPart, textPart
}

// Builtin template bodies. They stay deliberately simple: one column, inline styles,
// system font stack, and no images, so they render in every mail client and never
// depend on the site's own styling.

const builtinConfirmHTML = `<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px 16px;background:#f6f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e0;border-radius:14px">
    <tr><td style="padding:32px 32px 8px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a82">{{site_name}}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600">确认订阅</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#4a4a45">我们收到了 {{email}} 的订阅请求。点击下面的按钮完成确认，之后才会开始收到邮件。</p>
      <p style="margin:0 0 24px"><a href="{{confirm_url}}" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:999px">确认订阅</a></p>
      <p style="margin:0 0 18px;font-size:12px;line-height:1.7;color:#8a8a82">按钮无法点击？请复制下面的链接到浏览器打开：<br><a href="{{confirm_url}}" style="color:#4a4a45;word-break:break-all">{{confirm_url}}</a></p>
    </td></tr>
    <tr><td style="padding:8px 32px 30px">
      <hr style="border:0;border-top:1px solid #eeeee8;margin:0 0 16px">
      <p style="margin:0;font-size:12px;line-height:1.7;color:#8a8a82">如果这不是你本人的操作，忽略这封邮件即可，不会有任何订阅发生。<br>不想再收到任何邮件？<a href="{{unsubscribe_url}}" style="color:#8a8a82">退订</a>。</p>
    </td></tr>
  </table>
</body></html>`

const builtinConfirmText = `确认订阅 {{site_name}}

我们收到了 {{email}} 的订阅请求。点击下面的链接完成确认：

{{confirm_url}}

如果这不是你本人的操作，忽略这封邮件即可。
不想再收到任何邮件？退订：{{unsubscribe_url}}
`

const builtinWelcomeHTML = `<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px 16px;background:#f6f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e0;border-radius:14px">
    <tr><td style="padding:32px 32px 30px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a82">{{site_name}}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600">欢迎订阅</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#4a4a45">你已成功订阅 {{site_name}} 的邮件。有新内容时，我们会发送到这里：{{email}}。</p>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#4a4a45">不想再收到邮件？随时可以<a href="{{unsubscribe_url}}" style="color:#4a4a45">退订</a>。</p>
    </td></tr>
  </table>
</body></html>`

const builtinWelcomeText = `欢迎订阅 {{site_name}}

你已成功订阅 {{site_name}} 的邮件。有新内容时，我们会发送到这里：{{email}}。
不想再收到邮件？随时可以退订：{{unsubscribe_url}}
`

const builtinNewsletterHTML = `<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px 16px;background:#f6f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e0;border-radius:14px">
    <tr><td style="padding:32px 32px 30px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a82">{{site_name}}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600">{{content_title}}</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#4a4a45">{{content_summary}}</p>
      <p style="margin:0 0 8px"><a href="{{content_url}}" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:999px">阅读全文</a></p>
    </td></tr>
  </table>
</body></html>`

const builtinNewsletterText = `{{site_name}}

{{content_title}}

{{content_summary}}

阅读全文：{{content_url}}
`

const builtinPasswordResetHTML = `<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px 16px;background:#f6f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e0;border-radius:14px">
    <tr><td style="padding:32px 32px 30px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a82">{{site_name}}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600">重置登录密码</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#4a4a45">我们收到了重置 {{email}} 登录密码的请求。点击下面的按钮设置新密码，链接在一段时间后失效。</p>
      <p style="margin:0 0 24px"><a href="{{reset_url}}" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:999px">重置密码</a></p>
      <p style="margin:0 0 18px;font-size:12px;line-height:1.7;color:#8a8a82">如果这不是你本人的操作，忽略这封邮件即可，密码不会被修改。</p>
    </td></tr>
  </table>
</body></html>`

const builtinPasswordResetText = `重置 {{site_name}} 的登录密码

我们收到了重置 {{email}} 登录密码的请求。打开下面的链接设置新密码：

{{reset_url}}

如果这不是你本人的操作，忽略这封邮件即可。
`

const builtinVerifyHTML = `<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px 16px;background:#f6f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e0;border-radius:14px">
    <tr><td style="padding:32px 32px 30px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a82">{{site_name}}</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600">验证你的邮箱</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#4a4a45">点击下面的按钮验证 {{email}}，完成后即可正常使用账号。</p>
      <p style="margin:0 0 24px"><a href="{{verify_url}}" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:999px">验证邮箱</a></p>
      <p style="margin:0 0 18px;font-size:12px;line-height:1.7;color:#8a8a82">如果这不是你本人的操作，忽略这封邮件即可。</p>
    </td></tr>
  </table>
</body></html>`

const builtinVerifyText = `验证你的邮箱

点击下面的链接验证 {{email}}：

{{verify_url}}

如果这不是你本人的操作，忽略这封邮件即可。
`
