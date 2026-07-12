/**
 * UI-side chat bubble shape. Mirrors `App.tsx`'s internal `ChatMessage`
 * interface so this module stays decoupled from the App component.
 */
export interface UiChatBubble {
  id: number;
  role: "user" | "zeus";
  text: string;
  thinking?: boolean;
  skillId?: string;
}

export interface CompactedChatHistory {
  entries: UiChatBubble[];
  compactFromId: number | null;
  droppedCount: number;
}

/** Keep the newest completed messages plus any in-flight placeholder. */
export function compactChatHistory(chat: UiChatBubble[], keepLast: number): CompactedChatHistory {
  const completed = chat.filter((entry) => entry.thinking !== true);
  const keptCompleted = completed.slice(-Math.max(0, keepLast));
  const keptIds = new Set(keptCompleted.map((entry) => entry.id));
  const entries = chat.filter((entry) => entry.thinking === true || keptIds.has(entry.id));
  return {
    entries,
    compactFromId: keptCompleted[0]?.id ?? null,
    droppedCount: completed.length - keptCompleted.length,
  };
}

/**
 * Map a frontend chat entry into the shape the LLM provider expects.
 * - `zeus` becomes `assistant` (it's the model speaking).
 * - `user` stays `user`.
 * - thinking placeholders are skipped — they were a UI artifact, not real
 *   content, so we don't pollute the LLM's context with empty turns.
 * - skill chips on user bubbles are dropped; the skill body is injected
 *   server-side from `request.skillId`.
 */
export function chatEntryToProviderMessage(entry: UiChatBubble): { role: "user" | "assistant"; content: string } | null {
  if (entry.thinking) return null;
  if (entry.role === "user") return { role: "user", content: entry.text };
  return { role: "assistant", content: entry.text };
}

/**
 * Build the message array to send to the LLM for this turn. Walks the
 * existing chat (filtering to entries whose id >= compactFromId) and turns
 * each kept entry into an OpenAI-compatible message. Excludes thinking
 * placeholders and skill chips. Pure so it's trivially unit-testable.
 *
 * `compactFromId === null` means "no compact applied yet" — send the
 * full chat history.
 */
export function buildContextMessages(chat: UiChatBubble[], compactFromId: number | null): { role: "user" | "assistant"; content: string }[] {
  return chat
    .filter((entry) => compactFromId === null || entry.id >= compactFromId)
    .map(chatEntryToProviderMessage)
    .filter((msg): msg is { role: "user" | "assistant"; content: string } => msg !== null);
}
