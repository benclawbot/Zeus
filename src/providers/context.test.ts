import { describe, expect, it } from "vitest";
import { buildContextMessages, chatEntryToProviderMessage, type UiChatBubble } from "./context";

function bubble(id: number, role: "user" | "zeus", text: string, extra: Partial<UiChatBubble> = {}): UiChatBubble {
  return { id, role, text, ...extra };
}

describe("chatEntryToProviderMessage", () => {
  it("maps user bubbles to user messages", () => {
    expect(chatEntryToProviderMessage(bubble(1, "user", "hi"))).toEqual({ role: "user", content: "hi" });
  });

  it("maps zeus bubbles to assistant messages", () => {
    expect(chatEntryToProviderMessage(bubble(2, "zeus", "hello there"))).toEqual({ role: "assistant", content: "hello there" });
  });

  it("drops thinking placeholders so the LLM never sees empty turns", () => {
    expect(chatEntryToProviderMessage(bubble(3, "zeus", "", { thinking: true }))).toBeNull();
  });

  it("preserves the skillId field but doesn't emit it (skill body is injected server-side)", () => {
    // The mapping intentionally ignores skillId — Rust injects the body
    // when request.skillId is set, so we never need to round-trip it.
    expect(chatEntryToProviderMessage(bubble(4, "user", "with skill", { skillId: "frontend-dev" })))
      .toEqual({ role: "user", content: "with skill" });
  });
});

describe("buildContextMessages", () => {
  it("returns an empty array for an empty chat", () => {
    expect(buildContextMessages([], null)).toEqual([]);
  });

  it("sends the full chat when no compact has been applied", () => {
    const chat = [
      bubble(1, "user", "first"),
      bubble(2, "zeus", "answer one"),
      bubble(3, "user", "second"),
      bubble(4, "zeus", "answer two"),
    ];
    expect(buildContextMessages(chat, null)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer two" },
    ]);
  });

  it("drops entries whose id is below compactFromId", () => {
    // Simulate /compact: keep the last 2 turns. compactFromId points at
    // the first kept entry's id; the dropped turns should never re-enter
    // the LLM's context window.
    const chat = [
      bubble(1, "user", "old question"),
      bubble(2, "zeus", "old answer"),
      bubble(3, "user", "kept question"),
      bubble(4, "zeus", "kept answer"),
    ];
    expect(buildContextMessages(chat, 3)).toEqual([
      { role: "user", content: "kept question" },
      { role: "assistant", content: "kept answer" },
    ]);
  });

  it("filters out thinking placeholders even when they're within the compact window", () => {
    const chat = [
      bubble(1, "user", "real"),
      bubble(2, "zeus", "", { thinking: true }),
      bubble(3, "zeus", "real reply"),
    ];
    const result = buildContextMessages(chat, null);
    expect(result).toEqual([
      { role: "user", content: "real" },
      { role: "assistant", content: "real reply" },
    ]);
    // The thinking bubble must never appear as an assistant message with
    // empty content — that's the exact regression we're guarding against.
    expect(result.some((msg) => msg.content === "")).toBe(false);
  });
});