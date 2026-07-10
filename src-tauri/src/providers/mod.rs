// Provider module — pluggable chat backends.
//
// Adding a new provider (e.g. anthropic, openai, ollama) is a three-step
// recipe:
//
//   1. Add `src-tauri/src/providers/<name>.rs` exporting a struct that
//      implements the [`ChatProvider`] trait declared in this file.
//   2. Register the struct in `BUILTIN_PROVIDERS` below.
//   3. Add a matching entry in `src/providers/<name>.ts` on the frontend
//      and register it in `src/providers/registry.ts`.
//
// The rest of the app talks to providers through the generic `ChatRequest`
// shape — it never imports any concrete provider.

mod anthropic;
mod minimax;
mod openai;

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Build a synthetic system message that injects a skill's instructions
/// into the next LLM call, given the raw SKILL.md contents. Pure helper so
/// it can be exercised by unit tests without an `AppHandle`. Provider-agnostic
/// — every provider gets the same shape.
pub fn build_skill_system_message(skill_id: &str, raw: &str) -> Option<ChatMessage> {
    let rest = raw.strip_prefix("---")?;
    let end = rest.find("---")?;
    let frontmatter = rest[..end].trim();
    let name =
        extract_frontmatter_value(frontmatter, "name").unwrap_or_else(|| skill_id.to_string());
    let body = raw.splitn(3, "---").nth(2).unwrap_or("").trim();
    if body.is_empty() {
        return None;
    }
    let prompt = format!(
        "The following local skill is now active for this conversation. Follow its instructions exactly.\n\n<skill id=\"{skill_id}\" name=\"{name}\">\n{body}\n</skill>"
    );
    Some(ChatMessage {
        role: "system".to_string(),
        content: serde_json::Value::String(prompt),
    })
}

fn extract_frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in frontmatter.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            let value = rest.trim();
            let trimmed = value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim()
                .to_string();
            return Some(trimmed);
        }
    }
    None
}

#[cfg(test)]
mod skill_message_tests {
    use super::*;

    #[test]
    fn wraps_body_with_id_and_name() {
        let raw = "---\nname: debugging-and-error-recovery\ndescription: root-cause\n---\n\nAlways reproduce first.\n";
        let msg = build_skill_system_message("debugging-and-error-recovery", raw).unwrap();
        assert_eq!(msg.role, "system");
        assert!(message_text(&msg.content).contains("debugging-and-error-recovery"));
        assert!(message_text(&msg.content).contains("Always reproduce first."));
        assert!(message_text(&msg.content).contains("<skill"));
    }

    #[test]
    fn empty_body_returns_none() {
        let raw = "---\nname: empty\n---\n\n";
        assert!(build_skill_system_message("empty", raw).is_none());
    }

    #[test]
    fn no_frontmatter_returns_none() {
        let raw = "no frontmatter\n";
        assert!(build_skill_system_message("nope", raw).is_none());
    }

    #[test]
    fn uses_id_as_name_when_frontmatter_omits_it() {
        let raw = "---\ndescription: only a description\n---\n\nbody\n";
        let msg = build_skill_system_message("fallback-id", raw).unwrap();
        assert!(message_text(&msg.content).contains("fallback-id"));
    }
}

/// Generic chat request shape used by every provider. Provider-specific
/// options (model id, base URL, temperature, custom headers, etc.) flow
/// through the `options` bag as a free-form JSON value so adding a new
/// field never requires touching this struct.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: String,
    pub messages: Vec<ChatMessage>,
    /// Optional skill id. When set, the skill body is loaded server-side and
    /// prepended to the system prompt so the skill context is never sent
    /// over the IPC bridge by the frontend.
    pub skill_id: Option<String>,
    /// Provider-specific options. Each provider documents its own keys.
    /// The convention is `{ "model": "...", "baseUrl": "...", "temperature": 0.7 }`
    /// — providers are free to read more keys they care about.
    #[serde(default)]
    pub options: serde_json::Value,
}

