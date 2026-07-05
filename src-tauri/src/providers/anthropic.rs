//! Anthropic provider implementation.
//!
//! Speaks the Anthropic Messages API at `https://api.anthropic.com/v1/messages`.
//! Reads the API key from the `ANTHROPIC_API_KEY` environment variable and
//! uses `claude-3-5-sonnet-latest` as the default model.
//!
//! Anthropic's wire format differs from OpenAI: the system prompt lives in a
//! top-level `system` field, not as a message in the array, and the response
//! carries `content[].text` instead of `choices[0].message.content`. This
//! file is the only place that translation happens.

use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;
use serde_json::{json, Value};

use super::{ChatMessage, ChatProvider, ChatResponse, ProviderError};

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com/v1";
const DEFAULT_MODEL: &str = "claude-3-5-sonnet-latest";
const API_VERSION: &str = "2023-06-01";
pub const ENV_VAR: &str = "ANTHROPIC_API_KEY";

pub struct AnthropicProvider;

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    model: Option<String>,
    content: Vec<AnthropicBlock>,
    usage: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct AnthropicBlock {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

impl ChatProvider for AnthropicProvider {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    fn default_model(&self) -> &'static str {
        DEFAULT_MODEL
    }

    fn display_name(&self) -> &'static str {
        "Anthropic"
    }

    fn send<'a>(
        &'a self,
        messages: &'a [ChatMessage],
        model: Option<&'a str>,
        _skill_message: Option<&'a ChatMessage>,
    ) -> Pin<Box<dyn Future<Output = Result<ChatResponse, ProviderError>> + Send + 'a>> {
        Box::pin(async move {
            let api_key = std::env::var(ENV_VAR).map_err(|_| ProviderError::MissingApiKey {
                provider: self.id().to_string(),
            })?;

            // Split out the system prompt — Anthropic's API requires it as
            // a top-level field, not as a message in the array.
            let (system, user_assistant): (Vec<&str>, Vec<&ChatMessage>) =
                messages
                    .iter()
                    .fold((Vec::new(), Vec::new()), |(mut sys, mut rest), msg| {
                        if msg.role == "system" {
                            sys.push(&msg.content);
                        } else {
                            rest.push(msg);
                        }
                        (sys, rest)
                    });

            let anthropic_messages: Vec<Value> = user_assistant
                .iter()
                .map(|msg| {
                    json!({
                        "role": msg.role,
                        "content": msg.content,
                    })
                })
                .collect();

            let payload = json!({
                "model": model.unwrap_or(DEFAULT_MODEL),
                "max_tokens": 1024,
                "system": system.join("\n\n"),
                "messages": anthropic_messages,
            });

            let endpoint = format!("{}/messages", DEFAULT_BASE_URL.trim_end_matches('/'));
            let client = reqwest::Client::new();
            let response = client
                .post(&endpoint)
                .header("x-api-key", &api_key)
                .header("anthropic-version", API_VERSION)
                .json(&payload)
                .send()
                .await
                .map_err(|_| ProviderError::Network {
                    provider: self.id().to_string(),
                })?;

            let status = response.status();
            let body = response.text().await.map_err(|_| ProviderError::Network {
                provider: self.id().to_string(),
            })?;

            if !status.is_success() {
                return Err(ProviderError::Http {
                    provider: self.id().to_string(),
                    status: status.as_u16(),
                });
            }

            let parsed: AnthropicResponse =
                serde_json::from_str(&body).map_err(|_| ProviderError::Parse {
                    provider: self.id().to_string(),
                })?;

            let content = parsed
                .content
                .into_iter()
                .filter(|block| block.kind == "text")
                .filter_map(|block| block.text)
                .collect::<Vec<_>>()
                .join("")
                .trim()
                .to_string();

            if content.is_empty() {
                return Err(ProviderError::EmptyContent {
                    provider: self.id().to_string(),
                });
            }

            Ok(ChatResponse {
                content,
                model: parsed.model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
                usage: parsed.usage,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_and_defaults_match() {
        let provider = AnthropicProvider;
        assert_eq!(provider.id(), "anthropic");
        assert_eq!(provider.default_model(), "claude-3-5-sonnet-latest");
        assert_eq!(provider.display_name(), "Anthropic");
    }
}
