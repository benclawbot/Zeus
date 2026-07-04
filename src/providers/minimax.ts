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

  return invoke<MinimaxChatResponse>("send_minimax_chat", { request: options });
}
