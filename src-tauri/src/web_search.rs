//! Web search tool. Three backends, auto-detected:
//!
//! - `ddgs` (preferred) — Tauri sidecar binary (`ddgs-<target>.exe`)
//!   shipped inside the Zeus installer. Self-contained: bundles
//!   Python + `ddgs` + `curl-cffi` so end users don't need to pip-
//!   install anything. Resolves via `ZEUS_DDGS_BIN` → next to the main
//!   exe → PATH. The sidecar uses `curl-cffi` to mimic a real browser's
//!   TLS fingerprint and bypass DDG's anomaly detector. No API key,
//!   works from consumer IPs.
//! - `searxng` — `GET {ZEUS_SEARXNG_URL}/search?q=...&format=json`.
//!   Bring-your-own self-hosted instance with JSON output enabled.
//! - `duckduckgo` (last-resort fallback) — raw HTML scrape against
//!   `https://html.duckduckgo.com/html/`. Frequently CAPTCHA'd from
//!   consumer IPs. When DDG serves its anomaly challenge page, we
//!   surface it as an explicit error rather than the misleading "0
//!   hits" a naive parser would return.
//!
//! Override the auto-detected choice with
//! `ZEUS_SEARCH_PROVIDER=ddgs|searxng|duckduckgo`.
//!
//! Auto-fallback: when the auto-detected provider errors out at
//! runtime (e.g., the ddgs sidecar is missing on a source build),
//! `web_search` retries the next provider in `ddgs → searxng → duckduckgo`
//! order so a single transient failure doesn't break the agent loop.
//! An explicit `ZEUS_SEARCH_PROVIDER` always wins (no fallback).

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::time::Duration;

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};

const DEFAULT_ENDPOINT: &str = "https://html.duckduckgo.com/html/";
const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) ZeusBot/1.0 (+https://github.com/benclawbot/Zeus)";

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

/// Resolve which backend to use. If `ZEUS_SEARCH_PROVIDER` is set,
/// honor it. Otherwise auto-detect: prefer `ddgs` when its CLI is
/// installed (no key, bypasses DDG's bot challenge via curl-cffi),
/// then `searxng` when `ZEUS_SEARXNG_URL` is set, fall back to
/// `duckduckgo` (raw HTML scrape; gets CAPTCHA'd from consumer IPs).
fn select_provider(name: Option<&str>) -> &'static str {
    if let Some(value) = name {
        return match value.to_ascii_lowercase().as_str() {
            "ddgs" => "ddgs",
            "searxng" => "searxng",
            _ => "duckduckgo",
        };
    }
    if resolve_ddgs_bin().is_some() {
        return "ddgs";
    }
    if std::env::var("ZEUS_SEARXNG_URL").is_ok() {
        return "searxng";
    }
    "duckduckgo"
}

/// All the filenames ddgs could ship as across platforms and packaging
/// styles. Tauri sidecars are normally `<name><.exe on Windows>`, but
/// the user can also install ddgs via `pip` / `uv` which lands it as a
/// Python script wrapper.
fn ddgs_candidate_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["ddgs.exe", "ddgs", "ddgs.bat", "ddgs.cmd"]
    } else {
        &["ddgs"]
    }
}

