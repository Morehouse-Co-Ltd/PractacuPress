//! Allow-list content sanitization.

use std::borrow::Cow;
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

/// Class-name prefixes that survive sanitization.
///
/// The list is derived from what the content pipeline actually emits:
///
/// - `language-*`: goldmark renders fenced code as
///   `<pre><code class="language-…"></pre>` (`apps/api/internal/content/render.go`,
///   pinned by `TestRenderMarkdownProducesRealTags` and
///   `TestDiagramFenceSurvivesMarkdownRendering`; article diagrams ride on
///   `language-pp-diagram`).
/// - `pp-*`: the rich-text block snippets stored as HTML by the editor:
///   `apps/web/src/lib/richBlocks.ts` emits `pp-columns`, `pp-table`, `pp-image`,
///   `pp-caption`, `pp-note`/`pp-note-*`, `pp-icon`/`pp-icon-*`, `pp-embed`,
///   `pp-linkcard`, `pp-video-poster`, `pp-gallery`; `apps/web/src/lib/markdown.ts`
///   emits `pp-math-inline`, `pp-math-block`, `pp-align-center`, `pp-align-right`.
///
/// Everything else is dropped, which is the SEC-11 fix: a stored
/// `<p class="btn btn-danger">` can no longer borrow the site's own button styling
/// to imitate UI. The plain `class` attribute survives the tag allow-list and is
/// filtered token by token in [`filter_class`].
const ALLOWED_CLASS_PREFIXES: &[&str] = &["pp-", "language-"];

/// Exact class tokens that survive sanitization.
///
/// These are conventional Markdown ecosystem class names (syntax highlighting,
/// footnotes, GFM task lists) used by imported/pasted HTML and by renderers the
/// project may adopt later. The current goldmark GFM pipeline emits no class for task
/// lists, and the site stylesheet defines none of these names, so they cannot be used
/// to imitate site UI — allowing them keeps pasted Markdown structure intact without
/// relaxing the SEC-11 boundary.
const ALLOWED_CLASS_TOKENS: &[&str] = &[
    "hljs",
    "footnotes",
    "footnote-ref",
    "footnote-backref",
    "task-list",
    "task-list-item",
    "contains-task-list",
];

/// Filter one `class` value down to the allow-list.
///
/// `None` means the attribute carries no allowed token and must be removed entirely.
fn filter_class(value: &str) -> Option<String> {
    let kept: Vec<&str> =
        value.split_whitespace().filter(|token| is_allowed_class(token)).collect();
    if kept.is_empty() {
        return None;
    }
    Some(kept.join(" "))
}

/// Report whether one class token is allowed. Class names are case-sensitive in CSS,
/// so the match is exact (a lower-cased copy never matches differently).
fn is_allowed_class(token: &str) -> bool {
    if ALLOWED_CLASS_TOKENS.contains(&token) {
        return true;
    }
    ALLOWED_CLASS_PREFIXES
        .iter()
        .any(|prefix| token.len() > prefix.len() && token.starts_with(prefix))
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
        // SEC-11: `class` is the one attribute whose value is content, not a URL or a
        // number, so it is filtered token by token. Every other kept attribute passes
        // through unchanged; ammonia still applies its URL scheme rules afterwards.
        .attribute_filter(|_element, attribute, value| match attribute {
            "class" => filter_class(value).map(Cow::Owned),
            _ => Some(Cow::Borrowed(value)),
        })
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

/// Length of the complete leading signature for each declared binary MIME type.
///
/// The signatures are the full on-disk magic, not a prefix: a truncated file (or one
/// whose signature the sampling budget cannot cover) is refused instead of
/// half-matching. `text/plain` has no signature and is handled separately.
fn signature_len(mime: &str) -> usize {
    match mime {
        "image/png" => 8,
        "image/jpeg" => 3,
        "image/gif" => 6,
        "image/webp" => 12,
        "application/pdf" => 5,
        _ => 0,
    }
}

/// Report whether the head starts with the complete signature of the declared type.
fn has_signature(mime: &str, head: &[u8]) -> bool {
    match mime {
        "image/png" => head.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => head.starts_with(b"\xFF\xD8\xFF"),
        "image/gif" => head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a"),
        "image/webp" => head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP",
        "application/pdf" => head.starts_with(b"%PDF-"),
        _ => false,
    }
}

/// Markup markers that must never appear in a file declared as an image or PDF.
///
/// A polyglot can start with a valid signature and still carry an HTML/SVG document
/// the browser would parse once the declared type is no longer enforced; the marker
/// scan closes that gap. Matching is case-insensitive.
const DANGEROUS_MARKERS: &[&str] = &["<!doctype html", "<html", "<script", "<svg"];

/// Report whether a byte sample looks like markup.
fn looks_like_markup(bytes: &[u8]) -> bool {
    if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'<') {
        return true;
    }
    let lowered = String::from_utf8_lossy(bytes).to_lowercase();
    DANGEROUS_MARKERS.iter().any(|marker| lowered.contains(marker))
}

