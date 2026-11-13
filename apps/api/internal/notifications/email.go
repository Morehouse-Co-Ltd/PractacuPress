package notifications

import (
	"fmt"
	"html"
	"strings"

	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

// emailEligible reports whether a notification type has a transactional email
// template.
//
// Contact form messages deliberately stay in the in-app inbox: the visitor wrote
// to the site, not to the administrator's private mailbox, and the message is only
// stored in the inbox row.
func emailEligible(t Type) bool {
	switch t {
	case TypeComment, TypeReaction, TypeFollow, TypeModeration:
		return true
	default:
		return false
	}
}

// notificationLink is the inbox URL an email points at.
//
// A deployment without PUBLIC_BASE_URL has no absolute address to put in an email,
// so the link is omitted rather than rendered as a dead relative URL.
func notificationLink(baseURL string) string {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return ""
	}
	return base + "/notifications"
}

// buildNotificationEmail renders one notification as an HTML and plain text email.
//
// Every value that comes from a user is escaped: the payload carries display names,
// titles and comment excerpts, and a mail client renders HTML with no sandbox.
func buildNotificationEmail(item Notification, to, actorName, link string) (mailer.Message, bool) {
	if !emailEligible(item.Type) {
		return mailer.Message{}, false
	}
	if actorName == "" {
		actorName = "有人"
	}

	title := strings.TrimSpace(item.Payload["title"])
	if title == "" {
		title = "你的内容"
	}
	excerpt := strings.TrimSpace(item.Payload["excerpt"])

	subject, lead, detail := emailCopy(item, actorName, title, excerpt)

	var text strings.Builder
	text.WriteString("你好：\n\n")
	text.WriteString(lead)
	text.WriteString("\n")
	if detail != "" {
		text.WriteString("\n")
		text.WriteString(detail)
		text.WriteString("\n")
	}
	if link != "" {
		text.WriteString("\n在站内查看：\n")
		text.WriteString(link)
		text.WriteString("\n")
	}
	text.WriteString("\n—— Practacu Press\n")

	escapedLink := html.EscapeString(link)
	escapedLead := html.EscapeString(lead)
	escapedDetail := html.EscapeString(detail)
	escapedTitle := html.EscapeString(title)

	var body strings.Builder
	body.WriteString(`<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:32px 16px;background:#f6f6f3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#1c1c1a">
  <table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e0;border-radius:14px">
    <tr><td style="padding:32px 32px 8px">
      <p style="margin:0 0 18px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a82">Practacu Press</p>
      <h1 style="margin:0 0 16px;font-size:22px;font-weight:600">`)
	body.WriteString(escapedTitle)
	body.WriteString(`</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#4a4a45">`)
	body.WriteString(escapedLead)
	body.WriteString(`</p>`)
	if escapedDetail != "" {
		body.WriteString(`
      <p style="margin:0 0 18px;padding:12px 14px;background:#f6f6f3;border-radius:10px;font-size:13px;line-height:1.7;color:#4a4a45">`)
		body.WriteString(escapedDetail)
		body.WriteString(`</p>`)
	}
	if escapedLink != "" {
		body.WriteString(`
      <p style="margin:0 0 24px">
        <a href="`)
		body.WriteString(escapedLink)
		body.WriteString(`" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:999px">在站内查看</a>
      </p>`)
	}
	body.WriteString(`
    </td></tr>
    <tr><td style="padding:8px 32px 30px">
      <hr style="border:0;border-top:1px solid #eeeee8;margin:0 0 16px">
      <p style="margin:0;font-size:12px;line-height:1.7;color:#8a8a82">这封邮件由系统发出，不需要回复。你可以在「通知设置」里调整或关闭邮件通知。</p>
    </td></tr>
  </table>
</body></html>`)

	return mailer.Message{
		To:      []string{to},
		Subject: subject,
		Text:    text.String(),
		HTML:    body.String(),
	}, true
}

// emailCopy returns the subject, the leading sentence and the optional excerpt.
func emailCopy(item Notification, actorName, title, excerpt string) (string, string, string) {
	switch item.Type {
	case TypeComment:
		if item.Payload["reply"] == "1" {
			lead := fmt.Sprintf("%s 回复了你的评论。", actorName)
			return "有人回复了你的评论", lead, excerpt
		}
		lead := fmt.Sprintf("%s 评论了《%s》。", actorName, title)
		return "有人评论了你的内容", lead, excerpt
	case TypeReaction:
		lead := fmt.Sprintf("%s 赞了《%s》。", actorName, title)
		return "有人赞了你的内容", lead, ""
	case TypeFollow:
		lead := fmt.Sprintf("%s 开始关注你。", actorName)
		return "有人关注了你", lead, ""
	case TypeModeration:
		lead := fmt.Sprintf("《%s》的审核结果已更新。", title)
		if excerpt == "" {
			excerpt = strings.TrimSpace(item.Payload["reason"])
		}
		return "你的内容审核结果已更新", lead, excerpt
	default:
		return "你有新的站内通知", "你有一条新的站内通知。", excerpt
	}
}
