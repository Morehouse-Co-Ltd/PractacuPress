//! gRPC surface.
//!
//! Every request is re-validated here: the Go caller is trusted to ask, never trusted
//! to have validated.

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
        let encoded = password::hash_password(plain, password::Params2::default())
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
        let matches = password::verify_password(&inner.plain, &inner.encoded)
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