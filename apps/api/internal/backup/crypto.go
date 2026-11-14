package backup

// Encrypted package format (PPBAK1).
//
// An encrypted whole-instance package is the same zip the plaintext package
// carries, wrapped in a streaming, chunked AES-256-GCM envelope:
//
//	header        magic[:7] || nonce_prefix[:4]
//	chunk         length[:4] (big endian) || sealed (length + 16 byte tag)
//	...
//	eof chunk     length[:4] == 0        || 16 byte tag over empty plaintext
//
// The nonce of chunk n is nonce_prefix || uint64_be(n), so a nonce is never
// reused even though every package has its own random 4-byte prefix. The AAD of
// chunk n is magic || uint64_be(n): it binds the payload to this format and to
// its position, so chunks cannot be reordered, replayed from another package or
// truncated without failing authentication.
//
// A zero-length chunk is the authenticated end marker. It is written as a normal
// GCM record (a tag over empty plaintext), which is what makes truncation
// detectable: a package that simply stops on a chunk boundary is missing its end
// record and fails loudly instead of yielding a shorter zip that might still
// parse.
//
// The format is only applied to whole-instance backup packages
// (id + ".ppbak"). Site exports stay plain zips.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	// EncryptionMagic prefixes every encrypted package. It lets a reader decide
	// whether the file needs decryption before it opens the zip.
	EncryptionMagic = "PPBAK1\n"
	// EncryptionKeySize is the required AES-256 key length in bytes.
	EncryptionKeySize = 32
	// EncryptionChunkSize is the plaintext size of one authenticated chunk.
	EncryptionChunkSize = 1 << 20 // 1 MiB
	// EncryptionNoncePrefixSize is the random per-file part of every nonce.
	EncryptionNoncePrefixSize = 4
	// encryptionCounterSize is the big-endian chunk counter inside the nonce.
	encryptionCounterSize = 8
	// gcmNonceSize is the standard AES-GCM nonce size.
	gcmNonceSize = 12
)

// EncryptWriter returns a writer that encrypts everything written to w as a
// PPBAK1 package. The header is written immediately. Close must be called to
// flush the last chunk and the authenticated end marker.
func EncryptWriter(w io.Writer, key []byte) (io.WriteCloser, error) {
	aead, err := newChunkAEAD(key)
	if err != nil {
		return nil, err
	}
	prefix := make([]byte, EncryptionNoncePrefixSize)
	if _, err := rand.Read(prefix); err != nil {
		return nil, fmt.Errorf("backup: generate nonce prefix: %w", err)
	}
	header := make([]byte, 0, len(EncryptionMagic)+len(prefix))
	header = append(header, EncryptionMagic...)
	header = append(header, prefix...)
	if _, err := w.Write(header); err != nil {
		return nil, fmt.Errorf("backup: write encrypted package header: %w", err)
	}
	var prefixArray [EncryptionNoncePrefixSize]byte
	copy(prefixArray[:], prefix)
	return &encryptWriter{
		destination: w,
		aead:        aead,
		prefix:      prefixArray,
		buffer:      make([]byte, 0, EncryptionChunkSize),
	}, nil
}

// encryptWriter streams plaintext into authenticated chunks.
type encryptWriter struct {
	destination io.Writer
	aead        cipher.AEAD
	prefix      [EncryptionNoncePrefixSize]byte
	counter     uint64
	buffer      []byte
	closed      bool
}

// Write buffers plaintext and flushes whole chunks as they fill.
func (e *encryptWriter) Write(p []byte) (int, error) {
	if e.closed {
		return 0, fmt.Errorf("%w: encrypted package writer is closed", ErrInvalidInput)
	}
	e.buffer = append(e.buffer, p...)
	for len(e.buffer) >= EncryptionChunkSize {
		if err := e.writeChunk(e.buffer[:EncryptionChunkSize]); err != nil {
			return 0, err
		}
		e.buffer = append(e.buffer[:0], e.buffer[EncryptionChunkSize:]...)
	}
	return len(p), nil
}

