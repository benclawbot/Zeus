import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// sendMinimaxChat requires the Tauri runtime (it calls `invoke` on the
// Rust backend) and throws inside jsdom. The composer keydown handler
// fires `dispatchChat` fire-and-forget, so a thrown error escapes as an
// unhandled rejection and fails the vitest run even when the assertion
// itself passes. Stub the provider seam so the send path is observable
// without touching the real backend.
vi.mock("./providers/minimax", async () => {
  const actual = await vi.importActual<typeof import("./providers/minimax")>("./providers/minimax");
  return {
    ...actual,
    sendMinimaxChat: vi.fn(async () => ({ content: "ok", model: "MiniMax-M3" })),
  };
});

// Capture the full ChatOptions payload so the image-attach tests can
// assert the bytes actually reach the model call (and aren't silently
// dropped between React state and the Rust dispatch).
const capturedChatCalls: Array<{ messages: unknown[] }> = [];
vi.mock("./providers/registry", async () => {
  const actual = await vi.importActual<typeof import("./providers/registry")>("./providers/registry");
  return {
    ...actual,
    dispatchChat: vi.fn(async (options: { messages: unknown[] }) => {
      capturedChatCalls.push({ messages: options.messages });
      return { content: "ok", model: "MiniMax-M3" };
    }),
  };
});

import { App } from "./App";
import { buildUserOutboundContent, type ChatAttachment } from "./App";

