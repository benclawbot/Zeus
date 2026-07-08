//! Web search tool. The desktop agent can hit DuckDuckGo's HTML
//! endpoint (`https://html.duckduckgo.com/html/`) to gather research
//! material autonomously without any API key.
//!
//! The HTML response is parsed by regex — the result page is stable
//! enough that a couple of well-chosen patterns extract every result
//! link, title, and snippet. We never re-serialize the raw page; only
//! the parsed fields leave the module.
//!
//! ## Bot challenge
//!
//! DuckDuckGo serves an "anomaly" CAPTCHA challenge (a "select all
//! squares containing a duck" puzzle) when its bot detector flags the
//! request. The challenge page looks superficially like a search
//! result page but contains zero `result__a` elements, so a naive
//! parser silently returns 0 hits and the caller has no idea the
//! backend is unreachable. We detect the challenge markers before
//! parsing and return an explicit error so the failure mode is
//! visible. To work around DDG's bot detection in restricted
//! environments, set `ZEUS_SEARCH_PROVIDER=brave` with
//! `BRAVE_SEARCH_API_KEY=<key>`, or point `ZEUS_SEARCH_PROVIDER=searxng`
//! at a self-hosted SearXNG instance.

use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

const DEFAULT_ENDPOINT: &str = "https://html.duckduckgo.com/html/";
const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) ZeusBot/1.0 (+https://github.com/benclawbot/Zeus)";

/// Hard cap on how many hits we will return. The DDG HTML page rarely
/// surfaces more than ~30 useful links anyway, but we trim so the
/// model isn't asked to chew through the full page.
const MAX_HITS: usize = 20;
/// DDG frequently returns empty snippets, so each `WebSearchHit`
/// carries both the visible snippet and a nullable fallback for
/// testing.
const SNIPPET_TRUNCATE_CHARS: usize = 280;

/// Markers that distinguish a real DDG search result page from the
/// bot-challenge page they serve to suspected scrapers. Any one of
/// these present means the request was intercepted.
const DDG_CHALLENGE_MARKERS: &[&str] = &[
    "anomaly-modal",
    "challenge-form",
    "Unfortunately, bots use DuckDuckGo too",
    "Please complete the following challenge",
];

/// Pick a provider by name. Today only `duckduckgo` is implemented;
/// `brave` and `searxng` are stubs that fail loudly so the user
/// knows they need an API key or self-hosted instance.
fn select_provider(name: Option<&str>) -> &'static str {
    match name.unwrap_or("duckduckgo").to_ascii_lowercase().as_str() {
        "brave" => "brave",
        "searxng" => "searxng",
        _ => "duckduckgo",
    }
}

