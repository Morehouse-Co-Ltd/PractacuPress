//! Allow-list content sanitization.

use std::collections::BTreeSet;

/// Maximum accepted source length in characters.
pub const MAX_SOURCE_CHARS: usize = 200_000;

/// The outcome of sanitization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sanitized {
    /// The only representation a client may render.
    pub html: String,
    /// Rule set that produced `html`.
    pub policy_version: String,
    /// Constructs that were removed, for the audit trail.
    pub violations: Vec<String>,
}

/// Error returned when the source cannot be processed at all.
#[derive(Debug, PartialEq, Eq)]
pub enum ContentError {
    /// The source exceeded the size bound.
    TooLarge,
    /// The format is not one of markdown, html or plain.
    UnknownFormat,
}

impl std::fmt::Display for ContentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooLarge => write!(f, "content exceeds the maximum allowed size"),
            Self::UnknownFormat => write!(f, "unknown source format"),
        }
    }
}

impl std::error::Error for ContentError {}

/// Allowed tags. Anything else is dropped, keeping its text content.
const ALLOWED_TAGS: &[&str] = &[
    "a", "b", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
    "i", "img", "li", "ol", "p", "pre", "s", "strong", "table", "tbody", "td", "th", "thead", "tr",
    "ul",
];

/// Allowed attributes per tag.
fn is_allowed_attribute(tag: &str, attribute: &str) -> bool {
    match attribute {
        "class" => true,
        "href" | "title" => tag == "a",
        "src" | "alt" | "width" | "height" => tag == "img",
        _ => false,
    }
}

/// Allowed URL schemes. `javascript:` and `data:` are refused, which is what makes
/// stored XSS through links and images impossible.
const ALLOWED_SCHEMES: &[&str] = &["http", "https", "mailto"];

/// Sanitize source content into safe HTML.
///
/// The result is deterministic for the same input and policy, so it can be stored and
/// compared across revisions.
pub fn sanitize(format: &str, source: &str) -> Result<Sanitized, ContentError> {
    if source.chars().count() > MAX_SOURCE_CHARS {
        return Err(ContentError::TooLarge);
    }

    let mut violations = BTreeSet::new();

    let html = match format {
        "markdown" | "html" => source.to_string(),
        "plain" => format!("<p>{}</p>", escape_html(source)),
        _ => return Err(ContentError::UnknownFormat),
    };

    let cleaned = ammonia::Builder::default()
        .tags(ALLOWED_TAGS.iter().copied().collect())
        .tag_attributes(allowed_attributes())
        .url_schemes(ALLOWED_SCHEMES.iter().copied().collect())
        .link_rel(Some("noopener noreferrer"))
        .clean(&html)
        .to_string();

    record_violations(&html, &mut violations);

    Ok(Sanitized {
        html: cleaned,
        policy_version: crate::POLICY_VERSION.to_string(),
        violations: violations.into_iter().collect(),
    })
}

fn allowed_attributes() -> std::collections::HashMap<&'static str, std::collections::HashSet<&'static str>> {
    let mut map = std::collections::HashMap::new();
    for tag in ALLOWED_TAGS {
        let mut set = std::collections::HashSet::new();
        for attribute in ["class", "href", "title", "src", "alt", "width", "height"] {
            if is_allowed_attribute(tag, attribute) {
                set.insert(attribute);
            }
        }
        if !set.is_empty() {
            map.insert(*tag, set);
        }
    }
    map
}

/// Record which dangerous constructs were present, so the audit trail can show why
/// content was modified rather than just that it was.
fn record_violations(source: &str, out: &mut BTreeSet<String>) {
    let lowered = source.to_lowercase();
    let markers = [
        ("<script", "script"),
        ("<iframe", "iframe"),
        ("<object", "object"),
        ("<embed", "embed"),
        ("onerror=", "onerror"),
        ("onload=", "onload"),
        ("javascript:", "javascript_url"),
    ];
    for (marker, label) in markers {
        if lowered.contains(marker) {
            out.insert(label.to_string());
        }
    }
}

fn escape_html(source: &str) -> String {
    source
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Maximum accepted upload size in bytes.
pub const MAX_UPLOAD_BYTES: i64 = 25 * 1024 * 1024;

/// The verdict of upload inspection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanDecision {
    Clean,
    Rejected,
    NeedsManualReview,
}

/// One inspection verdict with its machine readable reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadVerdict {
    pub decision: ScanDecision,
    pub reason_code: &'static str,
}

/// MIME types the application accepts at all.
const ALLOWED_UPLOAD_MIME: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
];

/// Inspect an upload from its declared metadata and leading bytes.
///
/// The declared MIME is only a claim: the leading bytes decide whether it is
/// believable. A file whose content does not match its declared type is rejected,
/// which is what stops an executable renamed to `.png`.
pub fn inspect_upload(
    declared_mime: &str,
    size: i64,
    head: &[u8],
) -> Result<UploadVerdict, ContentError> {
    let mime = declared_mime.trim().to_lowercase();

    if size <= 0 || size > MAX_UPLOAD_BYTES {
        return Ok(UploadVerdict { decision: ScanDecision::Rejected, reason_code: "size_out_of_range" });
    }
    if !ALLOWED_UPLOAD_MIME.contains(&mime.as_str()) {
        return Ok(UploadVerdict { decision: ScanDecision::Rejected, reason_code: "mime_not_allowed" });
    }
    if head.is_empty() {
        // Without a sample no claim can be verified, so it goes to a human rather than
        // being called clean on trust.
        return Ok(UploadVerdict { decision: ScanDecision::NeedsManualReview, reason_code: "no_content_sample" });
    }

    let matches_declared = match mime.as_str() {
        "image/png" => head.starts_with(&[0x89, 0x50, 0x4E, 0x47]),
        "image/jpeg" => head.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => head.starts_with(b"GIF8"),
        "image/webp" => head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP",
        "application/pdf" => head.starts_with(b"%PDF"),
        "text/plain" => is_plain_text(head),
        _ => false,
    };

    if !matches_declared {
        return Ok(UploadVerdict { decision: ScanDecision::Rejected, reason_code: "magic_mismatch" });
    }

    Ok(UploadVerdict { decision: ScanDecision::Clean, reason_code: "ok" })
}