fn rejected(reason_code: &'static str) -> UploadVerdict {
    UploadVerdict { decision: ScanDecision::Rejected, reason_code }
}

fn clean() -> UploadVerdict {
    UploadVerdict { decision: ScanDecision::Clean, reason_code: "ok" }
}

/// Inspect a binary upload: no markup markers, a head long enough for the complete
/// signature, and the signature itself.
fn inspect_binary(mime: &str, head: &[u8]) -> UploadVerdict {
    if looks_like_markup(head) {
        return rejected("dangerous_content");
    }
    if head.len() < signature_len(mime) {
        return rejected("truncated_sample");
    }
    if !has_signature(mime, head) {
        return rejected("magic_mismatch");
    }
    clean()
}

/// Inspect a `text/plain` upload: valid UTF-8, no NUL, and not HTML/SVG in disguise.
///
/// The sample can end in the middle of a multi-byte character (the reader takes a
/// fixed byte budget), which is normal for CJK text. A valid prefix whose only defect
/// is an incomplete trailing sequence is accepted; genuinely invalid UTF-8 is not.
fn inspect_plain_text(head: &[u8]) -> UploadVerdict {
    if head.contains(&0) {
        return rejected("magic_mismatch");
    }
    let prefix = match std::str::from_utf8(head) {
        Ok(text) => text,
        Err(err) if err.error_len().is_none() => {
            // `valid_up_to` always lands on a character boundary, so this slice is
            // valid UTF-8.
            std::str::from_utf8(&head[..err.valid_up_to()]).unwrap_or_default()
        }
        Err(_) => return rejected("magic_mismatch"),
    };
    if looks_like_markup(prefix.as_bytes()) {
        return rejected("dangerous_content");
    }
    clean()
}