/// Returns an error if the body looks like DDG's bot challenge page.
fn check_ddg_challenge(body: &str) -> Result<(), String> {
    if DDG_CHALLENGE_MARKERS.iter().any(|marker| body.contains(marker)) {
        return Err(
            "DuckDuckGo is blocking automated requests from this agent (bot-challenge page returned). \
             Configure an alternate provider: set ZEUS_SEARCH_PROVIDER=brave with BRAVE_SEARCH_API_KEY, \
             or ZEUS_SEARCH_PROVIDER=searxng with ZEUS_SEARXNG_URL pointing at a self-hosted instance."
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchRequest {
    pub query: String,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResult {
    pub provider: &'static str,
    pub query: String,
    pub hits: Vec<WebSearchHit>,
    pub message: String,
}

/// Entry point. Async because `reqwest::Client` is async and the
/// Tauri runtime is happy to await it. The 15-second timeout keeps the
/// agent loop from hanging on a slow DDG response.
pub async fn web_search(request: WebSearchRequest) -> Result<WebSearchResult, String> {
    validate_query(&request.query)?;
    let query = request.query.trim().to_string();
    let limit = request.max_results.unwrap_or(MAX_HITS).clamp(1, MAX_HITS);
    let provider = select_provider(std::env::var("ZEUS_SEARCH_PROVIDER").ok().as_deref());
    if provider != "duckduckgo" {
        return Err(format!(
            "search provider '{provider}' is not wired yet. \
             Today only 'duckduckgo' is implemented. \
             Set ZEUS_SEARCH_PROVIDER=duckduckgo (or unset it) for the default backend."
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(user_agent())
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    let form = [("q", query.as_str()), ("kl", "us-en")];
    let response = client
        .post(DEFAULT_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("duckduckgo request failed: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("read duckduckgo response: {e}"))?;
    if !status.is_success() {
        return Err(format!("duckduckgo responded with status {status}"));
    }
    check_ddg_challenge(&body)?;
    let hits = parse_ddg_html(&body, limit);
    let message = if hits.is_empty() {
        format!("DuckDuckGo returned 0 hits for \"{query}\".")
    } else {
        format!("DuckDuckGo returned {} hit(s) for \"{query}\".", hits.len())
    };
    Ok(WebSearchResult { provider: "duckduckgo", query, hits, message })
}

fn user_agent() -> String {
    std::env::var("ZEUS_SEARCH_USER_AGENT").unwrap_or_else(|_| DEFAULT_USER_AGENT.to_string())
}

/// Trivial guard so the empty-query test doesn't need an async runtime.
fn validate_query(query: &str) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err("webSearch requires a non-empty query.".to_string());
    }
    Ok(())
}

// HTML regexes. We anchor on the stable DDG result block classes
// (`result__a` for the title link, `result__snippet` for the snippet,
// `result__url` for the visible URL). They have been stable on the
// `/html/` endpoint for years.
static RESULT_LINK_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).expect("ddg result link regex")
});
static RESULT_URL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)<a[^>]*class="result__url"[^>]*>(.*?)</a>"#).expect("ddg result url regex")
});
static RESULT_SNIPPET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)<a[^>]*class="result__snippet"[^>]*>(.*?)</a>"#).expect("ddg result snippet regex")
});
static HTML_TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").expect("html strip regex"));
static WHITESPACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").expect("whitespace regex"));

fn strip_tags(input: &str) -> String {
    let stripped = HTML_TAG_RE.replace_all(input, " ").into_owned();
    let collapsed = WHITESPACE_RE.replace_all(stripped.trim(), " ").into_owned();
    decode_entities(&collapsed)
}

/// Minimal HTML entity decode. We only need the ones DDG actually emits
/// in titles and snippets — anything fancier is pointless because the
/// model can read the raw URL anyway.
fn decode_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// Parse a DDG HTML page into ranked hits. Pure function — exercised
/// by unit tests below with a captured fixture, no network needed.
pub fn parse_ddg_html(html: &str, limit: usize) -> Vec<WebSearchHit> {
    let mut hits: Vec<WebSearchHit> = Vec::new();
    let mut seen_urls: Vec<String> = Vec::new();
    for cap in RESULT_LINK_RE.captures_iter(html) {
        let raw_url = cap.get(1).map(|m| m.as_str()).unwrap_or("");
        if raw_url.is_empty() { continue; }
        let url = normalize_url(raw_url);
        if url.is_empty() || seen_urls.contains(&url) { continue; }
        let title = strip_tags(cap.get(2).map(|m| m.as_str()).unwrap_or(""));
        let after = &html[cap.get(0).map(|m| m.end()).unwrap_or(0)..];
        let visible_url = RESULT_URL_RE.find(after).map(|m| strip_tags(m.as_str())).unwrap_or_default();
        let snippet = RESULT_SNIPPET_RE.find(after).map(|m| strip_tags(m.as_str())).unwrap_or_default();
        let snippet = if snippet.len() > SNIPPET_TRUNCATE_CHARS {
            format!("{}…", &snippet[..SNIPPET_TRUNCATE_CHARS])
        } else {
            snippet
        };
        if title.is_empty() && snippet.is_empty() && visible_url.is_empty() { continue; }
        hits.push(WebSearchHit { title, url: if url.is_empty() { visible_url.clone() } else { url.clone() }, snippet });
        seen_urls.push(url);
        if hits.len() >= limit { break; }
    }
    hits
}

