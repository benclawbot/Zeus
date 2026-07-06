import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

export interface ProviderInfo {
  id: string;
  displayName: string;
  defaultModel: string;
}

/**
 * List every registered provider. The Memory panel and (eventually) a
 * provider picker consume this. Frontend mirror of the Rust
 * `list_provider_info` helper.
 */
export async function listProviders(): Promise<ProviderInfo[]> {
  if (!isTauriRuntime()) {
    // In the browser (dev env) return the same shape Rust would, so the
    // Memory panel still shows meaningful state.
    return [{ id: "minimax", displayName: "MiniMax", defaultModel: "MiniMax-M3" }];
  }
  const rows = await invoke<ProviderInfo[]>("list_providers");
  return rows;
}

/**
 * Persist the chosen access mode to SQLite so the selection survives a
 * relaunch. Mirrors the Rust `set_access_mode` command. Failures are
 * non-fatal — the in-memory state is the source of truth for the
 * current session.
 */
export async function setAccessMode(mode: string): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("set_access_mode", { mode });
}

export interface ProviderKeysStatus {
  minimax: boolean;
  openai: boolean;
  anthropic: boolean;
  /** Per-provider base URL override (or null when unset). */
  minimaxBaseUrl: string | null;
  openaiBaseUrl: string | null;
  anthropicBaseUrl: string | null;
  /** Per-provider model override (or null when unset). */
  minimaxModel: string | null;
  openaiModel: string | null;
  anthropicModel: string | null;
}

export interface TestProviderResult {
  ok: boolean;
  baseUrl: string;
  model: string;
  message: string;
  preview: string | null;
}

/**
 * Returns which providers have a configured API key plus the saved
 * base URL / model overrides. The actual key values are NEVER returned
 * to the frontend (security: never round-trip secrets through the IPC
 * bridge).
 */
export async function getProviderKeys(): Promise<ProviderKeysStatus> {
  if (!isTauriRuntime()) {
    return {
      minimax: false,
      openai: false,
      anthropic: false,
      minimaxBaseUrl: null,
      openaiBaseUrl: null,
      anthropicBaseUrl: null,
      minimaxModel: null,
      openaiModel: null,
      anthropicModel: null,
    };
  }
  return invoke<ProviderKeysStatus>("get_provider_keys");
}

/**
 * Save / update provider API keys + per-provider base URL / model
 * overrides. Empty strings clear the field. After this call returns, the
 * next `send_chat` invocation will see the new keys in the process env.
 */
export async function setProviderKeys(keys: {
  minimax?: string;
  openai?: string;
  anthropic?: string;
  minimaxBaseUrl?: string;
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  minimaxModel?: string;
  openaiModel?: string;
  anthropicModel?: string;
}): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("set_provider_keys", { request: keys });
}

/**
 * Issue a trivial chat request to verify the configured key + base URL +
 * model work end-to-end. Uses the same Rust dispatcher as the chat UI,
 * so any error the user would see in real usage is surfaced here too.
 */
export async function testProvider(providerId: string, baseUrl?: string, model?: string): Promise<TestProviderResult> {
  if (!isTauriRuntime()) {
    throw new Error("Test connection is only available inside the Zeus desktop runtime.");
  }
  return invoke<TestProviderResult>("test_provider", {
    providerId,
    baseUrl: baseUrl ?? null,
    model: model ?? null,
  });
}