/// Inspect an upload from its declared metadata and leading bytes.
///
/// The declared MIME is only a claim: the complete leading bytes decide whether it is
/// believable. A file whose content does not match its declared type is rejected,
/// which is what stops an executable or an HTML polyglot renamed to `.png`.
pub fn inspect_upload(
    declared_mime: &str,
    size: i64,
    head: &[u8],
) -> Result<UploadVerdict, ContentError> {
    let mime = declared_mime.trim().to_lowercase();

    if size <= 0 || size > MAX_UPLOAD_BYTES {
        return Ok(rejected("size_out_of_range"));
    }
    if !ALLOWED_UPLOAD_MIME.contains(&mime.as_str()) {
        return Ok(rejected("mime_not_allowed"));
    }
    if head.is_empty() {
        // Without a sample no claim can be verified, so it goes to a human rather than
        // being called clean on trust.
        return Ok(UploadVerdict {
            decision: ScanDecision::NeedsManualReview,
            reason_code: "no_content_sample",
        });
    }

    Ok(if mime == "text/plain" { inspect_plain_text(head) } else { inspect_binary(&mime, head) })
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
    fn keeps_diagram_fence_for_client_side_rendering() {
        // Article diagrams are stored as a ```pp-diagram fenced block: goldmark turns it
        // into pre > code with a language class, the client hydrates it into SVG. If the
        // sanitizer drops pre/code/class the feature silently breaks, so pin it here.
        let source = r#"<pre><code class="language-pp-diagram">{"type":"chart","kind":"bar"}</code></pre>"#;
        let out = sanitize("html", source).unwrap();
        assert!(out.html.contains("<pre>"), "{}", out.html);
        assert!(out.html.contains("language-pp-diagram"), "{}", out.html);
        assert!(out.html.contains("chart"), "{}", out.html);
    }

    #[test]
    fn still_removes_inline_svg_for_diagrams() {
        // The feature never puts SVG into stored content; make sure the allow-list is not
        // relaxed into trusting inline SVG.
        let out = sanitize("html", r#"<svg onload="alert(1)"><script>alert(2)</script></svg>"#)
            .unwrap();
        assert!(!out.html.contains("<svg"), "{}", out.html);
        assert!(!out.html.contains("<script"), "{}", out.html);
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

    #[test]
    fn keeps_allow_listed_class_tokens() {
        // Block snippets the editor stores as HTML (apps/web/src/lib/richBlocks.ts).
        let out = sanitize(
            "html",
            r#"<table class="pp-columns"><tbody><tr><td>x</td></tr></tbody></table>"#,
        )
        .unwrap();
        assert!(out.html.contains(r#"class="pp-columns""#), "{}", out.html);

        // Fenced code language class produced by goldmark.
        let out =
            sanitize("html", r#"<pre><code class="language-go">fmt.Println(1)</code></pre>"#).unwrap();
        assert!(out.html.contains(r#"class="language-go""#), "{}", out.html);

        // Multiple tokens: keep the allowed ones, drop the rest.
        let out =
            sanitize("html", r#"<p class="pp-note pp-note-warn btn btn-danger">x</p>"#).unwrap();
        assert!(out.html.contains(r#"class="pp-note pp-note-warn""#), "{}", out.html);
        assert!(!out.html.contains("btn"), "{}", out.html);
        assert!(!out.html.contains("danger"), "{}", out.html);

        // Arbitrary whitespace between tokens is normalised to single spaces.
        let out = sanitize("html", "<p class=\"pp-table\n\tbtn\">x</p>").unwrap();
        assert!(out.html.contains(r#"class="pp-table""#), "{}", out.html);
    }

    #[test]
    fn drops_classes_that_could_imitate_site_ui() {
        // SEC-11: stored content must not borrow the site's button/badge/chip styling.
        let out = sanitize("html", r#"<p class="btn btn-danger">x</p>"#).unwrap();
        assert_eq!(out.html, "<p>x</p>");

        // When every token is filtered the attribute is removed entirely.
        let out = sanitize("html", r#"<a class="chip" href="https://example.com">x</a>"#).unwrap();
        assert!(!out.html.contains("class="), "{}", out.html);
        assert!(out.html.contains("https://example.com"), "{}", out.html);

        // Prefix must be followed by a name: "language-" alone is not a class.
        let out = sanitize("html", r#"<p class="language- pp-">x</p>"#).unwrap();
        assert_eq!(out.html, "<p>x</p>");

        // Class names are case-sensitive in CSS, so "PP-COLUMNS" is not "pp-columns".
        let out = sanitize("html", r#"<p class="PP-COLUMNS">x</p>"#).unwrap();
        assert_eq!(out.html, "<p>x</p>");
    }

    #[test]
    fn keeps_markdown_ecosystem_classes() {
        // Conventional Markdown/GFM classes used by imported HTML and future renderers.
        let cases = [
            (r#"<pre class="hljs"><code class="language-rust">fn main() {}</code></pre>"#, "hljs"),
            (r#"<p class="footnotes">notes</p>"#, "footnotes"),
            (r#"<ol class="footnotes"><li class="footnote-ref">x</li></ol>"#, "footnote-ref"),
            (
                r#"<ul class="task-list contains-task-list"><li class="task-list-item">x</li></ul>"#,
                "contains-task-list",
            ),
        ];
        for (html, expected) in cases {
            let out = sanitize("html", html).unwrap();
            assert!(out.html.contains(expected), "{html} => {}", out.html);
        }
    }
}

#[cfg(test)]
mod upload_tests {
    use super::*;

    /// Complete leading bytes, as an on-disk file of each type starts.
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
    const GIF87: &[u8] = b"GIF87a";
    const GIF89: &[u8] = b"GIF89a";
    const JPEG: &[u8] = b"\xFF\xD8\xFF\xE0\x00\x10JFIF";
    const WEBP: &[u8] = b"RIFF____WEBPVP8";
    const PDF: &[u8] = b"%PDF-1.7\n";

    /// A `head` cut short, as a truncated file would be sampled.
    fn head_of(bytes: &[u8], len: usize) -> &[u8] {
        &bytes[..len]
    }

    #[test]
    fn accepts_complete_signatures_for_every_binary_type() {
        for (mime, head) in [
            ("image/png", PNG),
            ("image/gif", GIF87),
            ("image/gif", GIF89),
            ("image/jpeg", JPEG),
            ("image/webp", WEBP),
            ("application/pdf", PDF),
        ] {
            let verdict = inspect_upload(mime, 1024, head).unwrap();
            assert_eq!(verdict.decision, ScanDecision::Clean, "{mime}");
            assert_eq!(verdict.reason_code, "ok", "{mime}");
        }
    }

    #[test]
    fn accepts_matching_magic_bytes_with_a_full_file_head() {
        let mut head = Vec::from(PNG);
        head.extend_from_slice(&[0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R']);
        assert_eq!(inspect_upload("image/png", 1024, &head).unwrap().decision, ScanDecision::Clean);
    }

    #[test]
    fn rejects_executable_disguised_as_image() {
        // A real PE/DOS executable header, sampled with enough bytes to look at.
        let exe = b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00";
        let verdict = inspect_upload("image/png", 1024, exe).unwrap();
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
    fn accepts_pdf_and_plain_text() {
        assert_eq!(
            inspect_upload("application/pdf", 10, PDF).unwrap().decision,
            ScanDecision::Clean
        );
        assert_eq!(
            inspect_upload("text/plain", 10, b"hello").unwrap().decision,
            ScanDecision::Clean
        );
        assert_eq!(
            inspect_upload("text/plain", 10, "第一段中文正文".as_bytes()).unwrap().decision,
            ScanDecision::Clean
        );
    }

    #[test]
    fn rejects_binary_declared_as_text() {
        for head in [&[0x00u8, 0x01][..], &[0xFF, 0xFE][..], &[0xC3, 0x28][..]] {
            let verdict = inspect_upload("text/plain", 10, head).unwrap();
            assert_eq!(verdict.decision, ScanDecision::Rejected, "{head:02X?}");
            assert_eq!(verdict.reason_code, "magic_mismatch", "{head:02X?}");
        }
    }

    #[test]
    fn accepts_text_whose_head_cut_a_multibyte_character() {
        // The reader samples a fixed byte budget, so a CJK text file routinely ends
        // the sample in the middle of a character. That must not look like binary data.
        let text = "中文测试正文".repeat(200);
        let bytes = text.as_bytes();
        for cut in [511usize, 512, 385] {
            assert!(std::str::from_utf8(&bytes[..cut]).is_err(), "cut {cut} should split a char");
            let verdict = inspect_upload("text/plain", bytes.len() as i64, &bytes[..cut]).unwrap();
            assert_eq!(verdict.decision, ScanDecision::Clean, "cut {cut}");
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
    fn webp_needs_both_markers() {
        assert_eq!(inspect_upload("image/webp", 20, WEBP).unwrap().decision, ScanDecision::Clean);
        assert_eq!(
            inspect_upload("image/webp", 20, b"RIFF____XXXX").unwrap().reason_code,
            "magic_mismatch"
        );
    }

    #[test]
    fn declared_case_and_spacing_are_ignored() {
        assert_eq!(inspect_upload("  IMAGE/PNG ", 10, PNG).unwrap().decision, ScanDecision::Clean);
    }

    #[test]
    fn rejects_truncated_heads() {
        // One byte short of each complete signature: a file whose magic was cut off
        // must never be called clean just because a prefix matched.
        for (mime, head) in [
            ("image/png", head_of(PNG, PNG.len() - 1)),
            ("image/jpeg", head_of(JPEG, 2)),
            ("image/gif", head_of(GIF89, GIF89.len() - 1)),
            ("application/pdf", head_of(PDF, 4)),
            ("image/webp", head_of(WEBP, 11)),
        ] {
            let verdict = inspect_upload(mime, 1024, head).unwrap();
            assert_eq!(verdict.decision, ScanDecision::Rejected, "{mime}");
            assert_eq!(verdict.reason_code, "truncated_sample", "{mime}");
        }
    }

    #[test]
    fn rejects_mislabelled_binary_types() {
        // A real GIF declared as PNG (and so on) is still a type mismatch. The heads
        // are longer than every signature, so the verdict is a mismatch, not truncation.
        let padded_gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00";
        let padded_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR";
        let padded_webp = b"RIFF\x24\x00\x00\x00WEBPVP8 ";
        let padded_jpeg = b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01";
        for (mime, head) in [
            ("image/png", &padded_gif[..]),
            ("image/gif", &padded_png[..]),
            ("image/jpeg", &padded_webp[..]),
            ("image/webp", &padded_jpeg[..]),
            ("application/pdf", &padded_png[..]),
        ] {
            let verdict = inspect_upload(mime, 1024, head).unwrap();
            assert_eq!(verdict.decision, ScanDecision::Rejected, "{mime}");
            assert_eq!(verdict.reason_code, "magic_mismatch", "{mime}");
        }
    }

    #[test]
    fn rejects_html_disguised_as_every_binary_type() {
        for head in [
            &b"<html><body>click</body></html>"[..],
            &b"  \n<!DOCTYPE html><script>alert(1)</script>"[..],
            &b"<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\">"[..],
        ] {
            for mime in
                ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]
            {
                let verdict = inspect_upload(mime, 1024, head).unwrap();
                assert_eq!(verdict.decision, ScanDecision::Rejected, "{mime}");
                assert_eq!(verdict.reason_code, "dangerous_content", "{mime}");
            }
        }
    }

    #[test]
    fn rejects_signature_prefixed_polyglots() {
        // SEC-7: a valid magic prefix used to be enough for a clean verdict. A real
        // upload is a binary file, not a binary prefix followed by a web document.
        let mut png_polyglot = Vec::from(PNG);
        png_polyglot.extend_from_slice(b"<!doctype html><script>alert(1)</script>");
        let mut gif_polyglot = Vec::from(GIF89);
        gif_polyglot.extend_from_slice(b"<svg onload=\"alert(1)\">");
        let mut jpeg_polyglot = Vec::from(JPEG);
        jpeg_polyglot.extend_from_slice(b"<script>alert(1)</script>");
        let mut webp_polyglot = Vec::from(WEBP);
        webp_polyglot.extend_from_slice(b"<html><body>pwned</body></html>");
        let mut pdf_polyglot = Vec::from(PDF);
        pdf_polyglot.extend_from_slice(b"<html><script>alert(1)</script>");

        for (mime, head) in [
            ("image/png", png_polyglot),
            ("image/gif", gif_polyglot),
            ("image/jpeg", jpeg_polyglot),
            ("image/webp", webp_polyglot),
            ("application/pdf", pdf_polyglot),
        ] {
            let verdict = inspect_upload(mime, 1024, &head).unwrap();
            assert_eq!(verdict.decision, ScanDecision::Rejected, "{mime}");
            assert_eq!(verdict.reason_code, "dangerous_content", "{mime}");
        }
    }

    #[test]
    fn rejects_html_and_svg_declared_as_text() {
        for head in [
            &b"<html><body>x</body></html>"[..],
            &b"   <script>alert(1)</script>"[..],
            &b"<svg xmlns=\"http://www.w3.org/2000/svg\">"[..],
            &b"hello <!DOCTYPE html>"[..],
        ] {
            let verdict = inspect_upload("text/plain", 20, head).unwrap();
            assert_eq!(verdict.decision, ScanDecision::Rejected, "{head:?}");
            assert_eq!(verdict.reason_code, "dangerous_content", "{head:?}");
        }
    }

    #[test]
    fn plain_text_that_merely_mentions_angle_brackets_is_still_text() {
        // A first non-whitespace byte that is not `<` and no markup marker: ordinary
        // prose (including inline math like `a < b`) stays accepted.
        let verdict = inspect_upload("text/plain", 20, b"if a < b then done\n").unwrap();
        assert_eq!(verdict.decision, ScanDecision::Clean);
    }
}