//! Argon2id password hashing.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroize;

/// Password length bounds. They are enforced before hashing so an oversized input
/// cannot be used to burn CPU.
pub const MIN_LENGTH: usize = 8;
pub const MAX_LENGTH: usize = 128;

/// Upper bound on the stored PHC string a caller may submit for verification.
///
/// A real Argon2id PHC string is well under 200 bytes; anything far beyond that is
/// either corrupt or an attempt to make the parser do work before the length checks.
pub const MAX_ENCODED_LENGTH: usize = 1024;

/// Whether a plaintext is inside the accepted length range.
///
/// Exposed so the transport layer can reject a request before it spends a hashing
/// permit, without duplicating the bounds.
pub fn plaintext_within_bounds(plain: &str) -> bool {
    let length = plain.chars().count();
    (MIN_LENGTH..=MAX_LENGTH).contains(&length)
}

/// Whether a stored PHC string is worth handing to the hash parser.
///
/// Empty and whitespace-only values are treated as unusable rather than malformed so a
/// blank record fails fast instead of reaching Argon2.
pub fn encoded_within_bounds(encoded: &str) -> bool {
    !encoded.trim().is_empty() && encoded.len() <= MAX_ENCODED_LENGTH
}

/// Errors returned by this module.
///
/// They are deliberately coarse: a caller learns that something failed, never which
/// component of the password check failed.
#[derive(Debug, PartialEq, Eq)]
pub enum PasswordError {
    /// The password is outside the accepted length range.
    InvalidLength,
    /// Hashing failed internally.
    HashFailed,
    /// The stored hash is malformed or unusable.
    InvalidHash,
}

impl std::fmt::Display for PasswordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidLength => write!(f, "password length is out of range"),
            Self::HashFailed => write!(f, "password hashing failed"),
            Self::InvalidHash => write!(f, "stored password hash is invalid"),
        }
    }
}

impl std::error::Error for PasswordError {}

/// Upper bound on the Argon2 cost a stored hash may ask for during verification.
///
/// Verification uses the parameters embedded in the stored PHC string, not the
/// server defaults: a hash with `m=4294967295` would otherwise allocate terabytes and
/// abort the process, and the hash comes from a database row or an RPC caller. The
/// bound matches the Go implementation's `maxVerifyMemoryKiB` (1 GiB), which is far
/// above any password this service produces (64 MiB).
pub const MAX_VERIFY_MEMORY_KIB: u32 = 1024 * 1024;
/// Upper bound on the iteration count of a stored hash.
pub const MAX_VERIFY_ITERATIONS: u32 = 16;
/// Upper bound on the parallelism of a stored hash.
pub const MAX_VERIFY_PARALLELISM: u32 = 16;

/// Argon2id cost parameters.
///
/// The defaults follow the OWASP recommendation (64 MiB, 3 iterations, 2 lanes) and are
/// kept in one place so a change is visible and can be paired with a policy version bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params2 {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for Params2 {
    fn default() -> Self {
        Self { memory_kib: 64 * 1024, iterations: 3, parallelism: 2 }
    }
}

fn build(params: Params2) -> Result<Argon2<'static>, PasswordError> {
    let argon_params = Params::new(params.memory_kib, params.iterations, params.parallelism, None)
        .map_err(|_| PasswordError::HashFailed)?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params))
}

/// Hash a password into a PHC formatted string.
///
/// The plaintext is zeroized after use so it does not linger in the heap.
pub fn hash_password(mut plain: String, params: Params2) -> Result<String, PasswordError> {
    if !plaintext_within_bounds(&plain) {
        plain.zeroize();
        return Err(PasswordError::InvalidLength);
    }

    let salt = SaltString::generate(&mut rand_core::OsRng);
    let result = match build(params) {
        Ok(argon) => argon.hash_password(plain.as_bytes(), &salt).map(|h| h.to_string()),
        Err(err) => {
            plain.zeroize();
            return Err(err);
        }
    };
    plain.zeroize();

    result.map_err(|_| PasswordError::HashFailed)
}

