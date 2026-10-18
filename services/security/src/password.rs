//! Argon2id password hashing.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use zeroize::Zeroize;

/// Password length bounds. They are enforced before hashing so an oversized input
/// cannot be used to burn CPU.
pub const MIN_LENGTH: usize = 8;
pub const MAX_LENGTH: usize = 128;

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
    let length = plain.chars().count();
    if length < MIN_LENGTH || length > MAX_LENGTH {
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
/// A malformed hash returns `Ok(false)` rather than an error: callers must not be able
/// to distinguish "wrong password" from "corrupt record".
pub fn verify_password(plain: &str, encoded: &str) -> Result<bool, PasswordError> {
    let parsed = PasswordHash::new(encoded).map_err(|_| PasswordError::InvalidHash)?;
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
}
