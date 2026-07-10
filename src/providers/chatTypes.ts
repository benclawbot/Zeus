import type { sendMinimaxChat } from "./minimax";

/**
 * Public type for any chat provider.
 *
 * The `id` is what gets sent to the Rust dispatcher (`send_chat`) and the
 * frontend registry; `displayName` is what the UI renders in the provider
 * picker; `defaultModel` is the model used when the user hasn't picked one.
 * `chat` is the function that actually runs a completion — today every
 * provider's `chat` is just a thin wrapper around the same `send_chat` Tauri
 * command, but in the future providers may diverge (different auth flows,
 * streaming, etc.) and this is the seam.
 */
export interface ProviderClient {
  id: string;
  displayName: string;
  defaultModel: string;
  chat: typeof sendMinimaxChat;
}

/**
 * One part of a multimodal user message. Mirrors the OpenAI / Anthropic
 * shapes (text + image_url). Provider adapters own the final wire format;
 * this is the cross-provider shape the chat loop builds.
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export type ChatContent = string | ChatContentPart[];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: ChatContent;
}

/** Pull the textual portion of a multimodal message. Returns "" if the
 *  message only carries image parts; callers that need a string (token
 *  estimator, lastUserMessage) can fall back on the joined text. */
export function textFromContent(content: ChatContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export interface ChatOptions {
  provider: string;
  messages: ChatMessage[];
  /** Optional skill id. When set, the skill body is loaded and injected server-side. */
  skillId?: string;
  /** Optional model override. Falls back to the provider's default. */
  model?: string;
  /**
   * Optional API base URL override. Falls back to the provider's default
   * (e.g. https://api.minimax.io/v1 for MiniMax). Set this from the
   * Settings panel to point at a self-hosted proxy or a regional host.
   */
  baseUrl?: string;
  /** Optional temperature override. Provider-specific support. */
  temperature?: number;
  /** Runtime session that owns native tool observations and approvals. */
  sessionId?: string;
  /** Human objective used to label native tool execution. */
  objective?: string;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: unknown;
}
