package notifications

import "fmt"

// Contact is the one notification the public contact form produces.
//
// The inbox row is the whole delivery mechanism on purpose: the reader's message is
// not stored anywhere else, so there is no second copy to expire, export or leak, and
// no table is added for a feature that only ever needs to reach a site administrator.
const (
	// MaxContactMessageLength bounds the submitted message, in characters.
	MaxContactMessageLength = 2000
	// maxContactMessageBytes is the byte ceiling of the payload value that carries it.
	//
	// Payload values are capped at MaxPayloadValueLength bytes everywhere else. The
	// contact message is the one value that has to survive in full: a Chinese message
	// is up to three bytes per character, so a 2000 character limit needs 6000 bytes,
	// and the extra room keeps a four-byte emoji from turning a legal submission into
	// a rejected one.
	maxContactMessageBytes = 4 * MaxContactMessageLength
	// maxContactSubjectLength bounds the generated subject line.
	maxContactSubjectLength = 120
)

// ContactInput is one message submitted from the public contact form.
//
// Name and Email are optional: the block can hide either field, so the server cannot
// expect them. Everything here is plain text and stays plain text — the inbox renders
// it as text, never as markup.
type ContactInput struct {
	Name    string
	Email   string
	Message string
}

// ContactSubject is the subject line of a contact notification.
//
// It is built on the server so the wording lives next to the type that needs it and
// the payload cannot be assembled differently by two callers.
func ContactSubject(name string) string {
	if name == "" {
		return "站点来信"
	}
	return fmt.Sprintf("站点来信：%s", name)
}

// ContactNotification builds the inbox entry one administrator receives.
//
// The payload keys are the ones the inbox already understands (`subject` plus a plain
// text body); adding a new type therefore needs no change to how a row is rendered.
func ContactNotification(siteID, userID string, in ContactInput) NewInput {
	subject := ContactSubject(in.Name)
	if len(subject) > maxContactSubjectLength {
		// Only reachable with a name at the bound already; keep the value legal even
		// when every character is multi-byte.
		subject = subject[:maxContactSubjectLength]
	}

	payload := map[string]string{
		"subject": subject,
		"message": in.Message,
	}
	if in.Name != "" {
		payload["name"] = in.Name
	}
	if in.Email != "" {
		payload["email"] = in.Email
	}

	return NewInput{
		SiteID: siteID,
		UserID: userID,
		Type:   TypeContact,
		// No ActorID: the sender is an anonymous visitor with no account, so the row
		// has no actor to link and cannot trip the self-notification guard.
		Payload: payload,
	}
}
