use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;

const DEFAULT_MINIMAX_BASE_URL: &str = "https://api.minimax.io/v1";
const DEFAULT_MINIMAX_MODEL: &str = "MiniMax-M3";

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MinimaxChatRequest {
    pub messages: Vec<ChatMessage>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub temperature: Option<f32>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MinimaxChatResponse {
    pub content: String,
    pub model: String,
    pub usage: Option<Value>,
}

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

#[derive(Debug, Error)]
enum MinimaxError {
    #[error("MINIMAX_API_KEY is not set.")]
    MissingApiKey,
    #[error("MiniMax request failed before a response was received.")]
    Network,
    #[error("MiniMax returned HTTP {0}.")]
    Http(reqwest::StatusCode),
    #[error("MiniMax returned a response Zeus could not parse.")]
    Parse,
    #[error("MiniMax returned no assistant content.")]
    EmptyContent,
}

impl MinimaxError {
    fn public_message(&self) -> String {
        self.to_string()
    }
}

fn minimax_endpoint(base_url: Option<&str>) -> String {
    let base = base_url
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(DEFAULT_MINIMAX_BASE_URL)
        .trim_end_matches('/');
    format!("{base}/chat/completions")
}

fn minimax_payload(request: &MinimaxChatRequest) -> Value {
    let mut payload = json!({
        "model": request.model.as_deref().unwrap_or(DEFAULT_MINIMAX_MODEL),
        "messages": request.messages,
        "thinking": { "type": "adaptive" }
    });

    if let Some(temperature) = request.temperature {
        payload["temperature"] = json!(temperature);
    }

    payload
}

async fn call_minimax(
    request: MinimaxChatRequest,
    api_key: &str,
) -> Result<MinimaxChatResponse, MinimaxError> {
    let endpoint = minimax_endpoint(request.base_url.as_deref());
    let payload = minimax_payload(&request);
    let client = reqwest::Client::new();

    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|_| MinimaxError::Network)?;

    let status = response.status();
    let body = response.text().await.map_err(|_| MinimaxError::Network)?;

    if !status.is_success() {
        return Err(MinimaxError::Http(status));
    }

    let parsed: OpenAiChatResponse =
        serde_json::from_str(&body).map_err(|_| MinimaxError::Parse)?;
    let content = parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone())
        .filter(|value| !value.trim().is_empty())
        .ok_or(MinimaxError::EmptyContent)?;

    Ok(MinimaxChatResponse {
        content,
        model: parsed
            .model
            .unwrap_or_else(|| DEFAULT_MINIMAX_MODEL.to_string()),
        usage: parsed.usage,
    })
}

#[tauri::command]
async fn send_minimax_chat(request: MinimaxChatRequest) -> Result<MinimaxChatResponse, String> {
    let api_key = std::env::var("MINIMAX_API_KEY")
        .map_err(|_| MinimaxError::MissingApiKey.public_message())?;
    call_minimax(request, &api_key)
        .await
        .map_err(|error| error.public_message())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![send_minimax_chat])
        .run(tauri::generate_context!())
        .expect("error while running Zeus");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_uses_minimax_v1_chat_completions_by_default() {
        assert_eq!(
            minimax_endpoint(None),
            "https://api.minimax.io/v1/chat/completions"
        );
    }

    #[test]
    fn endpoint_normalizes_custom_base_url() {
        assert_eq!(
            minimax_endpoint(Some("https://api.minimax.io/v1/")),
            "https://api.minimax.io/v1/chat/completions"
        );
    }

    #[test]
    fn payload_defaults_to_minimax_m3_with_adaptive_thinking() {
        let request = MinimaxChatRequest {
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "Build a test".to_string(),
            }],
            model: None,
            base_url: None,
            temperature: None,
        };

        let payload = minimax_payload(&request);

        assert_eq!(payload["model"], "MiniMax-M3");
        assert_eq!(payload["thinking"]["type"], "adaptive");
        assert_eq!(payload["messages"][0]["content"], "Build a test");
    }
}
