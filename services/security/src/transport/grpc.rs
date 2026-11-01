//! gRPC surface.
//!
//! Every request is re-validated here: the Go caller is trusted to ask, never trusted
//! to have validated.
//!
//! Argon2id costs 64 MiB and three iterations per computation, and `HashPassword` /
//! `VerifyPassword` are reachable without authentication. Running that on the async
//! worker threads would let a burst of login attempts pin gigabytes and starve the
//! runtime, which fails the whole API closed (sanitization queues behind the hashing).
//! So every Argon2 computation in this module goes through [`run_argon2`], which
//! (a) acquires a process wide permit, (b) runs the work on a blocking thread and
//! (c) races it against a deadline. The permit count is the memory bound.

use std::sync::OnceLock;
use std::time::Duration;

use tokio::sync::Semaphore;
use tonic::{Request, Response, Status};

use crate::content;
use crate::password;
use crate::POLICY_VERSION;

pub mod pb {
    tonic::include_proto!("practacu.security.v1");
}

use pb::security_service_server::SecurityService;
use pb::{
    HashPasswordRequest, HashPasswordResponse, InspectUploadRequest, InspectUploadResponse,
    SanitizeContentRequest, SanitizeContentResponse, ScanStatus, ValidateSecurityPolicyRequest,
    ValidateSecurityPolicyResponse, VerifyPasswordRequest, VerifyPasswordResponse,
};

/// Concurrency limit used by Argon2 when no usable override is configured.
const ARGON2_CONCURRENCY_MIN: usize = 1;
/// Concurrency limit used by Argon2 when the override or CPU count is unusable.
const ARGON2_CONCURRENCY_MAX: usize = 32;
/// A CPU-derived limit is capped here: more lanes would only raise peak memory.
const ARGON2_CONCURRENCY_CPU_CAP: usize = 4;
/// Last-resort concurrency limit when the platform cannot report a CPU count.
const ARGON2_CONCURRENCY_FALLBACK: usize = 2;
/// Deadline applied to one Argon2 computation when no usable override is configured.
const DEFAULT_ARGON2_TIMEOUT_MS: u64 = 10_000;
/// Accepted range for `SECURITY_ARGON2_TIMEOUT_MS`.
const ARGON2_TIMEOUT_MIN_MS: u64 = 100;
const ARGON2_TIMEOUT_MAX_MS: u64 = 60_000;

/// Process wide concurrency limit, resolved from the environment once.
static ARGON2_CONCURRENCY: OnceLock<usize> = OnceLock::new();
/// Process wide limiter. Its permit count is the bound on concurrent Argon2 memory.
static ARGON2_LIMITER: OnceLock<Semaphore> = OnceLock::new();

/// The limits that are actually in force.
///
/// Reported at startup so an operator can see what bounds a burst of unauthenticated
/// login attempts without reading this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Argon2Limits {
    /// Maximum Argon2 computations running at once.
    pub concurrency: usize,
    /// Deadline applied to a single computation.
    pub timeout: Duration,
}

/// Resolve the limits that are in force.
///
/// The concurrency limit is resolved once per process (it sizes a semaphore); the
/// deadline is read per call so an operator can adjust it without a restart.
pub fn argon2_limits() -> Argon2Limits {
    Argon2Limits { concurrency: argon2_concurrency(), timeout: argon2_timeout() }
}

/// Parse an explicit concurrency override.
///
/// `None` means "no usable override": unset, unparsable or outside `1..=32`. The caller
/// then falls back to the CPU count.
fn parse_concurrency(raw: Option<&str>) -> Option<usize> {
    let value = raw?.trim().parse::<usize>().ok()?;
    (ARGON2_CONCURRENCY_MIN..=ARGON2_CONCURRENCY_MAX).contains(&value).then_some(value)
}

/// Fallback limit derived from a CPU count.
///
/// A missing or zero CPU count yields [`ARGON2_CONCURRENCY_FALLBACK`]; anything else is
/// clamped to `1..=4` so a large host does not multiply peak memory by its core count.
fn fallback_concurrency(available: Option<usize>) -> usize {
    match available {
        Some(cpus) if cpus > 0 => cpus.clamp(ARGON2_CONCURRENCY_MIN, ARGON2_CONCURRENCY_CPU_CAP),
        _ => ARGON2_CONCURRENCY_FALLBACK,
    }
}

/// Effective Argon2 concurrency limit.
fn resolve_concurrency(raw: Option<&str>) -> usize {
    parse_concurrency(raw).unwrap_or_else(|| {
        fallback_concurrency(std::thread::available_parallelism().ok().map(|cpus| cpus.get()))
    })
}

/// Effective Argon2 deadline in milliseconds.
fn resolve_timeout_ms(raw: Option<&str>) -> u64 {
    match raw.and_then(|value| value.trim().parse::<u64>().ok()) {
        Some(ms) if (ARGON2_TIMEOUT_MIN_MS..=ARGON2_TIMEOUT_MAX_MS).contains(&ms) => ms,
        _ => DEFAULT_ARGON2_TIMEOUT_MS,
    }
}