// Close flushes the remainder and the authenticated end marker. It is safe to
// call more than once.
func (e *encryptWriter) Close() error {
	if e.closed {
		return nil
	}
	e.closed = true
	if len(e.buffer) > 0 {
		if err := e.writeChunk(e.buffer); err != nil {
			return err
		}
		e.buffer = nil
	}
	return e.writeChunk(nil)
}

// writeChunk seals one chunk and writes its length prefix and ciphertext.
func (e *encryptWriter) writeChunk(plaintext []byte) error {
	counter := e.counter
	e.counter++
	nonce := chunkNonce(e.prefix, counter)
	aad := chunkAAD(counter)
	sealed := e.aead.Seal(nil, nonce, plaintext, aad)
	var lengthPrefix [4]byte
	binary.BigEndian.PutUint32(lengthPrefix[:], uint32(len(plaintext)))
	if _, err := e.destination.Write(lengthPrefix[:]); err != nil {
		return fmt.Errorf("backup: write encrypted chunk length: %w", err)
	}
	if _, err := e.destination.Write(sealed); err != nil {
		return fmt.Errorf("backup: write encrypted chunk: %w", err)
	}
	return nil
}

// NewDecryptingReader verifies the package header and returns a reader that
// yields the plaintext zip. The caller keeps ownership of r.
func NewDecryptingReader(r io.Reader, key []byte) (io.Reader, error) {
	aead, err := newChunkAEAD(key)
	if err != nil {
		return nil, err
	}
	header := make([]byte, len(EncryptionMagic)+EncryptionNoncePrefixSize)
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, fmt.Errorf("%w: read encrypted package header: %v", ErrInvalidArchive, err)
	}
	if string(header[:len(EncryptionMagic)]) != EncryptionMagic {
		return nil, fmt.Errorf("%w: not an encrypted package", ErrInvalidArchive)
	}
	decrypter := &decryptingReader{source: r, aead: aead}
	copy(decrypter.prefix[:], header[len(EncryptionMagic):])
	return decrypter, nil
}

// decryptingReader yields the authenticated plaintext chunks one at a time.
type decryptingReader struct {
	source   io.Reader
	aead     cipher.AEAD
	prefix   [EncryptionNoncePrefixSize]byte
	counter  uint64
	pending  []byte
	finished bool
	err      error
}

// Read implements io.Reader.
func (d *decryptingReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	for len(d.pending) == 0 {
		if d.err != nil {
			return 0, d.err
		}
		if d.finished {
			return 0, io.EOF
		}
		if err := d.readChunk(); err != nil {
			d.err = err
			return 0, err
		}
	}
	n := copy(p, d.pending)
	d.pending = d.pending[n:]
	return n, nil
}

// readChunk reads, authenticates and buffers one chunk.
func (d *decryptingReader) readChunk() error {
	var lengthPrefix [4]byte
	if _, err := io.ReadFull(d.source, lengthPrefix[:]); err != nil {
		return fmt.Errorf("%w: package is truncated (missing end marker)", ErrDecryptionFailed)
	}
	length := binary.BigEndian.Uint32(lengthPrefix[:])
	if length > EncryptionChunkSize {
		return fmt.Errorf("%w: chunk length %d exceeds %d", ErrInvalidArchive, length, EncryptionChunkSize)
	}
	ciphertext := make([]byte, int(length)+d.aead.Overhead())
	if _, err := io.ReadFull(d.source, ciphertext); err != nil {
		return fmt.Errorf("%w: package is truncated", ErrDecryptionFailed)
	}
	counter := d.counter
	plaintext, err := d.aead.Open(nil, chunkNonce(d.prefix, counter), ciphertext, chunkAAD(counter))
	if err != nil {
		return fmt.Errorf(
			"%w: authentication failed (wrong encryption key or tampered package)",
			ErrDecryptionFailed,
		)
	}
	d.counter++
	if length == 0 {
		// Trailing data after the authenticated end marker means the file was
		// appended to after it was written.
		var probe [1]byte
		if n, _ := io.ReadFull(d.source, probe[:]); n > 0 {
			return fmt.Errorf("%w: trailing data after end of encrypted package", ErrInvalidArchive)
		}
		d.finished = true
		return nil
	}
	d.pending = plaintext
	return nil
}