/// Returns an error if the body looks like DDG's bot challenge page.
fn check_ddg_challenge(body: &str) -> Result<(), String> {
    if DDG_CHALLENGE_MARKERS
        .iter()
        .any(|marker| body.contains(marker))
    {
        return Err(
            "DuckDuckGo is blocking automated requests from this agent (bot-challenge page returned). \
             Install the ddgs Python package (`pip install ddgs`) and add its bin to PATH, \
             or set ZEUS_SEARCH_PROVIDER=searxng with ZEUS_SEARXNG_URL pointing at a self-hosted instance."
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
    let explicit = std::env::var("ZEUS_SEARCH_PROVIDER").ok();
    let provider = select_provider(explicit.as_deref());

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(user_agent())
        .build()
        .map_err(|e| format!("build http client: {e}"))?;

    // Build the chain in auto-detect order; explicit picks win and skip fallback.
    let order: &[&str] = if explicit.is_some() {
        &[provider]
    } else {
        // Auto-detect order: ddgs (if resolvable) → searxng (if configured) → duckduckgo.
        // select_provider already returned the first resolvable one; the rest follow the same
        // preference so the chain below matches what the user would expect.
        match provider {
            "ddgs" => &["ddgs", "searxng", "duckduckgo"],
            "searxng" => &["searxng", "duckduckgo"],
            _ => &["duckduckgo"],
        }
    };

    let mut last_err = String::new();
    for candidate in order {
        let result = match *candidate {
            "ddgs" => ddgs_search(&query, limit).await,
            "searxng" => searxng_search(&client, &query, limit).await,
            "duckduckgo" => duckduckgo_search(&client, &query, limit).await,
            other => Err(format!("unknown search provider: {other}")),
        };
        match result {
            Ok(value) => return Ok(value),
            Err(err) => {
                // On the explicit branch there's no point retrying — bubble.
                if explicit.is_some() {
                    return Err(err);
                }
                eprintln!("web_search: {candidate} failed: {err}; trying next provider");
                last_err = err;
            }
        }
    }
    Err(format!(
        "all search providers failed; last error: {last_err}"
    ))
}

async fn duckduckgo_search(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<WebSearchResult, String> {
    let form = [("q", query), ("kl", "us-en")];
    let response = client
        .post(DEFAULT_ENDPOINT)
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("duckduckgo request failed: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("read duckduckgo response: {e}"))?;
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
    Ok(WebSearchResult {
        provider: "duckduckgo",
        query: query.to_string(),
        hits,
        message,
    })
}

/// ddgs sidecar backend. Zeus ships a self-contained `ddgs` exe as a
/// Tauri sidecar (built by `scripts/build-ddgs-sidecar.sh` — bundles
/// Python + ddgs + curl-cffi into one binary so end users don't have
/// to pip-install anything). The sidecar lives next to `zeus.exe` in
/// the install dir; we also fall back to PATH / `ZEUS_DDGS_BIN` so a
/// power user can swap in their own build.
///
/// Why the wrapper instead of the upstream `ddgs` CLI: ddgs 9.x ships
/// with a broken `-o json` stdout path (writes nothing). The wrapper
/// calls the `DDGS().text()` API directly and emits a stable JSON
/// array on stdout so the parser below stays simple.
async fn ddgs_search(query: &str, limit: usize) -> Result<WebSearchResult, String> {
    let bin = resolve_ddgs_bin().ok_or_else(|| {
        "ddgs sidecar not found. The installer should have placed it next to zeus.exe; \
         if you ran from source, run `bash scripts/build-ddgs-sidecar.sh` first. \
         As a last resort, install `pip install ddgs` and set ZEUS_DDGS_BIN to its binary."
            .to_string()
    })?;
    let output = {
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(["text", "-q", query, "-m", &limit.max(1).to_string()]);
        // CREATE_NO_WINDOW — without this, every webSearch briefly pops a
        // console window on Windows (the sidecar is a CLI exe) and triggers
        // UAC / SmartScreen prompts on first run. 0x08000000 is the official
        // flag value from WinBase.h. `creation_flags` is a Windows-only
        // method, so we gate it with #[cfg] rather than cfg!.
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000);
        }
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("spawn ddgs: {e}"))?
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "ddgs exited with status {}: {stderr}",
            output.status.code().unwrap_or(-1)
        ));
    }
    let body = String::from_utf8_lossy(&output.stdout).into_owned();
    let hits = parse_ddgs_json(&body, limit);
    let message = if hits.is_empty() {
        format!("ddgs returned 0 hits for \"{query}\".")
    } else {
        format!("ddgs returned {} hit(s) for \"{query}\".", hits.len())
    };
    Ok(WebSearchResult {
        provider: "ddgs",
        query: query.to_string(),
        hits,
        message,
    })
}

