package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// TOTP parameters (FSD F-04).
//
// The defaults are the ones every mainstream authenticator app assumes: RFC 6238
// with HMAC-SHA1, six digits and a thirty second time step. Nothing here is
// configurable on purpose: a deployment specific digit count or step would need a
// matching otpauth hint in the enrollment URI and would still break any app that
// ignores it.
const (
	// TOTPPeriod is the RFC 6238 time step.
	TOTPPeriod = 30 * time.Second
	// TOTPDigits is the number of decimal digits in one code.
	TOTPDigits = 6
	// TOTPSecretBytes is the entropy of a new shared secret (160 bits, the size
	// RFC 4226 recommends for HMAC-SHA1).
	TOTPSecretBytes = 20
	// TOTPDriftSteps is the accepted clock drift: one step either way. A wider
	// window would make replay easier and a narrower one would reject phones whose
	// clock is a few seconds off.
	TOTPDriftSteps = 1
	// twoFactorIssuer is the label authenticator apps display above the account.
	twoFactorIssuer = "Practacu Press"
)

// totpEncoding is the unpadded base32 alphabet every authenticator expects.
// Padding would have to be URL escaped in the otpauth URI and some apps reject it.
var totpEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// newTOTPSecret mints a fresh base32 shared secret.
func newTOTPSecret() (string, error) {
	buf := make([]byte, TOTPSecretBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("auth: generate totp secret: %w", err)
	}
	return totpEncoding.EncodeToString(buf), nil
}

// normalizeTOTPSecret accepts the shapes a user may paste from an authenticator:
// lower case, grouped with spaces or dashes, or with base32 padding.
func normalizeTOTPSecret(secret string) string {
	replacer := strings.NewReplacer(" ", "", "-", "", "\t", "", "\n", "")
	return strings.ToUpper(strings.TrimRight(replacer.Replace(strings.TrimSpace(secret)), "="))
}

// totpStepOf maps an instant to its RFC 6238 time step.
//
// Negative Unix timestamps are irrelevant for this product, but the division is
// still floor based so the function is correct for any instant.
func totpStepOf(at time.Time) int64 {
	seconds := at.Unix()
	if seconds >= 0 {
		return seconds / int64(TOTPPeriod/time.Second)
	}
	step := int64(TOTPPeriod / time.Second)
	return -((-seconds + step - 1) / step)
}

// totpCode computes the code of one time step.
func totpCode(secret string, step int64) (string, error) {
	key, err := totpEncoding.DecodeString(normalizeTOTPSecret(secret))
	if err != nil {
		return "", fmt.Errorf("auth: totp secret is not base32: %w", err)
	}
	if len(key) == 0 {
		return "", fmt.Errorf("auth: totp secret is empty")
	}

	// RFC 4226 §5.3: the counter is a big endian 64 bit value.
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))

	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)

	// RFC 4226 §5.4 dynamic truncation.
	offset := sum[len(sum)-1] & 0x0f
	binaryCode := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	mod := uint32(1)
	for i := 0; i < TOTPDigits; i++ {
		mod *= 10
	}
	code := binaryCode % mod
	return fmt.Sprintf("%0*d", TOTPDigits, code), nil
}

// verifyTOTP reports which time step a submitted code belongs to.
//
// The comparison is constant time, and the newest step inside the drift window is
// returned first so a code that happens to be valid for two neighbouring steps
// always advances the replay guard rather than rewinding it. The returned step is
// strictly meaningful only when ok is true.
func verifyTOTP(secret, code string, at time.Time, drift int) (int64, bool) {
	if drift < 0 {
		drift = 0
	}
	candidate := strings.TrimSpace(code)
	if len(candidate) != TOTPDigits {
		return 0, false
	}
	for _, r := range candidate {
		if r < '0' || r > '9' {
			return 0, false
		}
	}

	current := totpStepOf(at)
	for step := current + int64(drift); step >= current-int64(drift); step-- {
		expected, err := totpCode(secret, step)
		if err != nil {
			return 0, false
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(candidate)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// totpProvisioningURI renders the otpauth:// URI an authenticator scans.
//
// The issuer appears both as the label prefix and as a query parameter because
// apps disagree about which one they read; the secret is the unpadded base32 form.
func totpProvisioningURI(issuer, account, secret string) string {
	label := url.PathEscape(issuer + ":" + account)
	query := url.Values{}
	query.Set("secret", normalizeTOTPSecret(secret))
	query.Set("issuer", issuer)
	query.Set("algorithm", "SHA1")
	query.Set("digits", strconv.Itoa(TOTPDigits))
	query.Set("period", strconv.Itoa(int(TOTPPeriod/time.Second)))
	return "otpauth://totp/" + label + "?" + query.Encode()
}