/// Report whether a sample looks like plain text: valid UTF-8 without NUL bytes.
fn is_plain_text(head: &[u8]) -> bool {
    !head.contains(&0) && std::str::from_utf8(head).is_ok()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_script_tags() {
        let out = sanitize("html", "<p>hi</p><script>alert(1)</script>").unwrap();
        assert!(!out.html.contains("<script"));
        assert!(out.violations.iter().any(|v| v == "script"));
    }

    #[test]
    fn removes_event_handlers() {
        let out = sanitize("html", r#"<img src="x.png" onerror="alert(1)">"#).unwrap();
        assert!(!out.html.contains("onerror"));
    }

    #[test]
    fn removes_javascript_urls() {
        let out = sanitize("html", r#"<a href="javascript:alert(1)">x</a>"#).unwrap();
        assert!(!out.html.contains("javascript:"));
    }

    #[test]
    fn keeps_safe_formatting() {
        let out = sanitize("html", "<p><strong>bold</strong> and <em>italic</em></p>").unwrap();
        assert!(out.html.contains("<strong>"));
        assert!(out.html.contains("<em>"));
    }

    #[test]
    fn https_links_survive_and_get_rel() {
        let out = sanitize("html", r#"<a href="https://example.com">x</a>"#).unwrap();
        assert!(out.html.contains("https://example.com"));
        assert!(out.html.contains("noopener"));
    }

    #[test]
    fn plain_text_is_escaped() {
        let out = sanitize("plain", "<script>alert(1)</script>").unwrap();
        assert!(!out.html.contains("<script>"));
        assert!(out.html.contains("&lt;script&gt;"));
    }

    #[test]
    fn unknown_format_is_refused() {
        assert_eq!(sanitize("excel", "x"), Err(ContentError::UnknownFormat));
    }

    #[test]
    fn oversized_input_is_refused() {
        let big = "a".repeat(MAX_SOURCE_CHARS + 1);
        assert_eq!(sanitize("plain", &big), Err(ContentError::TooLarge));
    }

    #[test]
    fn output_is_deterministic_and_carries_policy_version() {
        let a = sanitize("html", "<p>x</p>").unwrap();
        let b = sanitize("html", "<p>x</p>").unwrap();
        assert_eq!(a, b);
        assert_eq!(a.policy_version, crate::POLICY_VERSION);
    }
}

#[cfg(test)]
mod upload_tests {
    use super::*;

    const PNG: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A];
    const PDF: &[u8] = b"%PDF-1.7";

    #[test]
    fn accepts_matching_magic_bytes() {
        assert_eq!(inspect_upload("image/png", 1024, PNG).unwrap().decision, ScanDecision::Clean);
    }

    #[test]
    fn rejects_executable_disguised_as_image() {
        let verdict = inspect_upload("image/png", 1024, b"MZ\x90\x00").unwrap();
        assert_eq!(verdict.decision, ScanDecision::Rejected);
        assert_eq!(verdict.reason_code, "magic_mismatch");
    }

    #[test]
    fn rejects_disallowed_mimes() {
        for mime in ["application/x-msdownload", "image/svg+xml", "text/html", "application/x-sh"] {
            let verdict = inspect_upload(mime, 10, PNG).unwrap();
            assert_eq!(verdict.decision, ScanDecision::Rejected, "{mime}");
            assert_eq!(verdict.reason_code, "mime_not_allowed", "{mime}");
        }
    }

    #[test]
    fn rejects_oversized_and_empty() {
        assert_eq!(
            inspect_upload("image/png", MAX_UPLOAD_BYTES + 1, PNG).unwrap().reason_code,
            "size_out_of_range"
        );
        assert_eq!(inspect_upload("image/png", 0, PNG).unwrap().reason_code, "size_out_of_range");
    }

    #[test]
    fn without_a_sample_it_asks_a_human() {
        let verdict = inspect_upload("image/png", 1024, b"").unwrap();
        assert_eq!(verdict.decision, ScanDecision::NeedsManualReview);
        assert_eq!(verdict.reason_code, "no_content_sample");
    }

    #[test]
    fn accepts_pdf_and_plain_text() {
        assert_eq!(inspect_upload("application/pdf", 10, PDF).unwrap().decision, ScanDecision::Clean);
        assert_eq!(inspect_upload("text/plain", 10, b"hello").unwrap().decision, ScanDecision::Clean);
    }

    #[test]
    fn rejects_binary_declared_as_text() {
        assert_eq!(inspect_upload("text/plain", 10, &[0x00, 0x01]).unwrap().decision, ScanDecision::Rejected);
    }

    #[test]
    fn webp_needs_both_markers() {
        assert_eq!(inspect_upload("image/webp", 20, b"RIFF____WEBPVP8").unwrap().decision, ScanDecision::Clean);
        assert_eq!(inspect_upload("image/webp", 20, b"RIFF____XXXX").unwrap().decision, ScanDecision::Rejected);
    }

    #[test]
    fn declared_case_and_spacing_are_ignored() {
        assert_eq!(inspect_upload("  IMAGE/PNG ", 10, PNG).unwrap().decision, ScanDecision::Clean);
    }
}