/// Verify a password against a stored PHC string.
///
/// The errors stay coarse: an unusable stored hash reports [`PasswordError::InvalidHash`]
/// and never says which part of it was wrong, so a caller cannot probe the parser.
///
/// Both inputs are bounded before anything is parsed or hashed. An out-of-range
/// plaintext can never match a stored hash — hashes are only produced for in-range
/// passwords — so it reports `Ok(false)` and, importantly, never reaches Argon2: a
/// caller must not be able to trade a few kilobytes of request for megabytes of hashing.
pub fn verify_password(plain: &str, encoded: &str) -> Result<bool, PasswordError> {
    if !plaintext_within_bounds(plain) {
        return Ok(false);
    }
    if !encoded_within_bounds(encoded) {
        return Err(PasswordError::InvalidHash);
    }

    let parsed = PasswordHash::new(encoded).map_err(|_| PasswordError::InvalidHash)?;

    // The parsed hash carries its own cost parameters, and argon2 0.5 honours them
    // over the instance defaults. Refuse an absurd cost before verifying: a crafted
    // or corrupt row must not be able to allocate gigabytes or spin for minutes.
    let m_cost = parsed.params.get_str("m").and_then(|value| value.parse::<u32>().ok());
    let t_cost = parsed.params.get_str("t").and_then(|value| value.parse::<u32>().ok());
    let p_cost = parsed.params.get_str("p").and_then(|value| value.parse::<u32>().ok());
    match (m_cost, t_cost, p_cost) {
        (Some(m), Some(t), Some(p))
            if m > 0
                && m <= MAX_VERIFY_MEMORY_KIB
                && t > 0
                && t <= MAX_VERIFY_ITERATIONS
                && p > 0
                && p <= MAX_VERIFY_PARALLELISM => {}
        _ => return Ok(false),
    }

    let argon = build(Params2::default())?;

    Ok(argon.verify_password(plain.as_bytes(), &parsed).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cheap() -> Params2 {
        Params2 { memory_kib: 8 * 1024, iterations: 1, parallelism: 1 }
    }

    #[test]
    fn round_trip_succeeds() {
        let encoded = hash_password("correct horse battery".to_string(), cheap()).unwrap();
        assert!(encoded.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery", &encoded).unwrap());
    }

    #[test]
    fn wrong_password_is_false_not_error() {
        let encoded = hash_password("correct horse battery".to_string(), cheap()).unwrap();
        assert!(!verify_password("wrong password", &encoded).unwrap());
    }

    #[test]
    fn malformed_hash_is_false() {
        assert!(!verify_password("anything", "$argon2id$not-really").unwrap_or(false));
    }

    #[test]
    fn absurd_cost_hash_is_refused_before_allocating() {
        // A stored hash may come from a database row or an RPC caller. Verification
        // must reject an unbounded memory cost instead of trying to allocate it.
        let encoded = hash_password("correct horse battery".to_string(), cheap()).unwrap();
        let evil = encoded.replacen("m=8192", "m=4294967295", 1);
        assert_ne!(evil, encoded, "the test must actually replace the cost");
        assert_eq!(verify_password("correct horse battery", &evil), Ok(false));
    }

    #[test]
    fn excessive_iterations_are_refused() {
        let encoded = hash_password("correct horse battery".to_string(), cheap()).unwrap();
        let evil = encoded.replacen("t=1", "t=1000000", 1);
        assert_ne!(evil, encoded);
        assert_eq!(verify_password("correct horse battery", &evil), Ok(false));
    }

    #[test]
    fn length_bounds_are_enforced() {
        assert_eq!(hash_password("short".to_string(), cheap()), Err(PasswordError::InvalidLength));
        let long = "a".repeat(MAX_LENGTH + 1);
        assert_eq!(hash_password(long, cheap()), Err(PasswordError::InvalidLength));
    }

    #[test]
    fn hashes_are_salted() {
        let a = hash_password("correct horse battery".to_string(), cheap()).unwrap();
        let b = hash_password("correct horse battery".to_string(), cheap()).unwrap();
        assert_ne!(a, b, "each hash must use a fresh salt");
    }

    #[test]
    fn hash_still_enforces_bounds() {
        assert_eq!(hash_password(String::new(), cheap()), Err(PasswordError::InvalidLength));
        assert_eq!(hash_password("short".to_string(), cheap()), Err(PasswordError::InvalidLength));
        assert_eq!(
            hash_password("a".repeat(MAX_LENGTH + 1), cheap()),
            Err(PasswordError::InvalidLength)
        );

        let at_max = hash_password("a".repeat(MAX_LENGTH), cheap());
        assert!(at_max.is_ok(), "the upper bound itself must be accepted");
        assert!(at_max.unwrap().starts_with("$argon2id$"));
    }

    #[test]
    fn plaintext_bounds_predicate_matches_hash_rules() {
        assert!(!plaintext_within_bounds(""));
        assert!(!plaintext_within_bounds("short"));
        assert!(plaintext_within_bounds("exactly8"));
        assert!(plaintext_within_bounds(&"a".repeat(MAX_LENGTH)));
        assert!(!plaintext_within_bounds(&"a".repeat(MAX_LENGTH + 1)));
    }

    #[test]
    fn verify_rejects_oversized_plaintext_without_panicking() {
        let encoded = hash_password("correct horse battery".to_string(), cheap()).unwrap();

        let just_over = "a".repeat(MAX_LENGTH + 1);
        assert_eq!(verify_password(&just_over, &encoded), Ok(false));

        // A megabyte of attacker input must be refused before Argon2 ever sees it.
        let huge = "a".repeat(1024 * 1024);
        assert_eq!(verify_password(&huge, &encoded), Ok(false));

        assert_eq!(verify_password("short", &encoded), Ok(false));
    }

    #[test]
    fn verify_rejects_oversized_encoded() {
        let oversized = format!("$argon2id$v=19$m=8192,t=1,p=1${}", "A".repeat(MAX_ENCODED_LENGTH));
        assert!(oversized.len() > MAX_ENCODED_LENGTH);
        assert_eq!(
            verify_password("correct horse battery", &oversized),
            Err(PasswordError::InvalidHash)
        );
    }

    #[test]
    fn verify_rejects_empty_encoded() {
        assert_eq!(verify_password("correct horse battery", ""), Err(PasswordError::InvalidHash));
        assert_eq!(
            verify_password("correct horse battery", "   \t\n"),
            Err(PasswordError::InvalidHash)
        );
    }

    #[test]
    fn encoded_bounds_predicate_accepts_a_real_hash() {
        let encoded = hash_password("correct horse battery".to_string(), cheap()).unwrap();
        assert!(encoded_within_bounds(&encoded));
        assert!(!encoded_within_bounds(""));
        assert!(!encoded_within_bounds("   "));
    }
}