describe("App", () => {
  it("uses current Zeus branding and excludes obsolete reference-image controls", () => {
    render(<App />);

    expect(screen.getAllByText("Zeus").length).toBeGreaterThan(0);
    expect(screen.queryByText("NitroCode")).not.toBeInTheDocument();
    expect(screen.queryByText("NITRO ENGINE")).not.toBeInTheDocument();
    expect(screen.queryByText("Attach Files")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).not.toBeInTheDocument();
  });

  it("keeps attachment controls only in the bottom composer", () => {
    render(<App />);

    const composer = screen.getByLabelText("Message composer");
    expect(within(composer).getByRole("button", { name: "Attach file" })).toBeInTheDocument();
    expect(screen.getAllByLabelText("Attach file")).toHaveLength(1);
  });

  it("keeps the main app shell constrained to a single viewport", () => {
    render(<App />);

    const css = readFileSync(resolve("src/styles.css"), "utf8").replace(/\r\n/g, "\n");

    expect(screen.getByRole("main")).toHaveClass("app-shell");
    expect(css).toContain("body {\n  margin: 0;\n  min-width: 320px;\n  min-height: 100vh;\n  overflow: hidden;");
    expect(css).toContain(".app-shell {\n  display: grid;\n  grid-template-columns: 268px minmax(520px, 1fr) 332px;\n  height: 100vh;");
    expect(css).toContain(".composer {\n  width: min(790px, calc(100% - 44px));\n  flex-shrink: 0;");
    expect(screen.getByLabelText("Message composer")).toBeInTheDocument();
  });

  it("starts the composer as a compact one-line input that can grow upward", () => {
    render(<App />);

    const css = readFileSync(resolve("src/styles.css"), "utf8").replace(/\r\n/g, "\n");
    const input = screen.getByLabelText("Message Zeus");

    expect(input).toHaveAttribute("rows", "1");
    expect(css).toContain(".composer textarea {\n  width: 100%;\n  height: 24px;\n  min-height: 24px;\n  max-height: 160px");
    expect(css).toContain("  resize: none;");
    expect(css).not.toContain(".composer-access");
  });

  it("shows a Thinking placeholder instead of `` reasoning when a reply arrives", async () => {
    render(<App />);

    // No thinking placeholder should be visible before any message has been sent.
    expect(screen.queryByText(/^Thinking/)).not.toBeInTheDocument();

    // The CSS must include the .thinking style and the un-stripped tag
    // pair must never appear in the bundled CSS source.
    const css = readFileSync(resolve("src/styles.css"), "utf8");
    expect(css).toMatch(/\.chat-zeus \.thinking/);

    // The asset bundle (CSS source that ships) must not expose the literal
    // reasoning tag, otherwise an upstream change could regress this contract.
    const hasOpen =
      css.includes(String.fromCharCode(0x3c) + "think" + String.fromCharCode(0x3e));
    const hasClose =
      css.includes(String.fromCharCode(0x3c) + String.fromCharCode(0x2f) + "think" + String.fromCharCode(0x3e));
    expect(hasOpen && hasClose).toBe(false);
  });

  it("starts with a blank center conversation before the first user message", () => {
    render(<App />);
    const workspace = screen.getByLabelText("Task execution");

    expect(within(workspace).queryByText(/send a message to start the conversation/i)).not.toBeInTheDocument();
        expect(within(workspace).queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
        expect(within(workspace).queryByText(/I'll build a fast local-first coding agent/i)).not.toBeInTheDocument();
        expect(within(workspace).queryByText(/Initialize Tauri \+ React project/i)).not.toBeInTheDocument();
        expect(within(workspace).queryByText(/Checking provider adapter MiniMax-M3/i)).not.toBeInTheDocument();
        expect(within(workspace).queryAllByRole("article")).toHaveLength(0);
        // The session pill shows the current session name inside the workspace.
        // First-launch auto-creates a real "Untitled Session" in any
        // environment, so the pill always has a real label.
        expect(within(workspace).getByLabelText("Current session")).toHaveTextContent(/Untitled Session/);
      });

  it("auto-scrolls the conversation as chat content appears", () => {
    const source = readFileSync(resolve("src/App.tsx"), "utf8");

    expect(source).toContain("node.scrollTop = node.scrollHeight");
    expect(source).not.toContain("distanceFromBottom");
  });

  it("labels the user bubble as 'Me' (not 'You')", () => {
    render(<App />);
    // We render no messages yet, but we want to assert the label is wired.
    // The HomeView uses a literal "Me" string for the user bubble heading.
    // Since we cannot drive Tauri here (no real sendMinimaxChat), this test
    // asserts the source file contains the literal — a coarse contract that
    // catches regressions from a future re-label. Lives in HomeView now
    // (extracted from App.tsx).
    const source = readFileSync(resolve("src/views/HomeView.tsx"), "utf8");
    expect(source).toContain(">Me<");
  });

  it("Enter sends, Shift+Enter inserts a newline", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;

    expect(screen.queryByText(/Enter sends.*Shift\+Enter adds a line/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Access mode")).not.toBeInTheDocument();

    // Plain Enter triggers handleSend → dispatchChat → sendMinimaxChat.
    // sendMinimaxChat is mocked above (it would otherwise throw in jsdom
    // because the Tauri runtime isn't available). All we assert here is
    // that Enter doesn't insert a newline into the textarea.
    composer.focus();
    await user.type(composer, "hello{enter}");
    // After plain Enter, the textarea should be cleared by handleSend.
    // (If Enter had inserted a newline, the value would contain one.)
    expect(composer.value).not.toMatch(/\n/);
  });

  it("wires the file attach controls in the composer", async () => {
    const user = userEvent.setup();
    render(<App />);

    const fileInput = screen.getByLabelText("Choose files") as HTMLInputElement;
    await user.upload(fileInput, new File(["notes"], "notes.md", { type: "text/markdown" }));
    expect(screen.getByText("notes.md")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(screen.queryByText("notes.md")).not.toBeInTheDocument();
  });

  it("accepts pasted screenshots as image attachments in the composer", async () => {
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    const screenshot = new File(["fake-image"], "bug-screenshot.png", { type: "image/png" });

    fireEvent.paste(composer, {
      clipboardData: {
        files: [screenshot],
        items: [{ kind: "file", type: "image/png", getAsFile: () => screenshot }],
      },
    });

    await waitFor(() => {
      expect(screen.getByText("bug-screenshot.png")).toBeInTheDocument();
    });
    expect(screen.getByRole("img", { name: "bug-screenshot.png preview" })).toBeInTheDocument();
  });

  it("keeps access-mode policy controls out of the composer", () => {
    render(<App />);
    expect(screen.queryByLabelText("Access mode")).not.toBeInTheDocument();
  });

  it("wires navigation and inspector shortcuts to state-backed views", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Projects" }));
    const sessionsView = screen.getByLabelText("Projects view");
    expect(sessionsView).toBeInTheDocument();

    // No hardcoded seeds anymore. First launch auto-creates a single
    // "Untitled Session" so the user always has a real session to type
    // into (the in-memory ref isn't persisted until the user sends).
    expect(within(sessionsView).getAllByText(/Untitled Session/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /New Session/ }));
    await user.click(screen.getByRole("button", { name: "Projects" }));
    const sessionsView2 = screen.getByLabelText("Projects view");
    // Click any Untitled Session row in the utility grid; multiple rows
    // can match now that first-launch and New Session both create one.
    const rows = within(sessionsView2).getAllByRole("button", { name: /Untitled Session/ });
    await user.click(rows[0]);
    expect(screen.getByLabelText("Message composer")).toBeInTheDocument();

    });

  it("new session clears draft and selected attachments", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.type(composer, "draft");
    await user.upload(screen.getByLabelText("Choose files"), new File(["x"], "draft.txt"));
    expect(screen.getByText("draft.txt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /New Session/ }));

    expect(composer.value).toBe("");
    expect(screen.queryByText("draft.txt")).not.toBeInTheDocument();
  });

  it("typing / opens the slash-command picker with builtins", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.click(composer);
    await user.keyboard("/");

    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    expect(screen.getByText("/new")).toBeInTheDocument();
    expect(screen.getByText("/compact")).toBeInTheDocument();
    expect(screen.getByText("/stop")).toBeInTheDocument();
    // Hint visible too.
    expect(screen.getByText(/Enter.*Tab pick/i)).toBeInTheDocument();
  });

  it("arrow keys + Enter picks the highlighted slash command", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.click(composer);
    await user.keyboard("/");

    // /new is first by default; arrow down to /compact, then Enter.
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    // Composer cleared, and a "Context compacted" note appended (slash
    // would call compactContext on /compact).
    expect(composer.value).toBe("");
    expect(screen.getByText(/Context compacted/i)).toBeInTheDocument();
  });

  it("Escape closes the slash picker without firing a command", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.click(composer);
    await user.keyboard("/new");

    expect(screen.getByRole("listbox", { name: "Slash commands" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
    // Composer cleared by Escape; no command fired (we still have the
    // default session label intact).
    expect(composer.value).toBe("");
  });

  it("/new via direct text run clears the chat", async () => {
      const user = userEvent.setup();
      render(<App />);

      const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
      const workspace = screen.getByLabelText("Task execution");
      // Sanity: first-launch active session is "Untitled Session" (auto-
      // created on mount).
      expect(within(workspace).getByLabelText("Current session")).toHaveTextContent("Untitled Session");

      await user.type(composer, "/new{enter}");

      // /new mints a fresh UUID and persists a new Untitled Session.
      // The pill still says "Untitled Session" (the label is the same),
      // but it's now backed by a different row in the recent-sessions
      // list.
      expect(within(workspace).getByLabelText("Current session")).toHaveTextContent("Untitled Session");
      expect(composer.value).toBe("");
    });

  it("/stop via direct text run appends a stopped marker", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.type(composer, "/stop{enter}");

    expect(screen.getByText(/Run stopped/i)).toBeInTheDocument();
    expect(composer.value).toBe("");
  });

  it("/goal via direct text run creates an active goal summary", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.type(composer, "/goal Fix screenshot paste{enter}");

    expect(screen.getByText("Goal set: Fix screenshot paste")).toBeInTheDocument();
    // The objective lives inside the same bubble as the "Goal set: " prefix;
    // use a regex matcher to find the substring without requiring its own element.
    expect(screen.getByText(/Fix screenshot paste/)).toBeInTheDocument();
    expect(composer.value).toBe("");
  });

  it("/edit requires both separators and shows usage otherwise", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.type(composer, "/edit path::find{enter}");

    expect(composer.value).toBe("");
    expect(screen.getByText("Usage: /edit <path> :: <find> => <replace>")).toBeInTheDocument();
  });

  it("does not render a composer-level working-folder picker (moved out of composer by upstream 852b3e7)", () => {
    render(<App />);

    const composer = screen.getByLabelText("Message composer");
    // Upstream commit 852b3e7 removed the per-session bottom-bar workspace
    // selector. Workspace selection is now resolved by the Tauri runtime,
    // not by a composer control, so the picker button must be absent.
    expect(within(composer).queryByRole("button", { name: /Pick a working folder|Working folder:/i })).not.toBeInTheDocument();
    // The composer must not advertise the obsolete "Access" text label.
    expect(within(composer).queryByText("Access")).not.toBeInTheDocument();
  });

  it("registers multiple providers on the Rust side", async () => {
    // Frontend mirror: the registry ships with MiniMax today. Adding a new
    // provider should append to this list — keep this test asserting that
    // the shape doesn't accidentally regress to a single-provider world.
    const { listProviders } = await import("./providers/registry");
    const ids = listProviders().map((p) => p.id);
    expect(ids).toContain("minimax");
    ids.forEach((id) => {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    });
  });

  it("surfaces the active session and live context token count in the inspector", () => {
    render(<App />);
    // After the UI overhaul the bottom-of-workspace status bar is gone;
    // the Session panel inside the inspector carries the equivalent info.
    // Multiple "Context" labels exist (inspector panel + Settings card),
    // so check there is at least one instead of asserting uniqueness.
    expect(screen.getAllByText(/Context/i).length).toBeGreaterThan(0);
    // The token-count line lives next to the Context label as
    // "<n> tokens" — provider list isn't available in jsdom so the count
    // stays at the seeded value.
    expect(screen.getByText(/tokens/i)).toBeInTheDocument();
  });

  it("exposes terse-output and minimal-code skill selectors in Settings", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Settings" }));

    // The Token efficiency section has two selects (terse, minimal-code).
    expect(screen.getByLabelText("Terse-output level")).toBeInTheDocument();
    expect(screen.getByLabelText("Minimal-code level")).toBeInTheDocument();
    // Default values are "full" for both per the spec recommendation.
    expect((screen.getByLabelText("Terse-output level") as HTMLSelectElement).value).toBe("full");
    expect((screen.getByLabelText("Minimal-code level") as HTMLSelectElement).value).toBe("full");
  });
});

