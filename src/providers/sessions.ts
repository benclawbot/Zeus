import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

/**
 * One persisted session, including the full chat transcript and the
 * compact anchor that bounds what the LLM sees. Rust is the source of
 * truth here — the frontend only mirrors the state.
 */
export interface PersistedSession {
  id: string;
  label: string;
  lastSeenAt: string;
  /** JSON-serialized array of `ChatMessage` from the frontend. */
  messagesJson: string;
  /** ID of the first chat entry that should be sent to the LLM; null = no compact applied. */
  compactFromId: number | null;
}

export interface SaveSessionArgs {
  id: string;
  label: string;
  messagesJson: string;
  compactFromId: number | null;
}

/**
 * List every persisted session, ordered most-recently-seen first. Used
 * on app mount to populate the recent-sessions list and to restore the
 * previously-active session.
 */
export async function listSessions(): Promise<PersistedSession[]> {
  if (!isTauriRuntime()) {
    return [];
  }
  const rows = await invoke<PersistedSession[]>("list_sessions_full");
  return rows;
}

/**
 * Save (insert or update) a session. Frontend calls this after every
 * assistant reply and after every /compact so the next launch picks up
 * the same state.
 */
export async function saveSession(args: SaveSessionArgs): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  await invoke("save_session", { request: args });
}

/**
 * Mint a session id. Uses the browser's `crypto.randomUUID()` when
 * available (Tauri 2's webview always ships crypto); falls back to a
 * timestamp + random suffix for environments that don't.
 */
export function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}