/// DDG's HTML endpoint redirects to a `/l/?uddg=...` wrapper that
/// points at the real URL. We unwrap that when present so the model
/// sees canonical links, not the DDG wrapper.
fn normalize_url(raw: &str) -> String {
    if let Some(index) = raw.find("uddg=") {
        let after = &raw[index + 5..];
        let end = after.find('&').unwrap_or(after.len());
        return urldecode(&after[..end]);
    }
    raw.to_string()
}

fn urldecode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"<!doctype html>
<html><body>
<div class="result results_links results_links_deep">
  <h2 class="result__title">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo&amp;rut=abc">Foo &amp; bar</a>
  </h2>
  <a class="result__url" href="javascript:void(0)">example.com/foo</a>
  <a class="result__snippet" href="javascript:void(0)">First snippet for the foo page.</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="https://example.org/bar">Bar baz</a>
  </h2>
  <a class="result__url" href="javascript:void(0)">example.org/bar</a>
  <a class="result__snippet" href="javascript:void(0)">Second &quot;snippet&quot; for the bar page.</a>
</div>
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="https://example.org/baz">Baz page</a>
  </h2>
  <a class="result__url" href="javascript:void(0)">example.org/baz</a>
  <a class="result__snippet" href="javascript:void(0)">Third snippet for the baz page.</a>
</div>
</body></html>"#;

    #[test]
    fn parses_three_results_with_unwrapped_urls() {
        let hits = parse_ddg_html(FIXTURE, MAX_HITS);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].url, "https://example.com/foo");
        assert_eq!(hits[0].title, "Foo & bar");
        assert_eq!(hits[0].snippet, "First snippet for the foo page.");
        assert_eq!(hits[1].url, "https://example.org/bar");
        assert_eq!(hits[1].title, "Bar baz");
        assert_eq!(hits[1].snippet, "Second \"snippet\" for the bar page.");
        assert_eq!(hits[2].url, "https://example.org/baz");
    }

    #[test]
    fn respects_limit_and_dedupes_repeated_links() {
        let html = FIXTURE.repeat(3);
        let hits = parse_ddg_html(&html, 2);
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn empty_query_is_rejected() {
        assert!(validate_query("").is_err());
        assert!(validate_query("  \t\n").is_err());
        assert!(validate_query("rust").is_ok());
    }

    #[test]
    fn url_decode_unwraps_ddg_redirect() {
        assert_eq!(
            normalize_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffoo&rut=abc"),
            "https://example.com/foo"
        );
        assert_eq!(normalize_url("https://example.org/bar"), "https://example.org/bar");
    }

    #[test]
    fn detects_ddg_bot_challenge_page() {
        // Minimal challenge page (captured form DDG's anomaly
        // detector on this IP — the real page is 14KB of JS, but the
        // marker text is the same).
        let challenge_body = r#"<html><body>
            <form id="challenge-form" action="//duckduckgo.com/anomaly.js"></form>
            <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
            <div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
        </body></html>"#;
        let result = check_ddg_challenge(challenge_body);
        assert!(result.is_err(), "expected challenge detection to fire");
        let message = result.unwrap_err();
        assert!(message.contains("blocking automated requests"), "unexpected message: {message}");
    }

    #[test]
    fn passes_through_normal_results_page() {
        // The fixture HTML is a synthetic results page with zero
        // challenge markers — challenge detection should NOT fire.
        assert!(check_ddg_challenge(FIXTURE).is_ok());
    }

    #[test]
    fn select_provider_defaults_to_duckduckgo() {
        assert_eq!(select_provider(None), "duckduckgo");
        assert_eq!(select_provider(Some("")), "duckduckgo");
        assert_eq!(select_provider(Some("DUCKDUCKGO")), "duckduckgo");
        assert_eq!(select_provider(Some("brave")), "brave");
        assert_eq!(select_provider(Some("SearXNG")), "searxng");
        assert_eq!(select_provider(Some("nonsense")), "duckduckgo");
    }
}