/// One chat message in the universal OpenAI-compatible shape used by every
/// provider we ship. Providers that don't accept this exact role set map it
/// to their native shape inside their [`ChatProvider::send`] impl.
///
/// `content` is `serde_json::Value` (not a plain `String`) so the frontend
/// can ship multimodal payloads — `[{type:"text",text:"..."},
/// {type:"image_url",image_url:{url:"data:..."}}]` — without each provider
/// having to re-define the wire shape. Providers serialize the value as-is
/// for OpenAI-compatible endpoints (MiniMax), or translate it to their
/// native blocks for Anthropic. Untagged content keeps backward compat
/// with the old `content: "string"` shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: serde_json::Value,
}

/// Pull the textual portion of a multimodal message back into a `String`.
/// Used by providers (and tests) that still need a flat string — e.g.
/// Anthropic's prompt assembly, the build_skill_system_message tests.
pub fn message_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                part.get("type").and_then(|t| t.as_str()).and_then(|t| {
                    if t == "text" {
                        part.get("text")
                            .and_then(|v| v.as_str())
                            .map(str::to_string)
                    } else {
                        None
                    }
                })
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Generic chat response. Every provider returns the same shape so the
/// frontend doesn't branch on provider id to render the answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub content: String,
    pub model: String,
    pub usage: Option<serde_json::Value>,
}

/// What every chat provider must implement. Returned futures are boxed so
/// `dyn ChatProvider` stays object-safe without pulling in `async_trait`.
pub trait ChatProvider: Send + Sync {
    /// Stable id used in Tauri commands and frontend registry. Lowercase,
    /// no spaces (e.g. "minimax", "anthropic").
    fn id(&self) -> &'static str;

    /// Default model id used when the request omits one.
    fn default_model(&self) -> &'static str;

    /// Default API base URL used when the request omits one. Trailing
    /// slash optional; the dispatcher will append `/chat/completions`.
    fn default_base_url(&self) -> &'static str;

    /// Human-readable label shown in the UI's provider picker.
    fn display_name(&self) -> &'static str;

    /// Run the chat completion. Implementations receive `messages` already
    /// augmented with the optional `skill_message` at index 0 — they should
    /// forward it through as-is. `model` and `base_url` come from the
    /// request options when set, otherwise the provider's defaults are used.
    fn send<'a>(
        &'a self,
        messages: &'a [ChatMessage],
        model: Option<&'a str>,
        base_url: Option<&'a str>,
        skill_message: Option<&'a ChatMessage>,
    ) -> Pin<Box<dyn Future<Output = Result<ChatResponse, ProviderError>> + Send + 'a>>;
}

/// Errors returned by a provider. The `public_message` form is what the
/// frontend sees, so implementations must avoid leaking secrets.
#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("Unknown provider '{0}'.")]
    Unknown(String),
    #[error("API key for provider '{provider}' is not set.")]
    MissingApiKey { provider: String },
    #[error("{provider} request failed before a response was received.")]
    Network { provider: String },
    #[error("{provider} returned HTTP {status}.")]
    Http { provider: String, status: u16 },
    #[error("{provider} returned a response that could not be parsed.")]
    Parse { provider: String },
    #[error("{provider} returned no assistant content.")]
    EmptyContent { provider: String },
    #[error("{0}")]
    Skill(String),
    #[error("{provider} rejected the request: {message}")]
    BadRequest { provider: String, message: String },
}

impl ProviderError {
    pub fn public_message(&self) -> String {
        self.to_string()
    }
}

impl From<ProviderError> for String {
    fn from(error: ProviderError) -> String {
        error.public_message()
    }
}

/// Built-in provider registry. Providers are registered here at compile
/// time. To add a new one, append it to this slice.
static BUILTIN_PROVIDERS: &[&'static dyn ChatProvider] = &[
    &minimax::MinimaxProvider,
    &openai::OpenAiProvider,
    &anthropic::AnthropicProvider,
];

/// Look up a provider by its stable id.
pub fn find_provider(id: &str) -> Option<&'static dyn ChatProvider> {
    BUILTIN_PROVIDERS
        .iter()
        .copied()
        .find(|provider| provider.id() == id)
}

/// Lightweight summary used by the frontend to render a provider picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: String,
    pub display_name: String,
    pub default_model: String,
}

/// Public list of all registered providers, for the UI to enumerate.
pub fn list_provider_info() -> Vec<ProviderInfo> {
    BUILTIN_PROVIDERS
        .iter()
        .map(|provider| ProviderInfo {
            id: provider.id().to_string(),
            display_name: provider.display_name().to_string(),
            default_model: provider.default_model().to_string(),
        })
        .collect()
}