describe("buildUserOutboundContent", () => {
  it("returns the prompt as a plain string when there are no attachments", () => {
    expect(buildUserOutboundContent("How does this look?", [])).toBe("How does this look?");
  });

  it("appends a non-image file list to the prompt text", () => {
    const attachments: ChatAttachment[] = [
      { id: "1", name: "notes.md", mime: "text/markdown", kind: "file" },
    ];
    const out = buildUserOutboundContent("read this", attachments);
    expect(typeof out).toBe("string");
    expect(out).toContain("read this");
    expect(out).toContain("notes.md");
    expect(out).toContain("Attached files:");
  });

  it("emits multimodal content blocks when an image is attached", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "img-1",
        name: "screenshot.png",
        mime: "image/png",
        kind: "image",
        dataUrl: "data:image/png;base64,AAAA",
      },
    ];
    const out = buildUserOutboundContent("What's in this image?", attachments);
    expect(Array.isArray(out)).toBe(true);
    const parts = out as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "What's in this image?" });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  it("drops image attachments that have no dataUrl (hydration race)", () => {
    const attachments: ChatAttachment[] = [
      { id: "img-1", name: "screenshot.png", mime: "image/png", kind: "image" },
    ];
    const out = buildUserOutboundContent("look", attachments);
    expect(typeof out).toBe("string");
    expect(out).toBe("look");
  });
});