/// Effective concurrency limit, resolved once for the life of the process.
fn argon2_concurrency() -> usize {
    *ARGON2_CONCURRENCY
        .get_or_init(|| resolve_concurrency(std::env::var("SECURITY_ARGON2_CONCURRENCY").ok().as_deref()))
}

/// Effective deadline, read from the environment on each call.
fn argon2_timeout() -> Duration {
    Duration::from_millis(resolve_timeout_ms(
        std::env::var("SECURITY_ARGON2_TIMEOUT_MS").ok().as_deref(),
    ))
}

/// The process wide limiter.
fn argon2_limiter() -> &'static Semaphore {
    ARGON2_LIMITER.get_or_init(|| Semaphore::new(argon2_concurrency()))
}

/// Run one Argon2 computation off the async runtime, under the limiter and a deadline.
///
/// The permit is acquired before the blocking task is spawned, so a request that cannot
/// get a permit waits instead of allocating. It is then moved into the blocking closure
/// and dropped when that closure finishes, which makes the permit the memory bound.
async fn run_argon2<T, F>(work: F) -> Result<T, Status>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    let permit = argon2_limiter()
        .acquire()
        .await
        .map_err(|_| Status::resource_exhausted("password hashing capacity is unavailable"))?;

    let task = tokio::task::spawn_blocking(move || {
        // Holding the permit here — rather than in the async frame — is deliberate: if
        // the deadline below elapses we return to the caller, but the blocking thread
        // keeps running and keeps its memory. Releasing the permit early would let the
        // next wave of requests allocate on top of a computation that is still alive.
        let _permit = permit;
        work()
    });

    match tokio::time::timeout(argon2_timeout(), task).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_)) => Err(Status::internal("password hashing task failed")),
        Err(_) => Err(Status::deadline_exceeded("password hashing timed out")),
    }
}

/// The gRPC service implementation.
#[derive(Debug, Default)]
pub struct SecurityServer;

#[tonic::async_trait]
impl SecurityService for SecurityServer {
    async fn validate_security_policy(
        &self,
        _request: Request<ValidateSecurityPolicyRequest>,
    ) -> Result<Response<ValidateSecurityPolicyResponse>, Status> {
        Ok(Response::new(ValidateSecurityPolicyResponse {
            policy_version: POLICY_VERSION.to_string(),
            max_source_chars: content::MAX_SOURCE_CHARS as u32,
            min_password_length: password::MIN_LENGTH as u32,
            max_password_length: password::MAX_LENGTH as u32,
        }))
    }

    async fn hash_password(
        &self,
        request: Request<HashPasswordRequest>,
    ) -> Result<Response<HashPasswordResponse>, Status> {
        let plain = request.into_inner().plain;

        // Bound the input before a permit is spent: a rejected request must not take
        // hashing capacity away from a legitimate one. The message is the same one
        // `password::hash_password` produces, so the Go client sees no change.
        if !password::plaintext_within_bounds(&plain) {
            return Err(Status::invalid_argument(
                password::PasswordError::InvalidLength.to_string(),
            ));
        }

        let encoded = run_argon2(move || password::hash_password(plain, password::Params2::default()))
            .await?
            .map_err(|err| Status::invalid_argument(err.to_string()))?;

        Ok(Response::new(HashPasswordResponse {
            encoded,
            policy_version: POLICY_VERSION.to_string(),
        }))
    }

    async fn verify_password(
        &self,
        request: Request<VerifyPasswordRequest>,
    ) -> Result<Response<VerifyPasswordResponse>, Status> {
        let inner = request.into_inner();

        // Same bounds as hashing, checked before a permit is spent. An out-of-range
        // plaintext cannot match a stored hash, and `password::verify_password` reports
        // that as `Ok(false)`; short-circuiting here keeps the answer identical while
        // saving the hashing capacity.
        if !password::plaintext_within_bounds(&inner.plain) {
            return Ok(Response::new(VerifyPasswordResponse {
                matches: false,
                policy_version: POLICY_VERSION.to_string(),
            }));
        }
        if !password::encoded_within_bounds(&inner.encoded) {
            return Err(Status::invalid_argument("password hash is unusable"));
        }

        let (plain, encoded) = (inner.plain, inner.encoded);
        let matches = run_argon2(move || password::verify_password(&plain, &encoded))
            .await?
            .map_err(|_| Status::invalid_argument("password hash is unusable"))?;

        Ok(Response::new(VerifyPasswordResponse {
            matches,
            policy_version: POLICY_VERSION.to_string(),
        }))
    }

    async fn sanitize_content(
        &self,
        request: Request<SanitizeContentRequest>,
    ) -> Result<Response<SanitizeContentResponse>, Status> {
        let inner = request.into_inner();
        let result = content::sanitize(&inner.format, &inner.source)
            .map_err(|err| Status::invalid_argument(err.to_string()))?;

        Ok(Response::new(SanitizeContentResponse {
            html: result.html,
            policy_version: result.policy_version,
            violations: result.violations,
        }))
    }

