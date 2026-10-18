//! Security primitives for Practacu Press.
//!
//! This crate owns exactly two things: password hashing and content sanitization.
//! It deliberately holds no business data, no users and no permissions — the Go API
//! decides who may do what, and calls here only for the security critical primitive.
//!
//! The service boundary is narrow on purpose: every entry point here re-validates its
//! input, because a caller that has already validated is still just a caller.

pub mod content;
pub mod password;

/// Policy version identifies the rules that produced a result.
///
/// It is stored next to sanitized content so a later policy change can invalidate
/// previously published HTML instead of leaving it silently unverified.
pub const POLICY_VERSION: &str = "2026-10-18.1";