/// Convenience wrapper that resolves a provider by id and dispatches the
/// chat call. Returns the same `ProviderError` shape regardless of which
/// provider actually ran.
pub async fn dispatch_chat(
    request: &ChatRequest,
    skill_message: Option<&ChatMessage>,
) -> Result<ChatResponse, ProviderError> {
    let provider = find_provider(&request.provider)
        .ok_or_else(|| ProviderError::Unknown(request.provider.clone()))?;
    let model = extract_model(request);
    let base_url = extract_base_url(request);
    provider
        .send(&request.messages, model, base_url, skill_message)
        .await
}

/// Read the model id out of the provider-specific options bag. Each
/// provider may use its own key — the convention is `"model"`.
fn extract_model(request: &ChatRequest) -> Option<&str> {
    request
        .options
        .as_object()
        .and_then(|obj| obj.get("model"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
}

/// Read the API base URL out of the provider-specific options bag.
/// Convention is `"baseUrl"`. Empty / whitespace strings are treated as
/// "use the provider default" by returning None.
fn extract_base_url(request: &ChatRequest) -> Option<&str> {
    request
        .options
        .as_object()
        .and_then(|obj| obj.get("baseUrl"))
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_providers_have_unique_ids() {
        let info = list_provider_info();
        let mut ids: Vec<&str> = info.iter().map(|p| p.id.as_str()).collect();
        ids.sort();
        let original_len = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), original_len, "duplicate provider id");
        assert!(!ids.is_empty(), "no providers registered");
    }

    #[test]
    fn extract_model_reads_options_bag() {
        let request = ChatRequest {
            provider: "minimax".to_string(),
            messages: vec![],
            skill_id: None,
            options: serde_json::json!({ "model": "  " }),
        };
        assert_eq!(extract_model(&request), None);

        let request = ChatRequest {
            provider: "minimax".to_string(),
            messages: vec![],
            skill_id: None,
            options: serde_json::json!({ "model": "MiniMax-M3" }),
        };
        assert_eq!(extract_model(&request), Some("MiniMax-M3"));
    }

    #[test]
    fn extract_base_url_reads_options_bag() {
        let request = ChatRequest {
            provider: "minimax".to_string(),
            messages: vec![],
            skill_id: None,
            options: serde_json::json!({ "baseUrl": "  " }),
        };
        assert_eq!(extract_base_url(&request), None);

        let request = ChatRequest {
            provider: "minimax".to_string(),
            messages: vec![],
            skill_id: None,
            options: serde_json::json!({ "baseUrl": "https://api.example.test/v1" }),
        };
        assert_eq!(
            extract_base_url(&request),
            Some("https://api.example.test/v1")
        );
    }

    #[test]
    fn dispatch_chat_unknown_provider_yields_unknown_error() {
        let request = ChatRequest {
            provider: "made-up-provider".to_string(),
            messages: vec![],
            skill_id: None,
            options: serde_json::Value::Null,
        };
        let result = futures_block_on(dispatch_chat(&request, None));
        match result {
            Err(ProviderError::Unknown(id)) => assert_eq!(id, "made-up-provider"),
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    /// Tiny block_on helper for tests so we don't depend on tokio's
    /// `block_on` (we already pull tokio in via tauri but we keep the
    /// surface narrow here).
    fn futures_block_on<F: std::future::Future>(future: F) -> F::Output {
        // tauri 2 already pins a single-thread executor via reqwest's tokio
        // runtime, so we can poll the future directly in a tight loop.
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};

        fn dummy_waker() -> Waker {
            fn no_op(_: *const ()) {}
            fn clone(_: *const ()) -> RawWaker {
                RawWaker::new(std::ptr::null(), &VT)
            }
            static VT: RawWakerVTable = RawWakerVTable::new(clone, no_op, no_op, no_op);
            unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VT)) }
        }

        let mut future = Box::pin(future);
        let waker = dummy_waker();
        let mut cx = Context::from_waker(&waker);
        loop {
            match future.as_mut().poll(&mut cx) {
                Poll::Ready(value) => return value,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }
}
