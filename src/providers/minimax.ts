import { invoke } from "@tauri-apps/api/core";

export interface MinimaxChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface MinimaxChatOptions {
  messages: MinimaxChatMessage[];
  model?: string;
  baseUrl?: string;
  temperature?: number;
  /**
   * Optional skill id. When set, the Rust side loads the SKILL.md body and
   * prepends it to the system prompt for this turn only.
   */
  skillId?: string;
}

export interface MinimaxChatResponse {
  content: string;
  model: string;
  usage?: unknown;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function sendMinimaxChat(options: MinimaxChatOptions): Promise<MinimaxChatResponse> {
  if (!isTauriRuntime()) {
    throw new Error("MiniMax is available inside the Zeus desktop runtime.");
  }

  return invoke<MinimaxChatResponse>("send_chat", {
    request: {
      provider: "minimax",
      messages: options.messages,
      skillId: options.skillId,
      options: {
        model: options.model,
        baseUrl: options.baseUrl,
        temperature: options.temperature,
      },
    },
  });
}