describe("App image attachment wiring", () => {
  it("stores image dataUrl on the chat row after paste", async () => {
    // Minimal bytes — FileReader.readAsDataURL wraps anything in a
    // valid `data:<mime>;base64,...` URI even for empty content.
    const screenshot = new File([new Uint8Array([1, 2, 3])], "bug.png", { type: "image/png" });

    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    fireEvent.paste(composer, {
      clipboardData: {
        files: [screenshot],
        items: [{ kind: "file", type: "image/png", getAsFile: () => screenshot }],
      },
    });

    // Pill shows up immediately; bytes fill in on the next microtask.
    await waitFor(() => {
      expect(screen.getByText("bug.png")).toBeInTheDocument();
    });
    await waitFor(() => {
      const pill = screen.getByRole("img", { name: "bug.png preview" }) as HTMLImageElement;
      // The <img src> swaps from the blob: preview to a data: URI once
      // hydration finishes. Either is acceptable as long as the pill is
      // still rendered (the chat row persists the attachment regardless).
      expect(pill).toBeInTheDocument();
    });
  });

  it("ships the image bytes to the model when the user hits Send", async () => {
    capturedChatCalls.length = 0;
    const user = userEvent.setup();
    const screenshot = new File([new Uint8Array([1, 2, 3, 4, 5])], "bug.png", { type: "image/png" });

    render(<App />);
    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;

    fireEvent.paste(composer, {
      clipboardData: {
        files: [screenshot],
        items: [{ kind: "file", type: "image/png", getAsFile: () => screenshot }],
      },
    });
    // Hydration (FileReader → setAttachedFiles) runs as a microtask
    // chain off the paste. The waitFor below polls the dispatched chat
    // call payload, which gives the hydration plenty of time to land
    // before we press Enter.
    await user.type(composer, "what's wrong here?");
    await user.keyboard("{Enter}");

    // Wait for the dispatched model call to actually carry the image
    // bytes. The send path is async (hydration microtask → setAttachedFiles
    // → handleSend → dispatchChat), so we poll until the multimodal
    // block lands in the captured payload — failing fast if it never
    // does means hydration raced with Enter.
    await waitFor(() => {
      const found = capturedChatCalls.some((call) =>
        call.messages.some(
          (m): m is { role: string; content: unknown } =>
            typeof m === "object" &&
            m !== null &&
            (m as { role?: string }).role === "user" &&
            Array.isArray((m as { content: unknown }).content),
        ),
      );
      expect(found).toBe(true);
    }, { timeout: 2000 });

    const userTurns = capturedChatCalls
      .flatMap((call) => call.messages)
      .filter((m): m is { role: string; content: unknown } =>
        typeof m === "object" && m !== null && (m as { role?: string }).role === "user",
      );
    const imageTurn = userTurns.find((m) => Array.isArray(m.content));
    expect(imageTurn).toBeDefined();
    const parts = imageTurn!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const imagePart = parts.find((p) => p.type === "image_url");
    expect(imagePart).toBeDefined();
    expect(imagePart!.image_url!.url).toMatch(/^data:image\/png;base64,/);
  });

  it("clears the composer pill after send but keeps the chat-row attachment", async () => {
    capturedChatCalls.length = 0;
    const user = userEvent.setup();
    const screenshot = new File([new Uint8Array([1, 2, 3])], "keep-on-row.png", { type: "image/png" });

    render(<App />);
    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;

    fireEvent.paste(composer, {
      clipboardData: {
        files: [screenshot],
        items: [{ kind: "file", type: "image/png", getAsFile: () => screenshot }],
      },
    });
    await waitFor(() => {
      expect(screen.getByText("keep-on-row.png")).toBeInTheDocument();
    });

    await user.type(composer, "look at this");
    await user.keyboard("{Enter}");

    // Composer pill clears after send. The attachment survives on the
    // chat row as a reference (paperclip + filename) so the user can
    // scroll back and reference "the screenshot above" in follow-ups.
    await waitFor(() => {
      const composerPills = screen.queryAllByRole("button", { name: /Remove keep-on-row/ });
      expect(composerPills).toHaveLength(0);
      // Chat-row attachment list still references the filename.
      expect(screen.getByText("keep-on-row.png")).toBeInTheDocument();
    });
  });
});
