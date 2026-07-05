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