/// Locate the ddgs sidecar. Resolution order:
///
/// 1. `ZEUS_DDGS_BIN` env var (explicit override)
/// 2. `<dir of current_exe>/ddgs[.exe]` — Tauri places sidecars next to the main exe
/// 3. `ddgs` on PATH (portable across Windows + Unix)
///
/// Returns the first hit that's actually a file.
fn resolve_ddgs_bin() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("ZEUS_DDGS_BIN") {
        let p = std::path::PathBuf::from(path);
        if p.is_file() {
            return Some(p);
        }
    }
    // Bundled sidecar lives next to zeus.exe. current_exe() resolves the
    // real path on Windows even when launched via a symlink.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ddgs_candidate_names() {
                let candidate = dir.join(&name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    // Last-resort PATH walk. Useful when developing from `cargo run`.
    let path = std::env::var_os("PATH")?;
    let extensions: &[&str] = if cfg!(windows) {
        &["", ".exe", ".bat", ".cmd"]
    } else {
        &[""]
    };
    for dir in std::env::split_paths(&path) {
        for ext in extensions {
            let candidate = if ext.is_empty() {
                dir.join("ddgs")
            } else {
                dir.join(format!("ddgs{ext}"))
            };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Subset of the ddgs CLI's JSON output. Field names mirror the
/// `ddgs.text(...)` return shape: `title`, `href`, `body`.
#[derive(Debug, Deserialize)]
struct DdgsEntry {
    title: Option<String>,
    href: Option<String>,
    body: Option<String>,
}

/// Parse the ddgs CLI's JSON output into ranked hits. Pure function
/// — exercised by unit tests with a captured fixture.
pub fn parse_ddgs_json(body: &str, limit: usize) -> Vec<WebSearchHit> {
    let parsed: Vec<DdgsEntry> = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(err) => {
            eprintln!(
                "ddgs json parse failed: {err}; body preview: {}",
                body.chars()
                    .take(200)
                    .collect::<String>()
                    .replace('\n', " ")
            );
            return Vec::new();
        }
    };
    parsed
        .into_iter()
        .filter_map(|entry| {
            let url = entry.href.unwrap_or_default();
            if url.is_empty() {
                return None;
            }
            let title = entry.title.unwrap_or_default();
            let snippet = entry.body.unwrap_or_default();
            let snippet = if snippet.len() > SNIPPET_TRUNCATE_CHARS {
                format!("{}…", &snippet[..SNIPPET_TRUNCATE_CHARS])
            } else {
                snippet
            };
            Some(WebSearchHit {
                title,
                url,
                snippet,
            })
        })
        .take(limit.max(1))
        .collect()
}

/// SearXNG JSON backend. Expects `ZEUS_SEARXNG_URL` to point at a
/// running SearXNG instance with JSON output enabled (`server:
/// {"json": true}` in settings.yml). Uses the documented `/search`
/// endpoint with `format=json`.
async fn searxng_search(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<WebSearchResult, String> {
    let base = std::env::var("ZEUS_SEARXNG_URL")
        .map_err(|_| "ZEUS_SEARCH_PROVIDER=searxng requires ZEUS_SEARXNG_URL (e.g. https://searx.example.com).".to_string())?;
    let endpoint = format!("{}/search", base.trim_end_matches('/'));
    let response = client
        .get(&endpoint)
        .query(&[
            ("q", query),
            ("format", "json"),
            ("categories", "general"),
            ("language", "en-US"),
        ])
        .send()
        .await
        .map_err(|e| format!("searxng request failed: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("read searxng response: {e}"))?;
    if !status.is_success() {
        return Err(format!("searxng responded with status {status}"));
    }
    let hits = parse_searxng_json(&body, limit);
    let message = if hits.is_empty() {
        format!("SearXNG returned 0 hits for \"{query}\".")
    } else {
        format!("SearXNG returned {} hit(s) for \"{query}\".", hits.len())
    };
    Ok(WebSearchResult {
        provider: "searxng",
        query: query.to_string(),
        hits,
        message,
    })
}

/// Subset of SearXNG's JSON result shape. We only deserialize the
/// fields we surface; engines/parsed_url/etc. are ignored.
#[derive(Debug, Deserialize)]
struct SearxngResultEntry {
    title: Option<String>,
    url: Option<String>,
    content: Option<String>,
}

/// Subset of SearXNG's response envelope.
#[derive(Debug, Deserialize)]
struct SearxngResponse {
    #[serde(default)]
    results: Vec<SearxngResultEntry>,
}

/// Parse a SearXNG JSON response body into ranked hits. Pure function
/// — exercised by unit tests below with a captured fixture.
pub fn parse_searxng_json(body: &str, limit: usize) -> Vec<WebSearchHit> {
    let parsed: SearxngResponse = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(err) => {
            // SearXNG returns HTML error pages when JSON output is
            // disabled in settings.yml. Surface a clean empty result
            // rather than a JSON parse error so the caller can retry
            // without seeing an opaque serde dump.
            log_parse_failure(body, &err);
            return Vec::new();
        }
    };
    parsed
        .results
        .into_iter()
        .filter_map(|entry| {
            let url = entry.url.unwrap_or_default();
            if url.is_empty() {
                return None;
            }
            let title = entry.title.unwrap_or_default();
            let snippet = entry.content.unwrap_or_default();
            let snippet = if snippet.len() > SNIPPET_TRUNCATE_CHARS {
                format!("{}…", &snippet[..SNIPPET_TRUNCATE_CHARS])
            } else {
                snippet
            };
            Some(WebSearchHit {
                title,
                url,
                snippet,
            })
        })
        .take(limit.max(1))
        .collect()
}

fn log_parse_failure(body: &str, err: &serde_json::Error) {
    let preview: String = body.chars().take(200).collect();
    let body_snippet = preview.replace('\n', " ");
    eprintln!("searxng json parse failed: {err}; body preview: {body_snippet}");
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
    Regex::new(r#"(?s)<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#)
        .expect("ddg result link regex")
});
static RESULT_URL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)<a[^>]*class="result__url"[^>]*>(.*?)</a>"#).expect("ddg result url regex")
});
static RESULT_SNIPPET_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?s)<a[^>]*class="result__snippet"[^>]*>(.*?)</a>"#)
        .expect("ddg result snippet regex")
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
        if raw_url.is_empty() {
            continue;
        }
        let url = normalize_url(raw_url);
        if url.is_empty() || seen_urls.contains(&url) {
            continue;
        }
        let title = strip_tags(cap.get(2).map(|m| m.as_str()).unwrap_or(""));
        let after = &html[cap.get(0).map(|m| m.end()).unwrap_or(0)..];
        let visible_url = RESULT_URL_RE
            .find(after)
            .map(|m| strip_tags(m.as_str()))
            .unwrap_or_default();
        let snippet = RESULT_SNIPPET_RE
            .find(after)
            .map(|m| strip_tags(m.as_str()))
            .unwrap_or_default();
        let snippet = if snippet.len() > SNIPPET_TRUNCATE_CHARS {
            format!("{}…", &snippet[..SNIPPET_TRUNCATE_CHARS])
        } else {
            snippet
        };
        if title.is_empty() && snippet.is_empty() && visible_url.is_empty() {
            continue;
        }
        hits.push(WebSearchHit {
            title,
            url: if url.is_empty() {
                visible_url.clone()
            } else {
                url.clone()
            },
            snippet,
        });
        seen_urls.push(url);
        if hits.len() >= limit {
            break;
        }
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
        assert_eq!(
            normalize_url("https://example.org/bar"),
            "https://example.org/bar"
        );
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
        assert!(
            message.contains("blocking automated requests"),
            "unexpected message: {message}"
        );
    }

    #[test]
    fn passes_through_normal_results_page() {
        // The fixture HTML is a synthetic results page with zero
        // challenge markers — challenge detection should NOT fire.
        assert!(check_ddg_challenge(FIXTURE).is_ok());
    }

    #[test]
    fn select_provider_honors_explicit_name() {
        assert_eq!(select_provider(Some("ddgs")), "ddgs");
        assert_eq!(select_provider(Some("DUCKDUCKGO")), "duckduckgo");
        assert_eq!(select_provider(Some("SearXNG")), "searxng");
        assert_eq!(select_provider(Some("nonsense")), "duckduckgo");
        assert_eq!(select_provider(Some("")), "duckduckgo");
    }

    #[test]
    fn select_provider_auto_detects_ddgs_when_cli_present() {
        // ddgs CLI was just installed in the live test session, so the
        // auto-detect branch should pick it over the DDG fallback.
        if resolve_ddgs_bin().is_some() {
            assert_eq!(select_provider(None), "ddgs");
        }
    }

    const SEARXNG_FIXTURE: &str = r#"{
        "query": "rust async runtime",
        "results": [
            {"title": "Tokio", "url": "https://tokio.rs", "content": "An async runtime for Rust.", "engine": "bing"},
            {"title": "async-std", "url": "https://async.rs", "content": "Async runtime for Rust.", "engine": "duckduckgo"},
            {"title": "", "url": "https://missing.example.com", "content": "should be filtered out by missing title", "engine": "bing"}
        ]
    }"#;

    #[test]
    fn parses_searxng_json_results() {
        let hits = parse_searxng_json(SEARXNG_FIXTURE, MAX_HITS);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].title, "Tokio");
        assert_eq!(hits[0].url, "https://tokio.rs");
        assert_eq!(hits[0].snippet, "An async runtime for Rust.");
        assert_eq!(hits[1].url, "https://async.rs");
    }

    #[test]
    fn searxng_respects_limit() {
        let hits = parse_searxng_json(SEARXNG_FIXTURE, 1);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://tokio.rs");
    }

    #[test]
    fn searxng_truncates_long_snippets() {
        let body = format!(
            r#"{{"results":[{{"title":"Long","url":"https://example.com","content":"{}"}}]}}"#,
            "x".repeat(SNIPPET_TRUNCATE_CHARS + 50)
        );
        let hits = parse_searxng_json(&body, MAX_HITS);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.ends_with('…'));
        assert!(hits[0].snippet.chars().count() <= SNIPPET_TRUNCATE_CHARS + 1);
    }

    #[test]
    fn searxng_returns_empty_on_html_response() {
        // SearXNG with JSON output disabled returns HTML error pages.
        // The parser should fail soft (empty hits) rather than
        // bubbling up a serde error to the caller.
        let hits = parse_searxng_json(
            "<!DOCTYPE html><html><body>JSON output not enabled</body></html>",
            MAX_HITS,
        );
        assert!(hits.is_empty());
    }

    const DDGS_FIXTURE: &str = r#"[
        {"title": "Async Rust: What is a runtime?", "href": "https://kerkour.com/rust-async-await-what-is-a-runtime", "body": "Last week, we saw the difference between Cooperative and Preemptive scheduling."},
        {"title": "The State of Async Rust: Runtimes", "href": "https://corrode.dev/blog/async/", "body": "The suggested replacement is smol."},
        {"title": "", "href": "https://missing.example.com", "body": "should be filtered out by missing title"}
    ]"#;

    #[test]
    fn parses_ddgs_cli_json() {
        let hits = parse_ddgs_json(DDGS_FIXTURE, MAX_HITS);
        assert_eq!(hits.len(), 3);
        assert_eq!(hits[0].title, "Async Rust: What is a runtime?");
        assert_eq!(
            hits[0].url,
            "https://kerkour.com/rust-async-await-what-is-a-runtime"
        );
        assert_eq!(hits[1].url, "https://corrode.dev/blog/async/");
    }

    #[test]
    fn ddgs_respects_limit() {
        let hits = parse_ddgs_json(DDGS_FIXTURE, 1);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn ddgs_truncates_long_snippets() {
        let body = format!(
            r#"[{{"title":"Long","href":"https://example.com","body":"{}"}}]"#,
            "x".repeat(SNIPPET_TRUNCATE_CHARS + 50)
        );
        let hits = parse_ddgs_json(&body, MAX_HITS);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.ends_with('…'));
    }

    #[test]
    fn ddgs_returns_empty_on_garbage() {
        // ddgs CLI error path can pipe a stack trace to stdout when
        // -o json is misused. Parser should fail soft, not panic.
        let hits = parse_ddgs_json("Traceback (most recent call last):\n  ...", MAX_HITS);
        assert!(hits.is_empty());
    }
}
