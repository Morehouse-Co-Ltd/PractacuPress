// Package mailer sends transactional email over SMTP.
//
// It deliberately supports only what a small publishing install needs: one relay,
// optional authentication, and the three encryption modes real relays speak. Mail is
// an optional capability of the process, so an unconfigured Sender reports itself as
// such instead of pretending a message went out.
package mailer

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// Encryption modes. They mirror config.SMTP* constants without importing the
// configuration package, so the mailer stays a leaf.
const (
	// EncryptionSSL wraps the connection in TLS before the SMTP handshake (465).
	EncryptionSSL = "ssl"
	// EncryptionStartTLS upgrades a plaintext connection (587).
	EncryptionStartTLS = "starttls"
	// EncryptionNone is plaintext, accepted only for a loopback relay.
	EncryptionNone = "none"
)

// Delivery timeouts. A stuck relay must never hold a request open: the caller
// already answered the client by the time the message is handed over.
const (
	dialTimeout   = 10 * time.Second
	sendTimeout   = 20 * time.Second
	maxRecipients = 10
)

// Message is one outbound email.
type Message struct {
	To      []string
	Subject string
	Text    string
	HTML    string
}

// Sender delivers a message.
//
// Configured is part of the contract: callers use it to decide whether an email
// backed feature (password reset) is available at all.
type Sender interface {
	Send(ctx context.Context, msg Message) error
	Configured() bool
}

// Config describes one SMTP relay.
type Config struct {
	Host       string
	Port       int
	Encryption string
	Username   string
	Password   string
	From       string
	FromName   string
	// Timeout bounds one delivery attempt. Zero means sendTimeout.
	Timeout time.Duration
}

// SMTP is the net/smtp backed Sender.
type SMTP struct {
	host       string
	port       int
	encryption string
	username   string
	password   string
	from       mail.Address
	timeout    time.Duration
	tlsConfig  *tls.Config
}

var _ Sender = (*SMTP)(nil)

// New validates cfg and returns a Sender.
func New(cfg Config) (*SMTP, error) {
	host := strings.TrimSpace(cfg.Host)
	if host == "" {
		return nil, errors.New("mailer: host is required")
	}
	if cfg.Port < 1 || cfg.Port > 65535 {
		return nil, errors.New("mailer: port must be between 1 and 65535")
	}

	encryption := strings.ToLower(strings.TrimSpace(cfg.Encryption))
	switch encryption {
	case "":
		encryption = EncryptionStartTLS
	case EncryptionSSL, EncryptionStartTLS, EncryptionNone:
	default:
		return nil, fmt.Errorf("mailer: unsupported encryption %q", cfg.Encryption)
	}

	from := strings.TrimSpace(cfg.From)
	if from == "" {
		return nil, errors.New("mailer: from address is required")
	}
	address, err := mail.ParseAddress(from)
	if err != nil {
		return nil, fmt.Errorf("mailer: from address is malformed: %w", err)
	}
	if name := strings.TrimSpace(cfg.FromName); name != "" {
		address.Name = name
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = sendTimeout
	}

	return &SMTP{
		host:       host,
		port:       cfg.Port,
		encryption: encryption,
		username:   cfg.Username,
		password:   cfg.Password,
		from:       *address,
		timeout:    timeout,
		tlsConfig: &tls.Config{
			ServerName: host,
			MinVersion: tls.VersionTLS12,
		},
	}, nil
}

// Configured always reports true: a nil SMTP is the unconfigured case.
func (s *SMTP) Configured() bool { return s != nil && s.host != "" }

// Send renders and delivers one message.
func (s *SMTP) Send(ctx context.Context, msg Message) error {
	if !s.Configured() {
		return errors.New("mailer: no relay configured")
	}
	if len(msg.To) == 0 {
		return errors.New("mailer: no recipients")
	}
	if len(msg.To) > maxRecipients {
		return fmt.Errorf("mailer: at most %d recipients per message", maxRecipients)
	}

	recipients := make([]mail.Address, 0, len(msg.To))
	for _, raw := range msg.To {
		address, err := mail.ParseAddress(strings.TrimSpace(raw))
		if err != nil {
			// Never echo the address: a malformed value can carry a header
			// injection attempt, and the caller only needs to know it was refused.
			return errors.New("mailer: recipient address is malformed")
		}
		recipients = append(recipients, *address)
	}

	raw, err := s.render(msg, recipients)
	if err != nil {
		return err
	}
	return s.deliver(ctx, raw, recipients)
}

