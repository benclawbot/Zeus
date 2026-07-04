//! MiniMax provider implementation.
//!
//! Speaks the OpenAI-compatible chat-completions protocol at
//! `https://api.minimax.io/v1` and uses `MiniMax-M3` as the default model.
//! Reads the API key from the `MINIMAX_API_KEY` environment variable.

use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;
use serde_json::{json, Value};

use super::{ChatMessage, ChatProvider, ChatResponse, ProviderError};

const DEFAULT_BASE_URL: &str = "https://api.minimax.io/v1";
const DEFAULT_MODEL: &str = "MiniMax-M3";
/// Name of the env var that holds the API key. Public so the frontend
/// settings panel can document the requirement.
pub const ENV_VAR: &str = "MINIMAX_API_KEY";

pub struct MinimaxProvider;

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    model: Option<String>,
    choices: Vec<OpenAiChoice>,
    usage: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    content: Option<String>,
}

impl ChatProvider for MinimaxProvider {
    fn id(&self) -> &'static str {
        "minimax"
    }

    fn default_model(&self) -> &'static str {
        DEFAULT_MODEL
    }

    fn display_name(&self) -> &'static str {
        "MiniMax"
    }

    fn send<'a>(
        &'a self,
        messages: &'a [ChatMessage],
        model: Option<&'a str>,
        _skill_message: Option<&'a ChatMessage>,
    ) -> Pin<Box<dyn Future<Output = Result<ChatResponse, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let api_key = std::env::var(ENV_VAR)
                .map_err(|_| ProviderError::MissingApiKey { provider: self.id().to_string() })?;

            let endpoint = format!("{}/chat/completions", DEFAULT_BASE_URL.trim_end_matches('/'));
            let payload = build_payload(model.unwrap_or(DEFAULT_MODEL), messages);

            let client = reqwest::Client::new();
            let response = client
                .post(&endpoint)
                .bearer_auth(&api_key)
                .json(&payload)
                .send()
                .await
                .map_err(|_| ProviderError::Network { provider: self.id().to_string() })?;

            let status = response.status();
            let body = response
                .text()
                .await
                .map_err(|_| ProviderError::Network { provider: self.id().to_string() })?;

            if !status.is_success() {
                return Err(ProviderError::Http {
                    provider: self.id().to_string(),
                    status: status.as_u16(),
                });
            }

            let parsed: OpenAiChatResponse = serde_json::from_str(&body)
                .map_err(|_| ProviderError::Parse { provider: self.id().to_string() })?;

            let raw_content = parsed
                .choices
                .first()
                .and_then(|choice| choice.message.content.clone())
                .ok_or_else(|| ProviderError::EmptyContent { provider: self.id().to_string() })?;

            // Strip `<think>...</think>` reasoning blocks — the provider emits
            // them in the assistant content and they're useful to the model
            // but not to end users. The chars are reconstructed so the
            // literal tag pair never appears in this source file.
            let content = strip_thinking(&raw_content);
            if content.trim().is_empty() {
                return Err(ProviderError::EmptyContent { provider: self.id().to_string() });
            }

            Ok(ChatResponse {
                content,
                model: parsed.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                usage: parsed.usage,
            })
        })
    }
}

fn build_payload(model: &str, messages: &[ChatMessage]) -> Value {
    json!({
        "model": model,
        "messages": messages,
        "thinking": { "type": "adaptive" }
    })
}

/// Remove `<think>...</think>` reasoning blocks. Splitting the tag chars
/// keeps the literal tag pair out of this source file (some editor
/// pipelines strip them).
pub fn strip_thinking(content: &str) -> String {
    let open: &[char] = &['<', 't', 'h', 'i', 'n', 'k', '>'];
    let close: &[char] = &['<', '/', 't', 'h', 'i', 'n', 'k', '>'];
    let chars: Vec<char> = content.chars().collect();
    let mut out = String::with_capacity(content.len());
    let mut i = 0;
    while i < chars.len() {
        if i + open.len() <= chars.len() && chars[i..i + open.len()] == *open {
            let mut j = i + open.len();
            let mut found_close = false;
            while j + close.len() <= chars.len() {
                if chars[j..j + close.len()] == *close {
                    j += close.len();
                    found_close = true;
                    break;
                }
                j += 1;
            }
            if !found_close {
                break;
            }
            i = j;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag_open() -> String {
        char::from_u32(0x3C).unwrap().to_string()
            + "think"
            + &char::from_u32(0x3E).unwrap().to_string()
    }
    fn tag_close() -> String {
        char::from_u32(0x3C).unwrap().to_string()
            + "/"
            + "think"
            + &char::from_u32(0x3E).unwrap().to_string()
    }

    #[test]
    fn id_and_defaults_match() {
        let provider = MinimaxProvider;
        assert_eq!(provider.id(), "minimax");
        assert_eq!(provider.default_model(), "MiniMax-M3");
        assert_eq!(provider.display_name(), "MiniMax");
    }

    #[test]
    fn strip_thinking_removes_single_block() {
        let raw = format!(
            "{}some reasoning here{}The user asked X.\nThe answer is 42.",
            tag_open(),
            tag_close()
        );
        assert_eq!(strip_thinking(&raw), "The user asked X.\nThe answer is 42.");
    }

    #[test]
    fn strip_thinking_removes_multiple_blocks() {
        let raw = format!(
            "{open}first{close}And second.{open}Final{close} keep.",
            open = tag_open(),
            close = tag_close(),
        );
        assert_eq!(strip_thinking(&raw), "And second. keep.");
    }

    #[test]
    fn strip_thinking_handles_unterminated_block() {
        let raw = format!("ok preamble {}unfinished reasoning forever", tag_open());
        assert_eq!(strip_thinking(&raw), "ok preamble");
    }

    #[test]
    fn strip_thinking_passes_through_plain_text() {
        let raw = "Just a normal reply with no reasoning.".to_string();
        assert_eq!(strip_thinking(&raw), raw);
    }

    #[test]
    fn build_payload_includes_model_messages_and_thinking() {
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
        }];
        let payload = build_payload("MiniMax-M3", &messages);
        assert_eq!(payload["model"], "MiniMax-M3");
        assert_eq!(payload["messages"][0]["content"], "hi");
        assert_eq!(payload["thinking"]["type"], "adaptive");
    }
}