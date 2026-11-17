package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

// Email kinds. The kind decides which panel the row shows up in: a verification mail
// is system noise while a newsletter is a campaign the operator sent on purpose.
const (
	EmailKindSystem     = "system"
	EmailKindNewsletter = "newsletter"
)

// Email delivery states.
const (
	EmailStatusQueued  = "queued"
	EmailStatusSent    = "sent"
	EmailStatusFailed  = "failed"
	EmailStatusSkipped = "skipped"
)

// EmailLog is one outbound message the installation tried to deliver.
//
// It exists because "mail is configured" used to be unverifiable: an operator could
// only check the relay's logs. Every send path now writes a row before handing the
// message to the SMTP client and updates it with the outcome, which is what the
// dashboard's mail log reads. The body is never stored (it can contain a password
// reset link), only the subject and the template key.
type EmailLog struct{ ent.Schema }

// Fields of EmailLog.
func (EmailLog) Fields() []ent.Field {
	return []ent.Field{
		idField(),
		siteIDField(),
		field.String("to_email").MaxLen(320).NotEmpty(),
		field.String("kind").
			Default(EmailKindSystem).
			Validate(oneOf(EmailKindSystem, EmailKindNewsletter)),
		field.String("template_key").MaxLen(80).Default(""),
		field.String("subject").MaxLen(300).Default(""),
		field.String("status").
			Default(EmailStatusQueued).
			Validate(oneOf(EmailStatusQueued, EmailStatusSent, EmailStatusFailed, EmailStatusSkipped)),
		// error keeps the relay's last failure, bounded so a chatty SMTP server cannot
		// grow the row without bound.
		field.String("error").MaxLen(500).Optional().Nillable(),
		// provider_message_id is whatever the relay returned, when it returns anything.
		field.String("provider_message_id").MaxLen(200).Optional().Nillable(),
		// subscriber_id links a newsletter delivery to the list entry it was sent to.
		field.String("subscriber_id").MaxLen(36).Optional().Nillable(),
		field.Time("sent_at").Optional().Nillable(),
		createdField(),
	}
}

// Indexes of EmailLog.
func (EmailLog) Indexes() []ent.Index {
	return []ent.Index{
		// The admin log: one site, newest first.
		index.Fields("site_id", "created_at"),
		// The queue view: what is still waiting or failed.
		index.Fields("site_id", "status", "created_at"),
	}
}
