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
}

/**
 * Returns which providers have a configured API key. The actual values
 * are NEVER returned to the frontend (security: never round-trip
 * secrets through the IPC bridge). The frontend uses this to render
 * the Settings panel and to know whether the chat should be enabled.
 */
export async function getProviderKeys(): Promise<ProviderKeysStatus> {
  if (!isTauriRuntime()) {
    return { minimax: false, openai: false, anthropic: false };
  }
  return invoke<ProviderKeysStatus>("get_provider_keys");
}

/**
 * Save / update provider API keys. Empty strings clear the key. After
 * this call returns, the next `send_chat` invocation will see the new
 * keys in the process environment.
 */
export async function setProviderKeys(keys: { minimax?: string; openai?: string; anthropic?: string }): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("set_provider_keys", { request: keys });
}