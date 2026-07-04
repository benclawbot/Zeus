//! OpenAI provider implementation.
//!
//! Speaks the OpenAI chat-completions protocol at `https://api.openai.com/v1`.
//! Reads the API key from the `OPENAI_API_KEY` environment variable.
//!
//! Stubs `display_name` / `default_model` so the frontend can render a
//! picker without the user configuring the key first. Once an API key is
//! present in the environment, real completions work the same as MiniMax.

use std::future::Future;
use std::pin::Pin;

use serde::Deserialize;
use serde_json::Value;

use super::{ChatMessage, ChatProvider, ChatResponse, ProviderError};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-4o-mini";
pub const ENV_VAR: &str = "OPENAI_API_KEY";

pub struct OpenAiProvider;

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

impl ChatProvider for OpenAiProvider {
    fn id(&self) -> &'static str {
        "openai"
    }

    fn default_model(&self) -> &'static str {
        DEFAULT_MODEL
    }

    fn display_name(&self) -> &'static str {
        "OpenAI"
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
            let payload = serde_json::json!({
                "model": model.unwrap_or(DEFAULT_MODEL),
                "messages": messages,
            });

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

            let content = parsed
                .choices
                .first()
                .and_then(|choice| choice.message.content.clone())
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| ProviderError::EmptyContent { provider: self.id().to_string() })?;

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
        let provider = OpenAiProvider;
        assert_eq!(provider.id(), "openai");
        assert_eq!(provider.default_model(), "gpt-4o-mini");
        assert_eq!(provider.display_name(), "OpenAI");
    }
}