package auth

import (
	"testing"
	"time"
)

// TestTOTPMatchesRFC6238Vectors pins the implementation to the published SHA-1
// test vectors. The RFC prints eight digits; this product uses six, so the expected
// value is the last six digits of each vector.
//
// Secret: the ASCII string "12345678901234567890" (base32 below).
func TestTOTPMatchesRFC6238Vectors(t *testing.T) {
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	vectors := []struct {
		unix int64
		want string
	}{
		{59, "287082"},
		{1111111109, "081804"},
		{1111111111, "050471"},
		{1234567890, "005924"},
		{2000000000, "279037"},
		{20000000000, "353130"},
	}
	for _, vector := range vectors {
		step := totpStepOf(time.Unix(vector.unix, 0))
		got, err := totpCode(secret, step)
		if err != nil {
			t.Fatalf("totpCode(%d): %v", vector.unix, err)
		}
		if got != vector.want {
			t.Errorf("code at T=%d = %q, want %q", vector.unix, got, vector.want)
		}
	}
}

func TestVerifyTOTPAcceptsOnlyTheDriftWindow(t *testing.T) {
	const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	now := time.Unix(1_700_000_000, 0).UTC()
	current := totpStepOf(now)

	previous, err := totpCode(secret, current-1)
	if err != nil {
		t.Fatal(err)
	}
	next, err := totpCode(secret, current+1)
	if err != nil {
		t.Fatal(err)
	}
	tooOld, err := totpCode(secret, current-2)
	if err != nil {
		t.Fatal(err)
	}

	if step, ok := verifyTOTP(secret, previous, now, TOTPDriftSteps); !ok || step != current-1 {
		t.Fatalf("previous step rejected: step=%d ok=%v", step, ok)
	}
	if step, ok := verifyTOTP(secret, next, now, TOTPDriftSteps); !ok || step != current+1 {
		t.Fatalf("next step rejected: step=%d ok=%v", step, ok)
	}
	if _, ok := verifyTOTP(secret, tooOld, now, TOTPDriftSteps); ok {
		t.Fatal("a code two steps old must be rejected")
	}
	if _, ok := verifyTOTP(secret, "12345", now, TOTPDriftSteps); ok {
		t.Fatal("a short code must be rejected")
	}
	if _, ok := verifyTOTP(secret, "abcdef", now, TOTPDriftSteps); ok {
		t.Fatal("a non numeric code must be rejected")
	}
}

func TestSecretBoxRoundTripsAndHidesPlaintext(t *testing.T) {
	key := deriveSecretKey([]byte("0123456789abcdef0123456789abcdef"))
	box, err := newSecretBox(key)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := box.Seal("JBSWY3DPEHPK3PXP")
	if err != nil {
		t.Fatal(err)
	}
	if sealed == "JBSWY3DPEHPK3PXP" || len(sealed) <= len(sealedSecretPrefix) {
		t.Fatalf("seal returned an unusable envelope %q", sealed)
	}
	plain, err := box.Open(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if plain != "JBSWY3DPEHPK3PXP" {
		t.Fatalf("round trip = %q", plain)
	}
	if _, err := box.Open(sealed + "x"); err == nil {
		t.Fatal("a tampered envelope must not open")
	}
	if _, err := box.Open("JBSWY3DPEHPK3PXP"); err == nil {
		t.Fatal("a plaintext value must not open")
	}
}

func TestRecoveryCodesAreCanonicalisedAndHashed(t *testing.T) {
	codes, hashes, err := newRecoveryCodes(3)
	if err != nil {
		t.Fatal(err)
	}
	if len(codes) != 3 || len(hashes) != 3 {
		t.Fatalf("generated %d codes / %d hashes", len(codes), len(hashes))
	}
	for i, code := range codes {
		if len(normalizeRecoveryCode(code)) != recoveryCodeLength {
			t.Fatalf("code %q has the wrong canonical length", code)
		}
		if hashes[i] != hashRecoveryCode(normalizeRecoveryCode(code)) {
			t.Fatalf("hash %d does not match its code", i)
		}
		if hashes[i] == normalizeRecoveryCode(code) {
			t.Fatal("recovery code must not be stored in plaintext")
		}
	}
}