    async fn inspect_upload(
        &self,
        request: Request<InspectUploadRequest>,
    ) -> Result<Response<InspectUploadResponse>, Status> {
        let inner = request.into_inner();
        let verdict = content::inspect_upload(&inner.declared_mime, inner.size, &inner.head)
            .map_err(|err| Status::invalid_argument(err.to_string()))?;

        let status = match verdict.decision {
            content::ScanDecision::Clean => ScanStatus::Clean,
            content::ScanDecision::Rejected => ScanStatus::Rejected,
            content::ScanDecision::NeedsManualReview => ScanStatus::NeedsManualReview,
        };

        Ok(Response::new(InspectUploadResponse {
            status: status as i32,
            reason_code: verdict.reason_code.to_string(),
            policy_version: POLICY_VERSION.to_string(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The limit an unset or unusable override falls back to on this machine.
    fn cpu_default() -> usize {
        fallback_concurrency(std::thread::available_parallelism().ok().map(|cpus| cpus.get()))
    }

    #[test]
    fn concurrency_unset_falls_back_to_cpu_default() {
        assert_eq!(resolve_concurrency(None), cpu_default());
        assert!((1..=ARGON2_CONCURRENCY_CPU_CAP).contains(&cpu_default()));
    }

    #[test]
    fn concurrency_zero_falls_back() {
        assert_eq!(resolve_concurrency(Some("0")), cpu_default());
        assert_eq!(parse_concurrency(Some("0")), None);
    }

    #[test]
    fn concurrency_one_is_accepted() {
        assert_eq!(resolve_concurrency(Some("1")), 1);
        assert_eq!(parse_concurrency(Some("1")), Some(1));
    }

    #[test]
    fn concurrency_upper_bound_is_accepted() {
        assert_eq!(resolve_concurrency(Some("32")), 32);
        assert_eq!(parse_concurrency(Some("32")), Some(32));
    }

    #[test]
    fn concurrency_999_falls_back() {
        assert_eq!(resolve_concurrency(Some("999")), cpu_default());
        assert_eq!(parse_concurrency(Some("999")), None);
    }

    #[test]
    fn concurrency_garbage_falls_back() {
        assert_eq!(resolve_concurrency(Some("abc")), cpu_default());
        assert_eq!(parse_concurrency(Some("abc")), None);
        assert_eq!(parse_concurrency(Some("")), None);
        assert_eq!(parse_concurrency(Some("-4")), None);
    }

    #[test]
    fn concurrency_override_tolerates_surrounding_space() {
        assert_eq!(parse_concurrency(Some("  8  ")), Some(8));
    }

    #[test]
    fn cpu_fallback_is_clamped_and_never_zero() {
        assert_eq!(fallback_concurrency(None), ARGON2_CONCURRENCY_FALLBACK);
        assert_eq!(fallback_concurrency(Some(0)), ARGON2_CONCURRENCY_FALLBACK);
        assert_eq!(fallback_concurrency(Some(1)), 1);
        assert_eq!(fallback_concurrency(Some(3)), 3);
        assert_eq!(fallback_concurrency(Some(4)), 4);
        assert_eq!(fallback_concurrency(Some(64)), ARGON2_CONCURRENCY_CPU_CAP);
    }

    #[test]
    fn timeout_defaults_and_bounds() {
        assert_eq!(resolve_timeout_ms(None), DEFAULT_ARGON2_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(Some("99")), DEFAULT_ARGON2_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(Some("100")), ARGON2_TIMEOUT_MIN_MS);
        assert_eq!(resolve_timeout_ms(Some("60000")), ARGON2_TIMEOUT_MAX_MS);
        assert_eq!(resolve_timeout_ms(Some("60001")), DEFAULT_ARGON2_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(Some("nope")), DEFAULT_ARGON2_TIMEOUT_MS);
        assert_eq!(resolve_timeout_ms(Some("-1")), DEFAULT_ARGON2_TIMEOUT_MS);
    }

    #[test]
    fn effective_limits_are_in_range() {
        let limits = argon2_limits();
        assert!((1..=ARGON2_CONCURRENCY_MAX).contains(&limits.concurrency));
        assert!(limits.timeout.as_millis() >= u128::from(ARGON2_TIMEOUT_MIN_MS));
        assert!(limits.timeout.as_millis() <= u128::from(ARGON2_TIMEOUT_MAX_MS));
    }

    #[tokio::test]
    async fn run_argon2_returns_the_blocking_result() {
        assert_eq!(run_argon2(|| 6 * 7).await.unwrap(), 42);
    }

    #[tokio::test]
    async fn run_argon2_maps_a_panicking_task_to_internal() {
        let result = run_argon2(|| -> u8 { panic!("simulated blocking task failure") }).await;
        assert_eq!(result.unwrap_err().code(), tonic::Code::Internal);
    }
}