// render builds the RFC 5322 message. Every header value is either encoded or
// rejected, so a subject full of newlines cannot smuggle extra headers.
func (s *SMTP) render(msg Message, recipients []mail.Address) ([]byte, error) {
	subject := sanitizeHeader(msg.Subject)
	if subject == "" {
		return nil, errors.New("mailer: subject is required")
	}

	encodedTo := make([]string, 0, len(recipients))
	for _, address := range recipients {
		encodedTo = append(encodedTo, address.String())
	}

	var body strings.Builder
	body.WriteString("From: " + s.from.String() + "\r\n")
	body.WriteString("To: " + strings.Join(encodedTo, ", ") + "\r\n")
	body.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	body.WriteString("Date: " + time.Now().Format(time.RFC1123Z) + "\r\n")
	body.WriteString("Message-ID: <" + randomID() + "@" + s.host + ">\r\n")
	body.WriteString("MIME-Version: 1.0\r\n")

	switch {
	case msg.HTML == "" && msg.Text == "":
		body.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
		body.WriteString("Content-Transfer-Encoding: 7bit\r\n\r\n")
	case msg.HTML == "":
		body.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
		body.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		body.WriteString(wrapBase64(msg.Text))
		body.WriteString("\r\n")
	default:
		boundary := "pp-" + randomID()
		body.WriteString("Content-Type: multipart/alternative; boundary=\"" + boundary + "\"\r\n\r\n")
		body.WriteString("--" + boundary + "\r\n")
		body.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
		body.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		body.WriteString(wrapBase64(msg.Text))
		body.WriteString("\r\n--" + boundary + "\r\n")
		body.WriteString("Content-Type: text/html; charset=UTF-8\r\n")
		body.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		body.WriteString(wrapBase64(msg.HTML))
		body.WriteString("\r\n--" + boundary + "--\r\n")
	}
	return []byte(body.String()), nil
}

func (s *SMTP) deliver(ctx context.Context, raw []byte, recipients []mail.Address) error {
	address := net.JoinHostPort(s.host, strconv.Itoa(s.port))

	dialer := &net.Dialer{Timeout: dialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return fmt.Errorf("mailer: dial %s: %w", address, err)
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(s.timeout))
	}

	if s.encryption == EncryptionSSL {
		tlsConn := tls.Client(conn, s.tlsConfig)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			_ = conn.Close()
			return fmt.Errorf("mailer: tls handshake: %w", err)
		}
		conn = tlsConn
	}

	client, err := smtp.NewClient(conn, s.host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("mailer: greeting: %w", err)
	}
	defer func() { _ = client.Close() }()

	if s.encryption == EncryptionStartTLS {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			return errors.New("mailer: relay does not offer STARTTLS")
		}
		if err := client.StartTLS(s.tlsConfig); err != nil {
			return fmt.Errorf("mailer: starttls: %w", err)
		}
	}

	if s.username != "" {
		if ok, _ := client.Extension("AUTH"); !ok {
			return errors.New("mailer: relay does not offer AUTH")
		}
		auth := smtp.PlainAuth("", s.username, s.password, s.host)
		if err := client.Auth(auth); err != nil {
			return fmt.Errorf("mailer: authenticate: %w", err)
		}
	}

	if err := client.Mail(s.from.Address); err != nil {
		return fmt.Errorf("mailer: envelope sender rejected: %w", err)
	}
	for _, recipient := range recipients {
		if err := client.Rcpt(recipient.Address); err != nil {
			return fmt.Errorf("mailer: recipient rejected: %w", err)
		}
	}

	writer, err := client.Data()
	if err != nil {
		return fmt.Errorf("mailer: open data: %w", err)
	}
	if _, err := writer.Write(raw); err != nil {
		_ = writer.Close()
		return fmt.Errorf("mailer: write body: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("mailer: close body: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("mailer: quit: %w", err)
	}
	return nil
}

// sanitizeHeader strips CR and LF so a value can never terminate a header early.
func sanitizeHeader(value string) string {
	return strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ").Replace(value))
}

// wrapBase64 encodes text and wraps it at 76 columns, as MIME requires.
func wrapBase64(text string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(text))
	var out strings.Builder
	for len(encoded) > 76 {
		out.WriteString(encoded[:76])
		out.WriteString("\r\n")
		encoded = encoded[76:]
	}
	out.WriteString(encoded)
	return out.String()
}

func randomID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(buf)
}
