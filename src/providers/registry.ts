import { sendMinimaxChat } from "./minimax";

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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: unknown;
}

/**
 * Single entry point for every chat call. Adds the provider id to the
 * options bag, then delegates to the active provider's `chat` function.
 */
export async function dispatchChat(options: ChatOptions): Promise<ChatResponse> {
  const provider = findProvider(options.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${options.provider}`);
  }
  return provider.chat({
    messages: options.messages,
    skillId: options.skillId,
    model: options.model ?? provider.defaultModel,
    baseUrl: options.baseUrl,
    temperature: options.temperature,
  });
}

/**
 * Look up a registered provider by id.
 */
export function findProvider(id: string): ProviderClient | undefined {
  return registry.find((provider) => provider.id === id);
}

/**
 * Built-in provider registry. Adding a new provider = appending an entry
 * here and (if its protocol differs from OpenAI completions) wiring a
 * separate `chat` function. See `src/providers/minimax.ts` for an example.
 */
const registry: ProviderClient[] = [
  {
    id: "minimax",
    displayName: "MiniMax",
    defaultModel: "MiniMax-M3",
    chat: sendMinimaxChat,
  },
];

export function listProviders(): ProviderClient[] {
  return registry.slice();
}