// IsEncryptedPackage reports whether path starts with the PPBAK1 magic.
func IsEncryptedPackage(path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, ErrNotFound
		}
		return false, err
	}
	defer file.Close()
	header := make([]byte, len(EncryptionMagic))
	if _, err := io.ReadFull(file, header); err != nil {
		// A file too short to carry the header is simply not encrypted; the zip
		// reader reports the real problem.
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return false, nil
		}
		return false, err
	}
	return string(header) == EncryptionMagic, nil
}

// ParseEncryptionKey decodes an operator supplied key. Accepted encodings are 64
// hex characters, standard or URL-safe base64 (padded or raw), or a literal
// 32-byte value. An empty value means "no encryption" and returns a nil key.
func ParseEncryptionKey(value string) ([]byte, error) {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return nil, nil
	}
	encoding := ""
	if i := strings.IndexByte(raw, ':'); i > 0 {
		switch strings.ToLower(raw[:i]) {
		case "hex":
			encoding = "hex"
			raw = strings.TrimSpace(raw[i+1:])
		case "base64", "b64":
			encoding = "base64"
			raw = strings.TrimSpace(raw[i+1:])
		}
	}
	if raw == "" {
		return nil, invalidKeyError(0)
	}
	switch {
	case encoding == "hex", encoding == "" && len(raw) == 2*EncryptionKeySize && isHex(raw):
		decoded, err := hex.DecodeString(raw)
		if err != nil {
			return nil, invalidKeyError(0)
		}
		if len(decoded) != EncryptionKeySize {
			return nil, invalidKeyError(len(decoded))
		}
		return decoded, nil
	default:
		for _, decoder := range []*base64.Encoding{
			base64.StdEncoding,
			base64.RawStdEncoding,
			base64.URLEncoding,
			base64.RawURLEncoding,
		} {
			decoded, err := decoder.DecodeString(raw)
			if err == nil && len(decoded) == EncryptionKeySize {
				return decoded, nil
			}
		}
		// A literal 32 character key is accepted so a deployment can store the
		// raw bytes; anything else is rejected rather than stretched or hashed.
		if encoding == "" && len(raw) == EncryptionKeySize {
			return []byte(raw), nil
		}
		return nil, invalidKeyError(0)
	}
}

// invalidKeyError is the one operator-facing key complaint.
func invalidKeyError(got int) error {
	detail := "the key must be 32 bytes, encoded as 64 hex characters or base64"
	if got > 0 {
		detail = fmt.Sprintf("the key decoded to %d bytes", got)
	}
	return fmt.Errorf("%w: %s", ErrEncryptionKeyInvalid, detail)
}

// isHex reports whether value contains only hexadecimal digits.
func isHex(value string) bool {
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f', r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}

// newChunkAEAD builds AES-256-GCM, rejecting any other key length.
func newChunkAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != EncryptionKeySize {
		return nil, fmt.Errorf(
			"%w: AES-256-GCM requires a %d-byte key, got %d bytes",
			ErrEncryptionKeyInvalid, EncryptionKeySize, len(key),
		)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("backup: build AES cipher: %w", err)
	}
	return cipher.NewGCM(block)
}

// chunkNonce builds the 12-byte nonce for one chunk.
func chunkNonce(prefix [EncryptionNoncePrefixSize]byte, counter uint64) []byte {
	nonce := make([]byte, gcmNonceSize)
	copy(nonce, prefix[:])
	binary.BigEndian.PutUint64(nonce[EncryptionNoncePrefixSize:], counter)
	return nonce
}

// chunkAAD binds one chunk to this format and to its position in the sequence.
func chunkAAD(counter uint64) []byte {
	aad := make([]byte, 0, len(EncryptionMagic)+encryptionCounterSize)
	aad = append(aad, EncryptionMagic...)
	var counterBytes [encryptionCounterSize]byte
	binary.BigEndian.PutUint64(counterBytes[:], counter)
	aad = append(aad, counterBytes[:]...)
	return aad
}
