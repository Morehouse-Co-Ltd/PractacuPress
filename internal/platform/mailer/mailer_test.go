package mailer_test

import (
	"bufio"
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/mailer"
)

// fakeRelay speaks just enough SMTP for the client to deliver one message, then
// returns the transcript. It is what proves the package speaks the protocol and not
// merely builds a nice struct.
type fakeRelay struct {
	listener   net.Listener
	mu         sync.Mutex
	transcript []string
	done       chan struct{}
}

func newFakeRelay(t *testing.T) *fakeRelay {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	relay := &fakeRelay{listener: listener, done: make(chan struct{})}
	go relay.serve()
	t.Cleanup(func() {
		_ = listener.Close()
		<-relay.done
	})
	return relay
}

func (r *fakeRelay) port() int { return r.listener.Addr().(*net.TCPAddr).Port }

func (r *fakeRelay) lines() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.transcript...)
}

func (r *fakeRelay) serve() {
	defer close(r.done)
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			return
		}
		r.handle(conn)
	}
}

func (r *fakeRelay) handle(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	reader := bufio.NewReader(conn)
	write := func(line string) {
		_, _ = conn.Write([]byte(line + "\r\n"))
		r.mu.Lock()
		r.transcript = append(r.transcript, "S: "+line)
		r.mu.Unlock()
	}

	write("220 fake.relay ESMTP")

	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")
		r.mu.Lock()
		r.transcript = append(r.transcript, "C: "+line)
		r.mu.Unlock()

		verb := strings.ToUpper(strings.SplitN(line, " ", 2)[0])
		switch verb {
		case "EHLO", "HELO":
			write("250-fake.relay")
			write("250 8BITMIME")
		case "MAIL", "RCPT":
			write("250 OK")
		case "DATA":
			write("354 Send data")
			for {
				dataLine, err := reader.ReadString('\n')
				if err != nil {
					return
				}
				trimmed := strings.TrimRight(dataLine, "\r\n")
				if trimmed == "." {
					break
				}
				r.mu.Lock()
				r.transcript = append(r.transcript, "D: "+trimmed)
				r.mu.Unlock()
			}
			write("250 Queued")
		case "QUIT":
			write("221 Bye")
			return
		default:
			write("250 OK")
		}
	}
}

func TestSMTPSendSpeaksTheProtocol(t *testing.T) {
	relay := newFakeRelay(t)

	sender, err := mailer.New(mailer.Config{
		Host:       "127.0.0.1",
		Port:       relay.port(),
		Encryption: mailer.EncryptionNone,
		From:       "noreply@example.com",
		FromName:   "Practacu Press",
		Timeout:    3 * time.Second,
	})
	require.NoError(t, err)
	require.True(t, sender.Configured())

	err = sender.Send(context.Background(), mailer.Message{
		To:      []string{"alice@example.com"},
		Subject: "重置你的账户密码",
		Text:    "打开这个链接：https://press.example.com/reset-password?token=abc",
		HTML:    "<p>打开这个链接</p>",
	})
	require.NoError(t, err)

	transcript := strings.Join(relay.lines(), "\n")
	require.Contains(t, transcript, "C: EHLO")
	require.Contains(t, transcript, "C: MAIL FROM:<noreply@example.com>")
	require.Contains(t, transcript, "C: RCPT TO:<alice@example.com>")
	require.Contains(t, transcript, "C: DATA")
	require.Contains(t, transcript, "D: Subject: =?utf-8?q?")
	require.Contains(t, transcript, "D: Content-Type: multipart/alternative")
	require.Contains(t, transcript, "C: QUIT")
}

func TestSMTPRejectsHeaderInjection(t *testing.T) {
	relay := newFakeRelay(t)
	sender, err := mailer.New(mailer.Config{
		Host:       "127.0.0.1",
		Port:       relay.port(),
		Encryption: mailer.EncryptionNone,
		From:       "noreply@example.com",
	})
	require.NoError(t, err)

	require.NoError(t, sender.Send(context.Background(), mailer.Message{
		To:      []string{"alice@example.com"},
		Subject: "hello\r\nBcc: victim@example.com",
		Text:    "body",
	}))

	transcript := strings.Join(relay.lines(), "\n")
	require.NotContains(t, transcript, "D: Bcc:")
}

func TestSMTPRejectsMalformedRecipient(t *testing.T) {
	sender, err := mailer.New(mailer.Config{
		Host:       "127.0.0.1",
		Port:       2525,
		Encryption: mailer.EncryptionNone,
		From:       "noreply@example.com",
	})
	require.NoError(t, err)

	err = sender.Send(context.Background(), mailer.Message{
		To:      []string{"alice@example.com\r\nRCPT TO:<victim@example.com>"},
		Subject: "hello",
		Text:    "body",
	})
	require.Error(t, err)
}

func TestNewValidatesConfig(t *testing.T) {
	_, err := mailer.New(mailer.Config{Port: 587, From: "a@b.c"})
	require.Error(t, err, "a missing host must be refused")

	_, err = mailer.New(mailer.Config{Host: "smtp.example.com", Port: 0, From: "a@b.c"})
	require.Error(t, err, "a port outside 1-65535 must be refused")

	_, err = mailer.New(mailer.Config{Host: "smtp.example.com", Port: 587, From: "not an address"})
	require.Error(t, err, "a malformed sender must be refused")

	_, err = mailer.New(mailer.Config{
		Host: "smtp.example.com", Port: 587, Encryption: "carrier-pigeon", From: "a@b.c",
	})
	require.Error(t, err, "an unknown encryption mode must be refused")
}
