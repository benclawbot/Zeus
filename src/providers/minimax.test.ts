import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { sendMinimaxChat } from "./minimax";

describe("sendMinimaxChat", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ content: "ok", model: "MiniMax-M3" });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("dispatches through the generic send_chat Tauri command", async () => {
    const messages = [{ role: "user" as const, content: "Inspect this screenshot." }];

    await sendMinimaxChat({
      messages,
      skillId: "vision-analysis",
      model: "MiniMax-M3",
      temperature: 0.2,
    });

    expect(invokeMock).toHaveBeenCalledWith("send_chat", {
      request: {
        provider: "minimax",
        messages,
        skillId: "vision-analysis",
        options: {
          model: "MiniMax-M3",
          temperature: 0.2,
        },
      },
    });
  });
});
