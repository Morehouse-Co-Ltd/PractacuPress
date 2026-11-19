package middleware

import (
	"compress/gzip"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// errGzipWriterClosed is returned when a writer tries to append body bytes after the
// compressed stream has been finished: those bytes could not be encoded and appending
// them raw would corrupt a body that already advertised gzip.
var errGzipWriterClosed = errors.New("middleware: gzip writer already closed")

// streamingPrefixes are the routes the compressor must not touch.
//
// The event feed is long lived: buffering it through a compressor would hold every
// event until the connection closed. The websocket path is upgraded, so there is no
// gzip body at all. Media downloads carry bytes that are already compressed (images)
// or huge (attachments), so re-encoding them spends CPU to make them bigger before
// the first byte reaches the reader.
var streamingPrefixes = []string{"/api/v1/events", "/api/v1/ws", "/api/v1/media/"}

// gzipWriter encodes the response body on the way out.
//
// Content-Encoding is advertised on the first body byte, never before: a handler that
// declares a status and writes nothing (204, 304, or an empty 200) must not promise an
// encoding, and the design document's 304 path makes that a live case rather than a
// hypothetical one.
type gzipWriter struct {
	gin.ResponseWriter
	writer *gzip.Writer
	// skip marks a status that cannot carry a body, so bytes are passed through
	// untouched instead of being encoded into a stream the client will discard.
	skip bool
	// wrote records that the first body byte was accepted, which is what triggers the
	// Content-Encoding header and the status line flush.
	wrote bool
	// closed records that the stream was finalised, so a later writer (the error
	// translator, the panic recovery) knows the compressor cannot be used any more.
	closed bool
}

func (w *gzipWriter) WriteHeader(code int) {
	// 1xx, 204 and 304 carry no body by definition. Remember it so a later Write does
	// not start an encoded stream the client would have to throw away.
	if code < http.StatusOK || code == http.StatusNoContent || code == http.StatusNotModified {
		w.skip = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *gzipWriter) Write(data []byte) (int, error) {
	if w.skip {
		return w.ResponseWriter.Write(data)
	}
	if w.closed {
		if w.wrote {
			// The encoded body is already on its way: a second one cannot be expressed.
			return 0, errGzipWriterClosed
		}
		// Nothing was encoded and no Content-Encoding was advertised, so a body written
		// after the compressor finished is simply an unencoded body. This is the path
		// the error translator takes when it answers a handler that wrote nothing.
		return w.ResponseWriter.Write(data)
	}
	if !w.wrote {
		w.wrote = true

		// A body of unknown compressed length cannot keep the handler's Content-Length.
		w.Header().Del("Content-Length")
		w.Header().Set("Content-Encoding", "gzip")

		// The status line and headers must reach the wire before the body disappears
		// into the deflate buffer. The error translator and the panic recovery both ask
		// Written() whether a response may still be replaced; a buffered body would look
		// unwritten and be overwritten by a second response.
		w.ResponseWriter.WriteHeaderNow()
	}
	return w.writer.Write(data)
}

// WriteString routes the string helpers through the compressor. The embedded
// ResponseWriter would otherwise write the bytes straight to the connection while the
// response still advertised gzip.
func (w *gzipWriter) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

func (w *gzipWriter) Flush() {
	if !w.skip && !w.closed {
		if !w.wrote {
			w.wrote = true
			w.Header().Del("Content-Length")
			w.Header().Set("Content-Encoding", "gzip")
			w.ResponseWriter.WriteHeaderNow()
		}
		_ = w.writer.Flush()
	}
	w.ResponseWriter.Flush()
}

// Unwrap lets http.ResponseController reach the real connection.
//
// The request timeout middleware sets a write deadline through the controller; a
// wrapper that hid the connection would silently disable that deadline for every
// compressed response.
func (w *gzipWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// Close finalises the stream. It is safe to call once per request.
func (w *gzipWriter) Close() error {
	w.closed = true
	if w.skip || !w.wrote {
		// No body byte was ever accepted, so no stream was started and the response
		// stays a valid empty response.
		return nil
	}
	return w.writer.Close()
}

// Gzip compresses API responses with the standard library.
//
// The API serves the site design document - up to 1 MiB - on every page load, and the
// desktop build talks to the process directly, bypassing the reverse proxy that used to
// be the only thing compressing it. Long-lived routes (the event feed, the websocket
// upgrade) and media downloads are skipped: buffering them would stall the stream, and
// an image is already compressed.
func Gzip() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !strings.Contains(c.GetHeader("Accept-Encoding"), "gzip") {
			c.Next()
			return
		}
		for _, prefix := range streamingPrefixes {
			if strings.HasPrefix(c.Request.URL.Path, prefix) {
				c.Next()
				return
			}
		}
		// A connection that is about to be upgraded is not an HTTP body; wrapping it
		// would keep the handshake in the compressor's buffer.
		if c.GetHeader("Upgrade") != "" {
			c.Next()
			return
		}

		// Vary is unconditional: a shared cache must key the response on the encoding
		// whether or not this particular response ended up compressed.
		c.Header("Vary", "Accept-Encoding")

		writer := &gzipWriter{ResponseWriter: c.Writer, writer: gzip.NewWriter(c.Writer)}
		c.Writer = writer
		// Deferred, not sequential: a panic unwinds through here before the recovery
		// middleware writes its 500, and finishing the stream first is what keeps that
		// body readable instead of truncating a half-written encoded response.
		defer func() {
			if err := writer.Close(); err != nil {
				_ = c.Error(err)
			}
		}()
		c.Next()
	}
}
