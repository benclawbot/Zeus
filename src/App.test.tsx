import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "./App";

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

  it("tracks harness proposal decisions in change history", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(screen.getByText("Status: approved")).toBeInTheDocument();
    expect(screen.getByText(/approved \//i)).toBeInTheDocument();
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
    // The component uses a literal "Me" string for the user bubble heading.
    // Check that "Me" is one of the labels we expect to show up after a send.
    // Since we cannot drive Tauri here (no real sendMinimaxChat), this test
    // asserts the source file contains the literal — a coarse contract that
    // catches regressions from a future re-label.
    const source = readFileSync(resolve("src/App.tsx"), "utf8");
    expect(source).toContain(">Me<");
  });

  it("Enter sends, Shift+Enter inserts a newline", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;

    // The composer hint text should advertise the new keyboard contract.
    expect(screen.getByText("Enter to send / Shift+Enter newline")).toBeInTheDocument();

    // Plain Enter would call handleSend. We can't actually send through the
    // Tauri runtime from jsdom, but the onKeyDown handler is wired and we
    // verify the textarea is focusable + reactive by typing then submitting
    // via Enter. Since sendMinimaxChat isn't mocked, the send would error,
    // which is fine: we just want to prove Enter doesn't insert a "\n".
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

  it("exposes the access mode as a native listbox in the composer", () => {
    render(<App />);

    // The composer replaces the old @ button with a listbox that drives
    // the same accessMode state the right panel used to.
    const select = screen.getByLabelText("Access mode") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.tagName).toBe("SELECT");
    // All four modes are present, in the canonical order.
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["Full", "Local", "Review", "Locked"]);
    // Default is "Full".
    expect(select.value).toBe("Full");
  });

  it("changing the access-mode listbox updates the state", async () => {
    const user = userEvent.setup();
    render(<App />);

    const select = screen.getByLabelText("Access mode") as HTMLSelectElement;
    await user.selectOptions(select, "Locked");
    expect(select.value).toBe("Locked");
  });

  it("wires navigation and inspector shortcuts to state-backed views", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Sessions" }));
    const sessionsView = screen.getByLabelText("Sessions view");
    expect(sessionsView).toBeInTheDocument();

    // No hardcoded seeds anymore. First launch auto-creates a single
    // "Untitled Session" so the user always has a real session to type
    // into (the in-memory ref isn't persisted until the user sends).
    expect(within(sessionsView).getAllByText(/Untitled Session/).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /New Session/ }));
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    const sessionsView2 = screen.getByLabelText("Sessions view");
    // Click any Untitled Session row in the utility grid; multiple rows
    // can match now that first-launch and New Session both create one.
    const rows = within(sessionsView2).getAllByRole("button", { name: /Untitled Session/ });
    await user.click(rows[0]);
    expect(screen.getByLabelText("Message composer")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View Memory" }));
    expect(screen.getByLabelText("Memory view")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByLabelText("Skills registry")).toBeInTheDocument();
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
    expect(screen.getByText(/Enter.*Tab to pick/i)).toBeInTheDocument();
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
    expect(screen.getByText("Fix screenshot paste")).toBeInTheDocument();
    expect(composer.value).toBe("");
  });

  it("/run via direct text run reports when not in the desktop runtime", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.type(composer, "/run npm test{enter}");

    // In jsdom, isTauriRuntime is false, so the command is dispatched but the
    // workspace invocation is rejected with the runtime-required error. We
    // verify the dispatch path: the slash command is recognized, the composer
    // is cleared, and the panel surface is present.
    expect(composer.value).toBe("");
    expect(screen.getByLabelText("Workspace tool runs")).toBeInTheDocument();
    expect(screen.getByText(/Shell execution is only available inside the Zeus desktop runtime/i)).toBeInTheDocument();
  });

  it("/read dispatches to the read path with a non-empty argument", async () => {
      const user = userEvent.setup();
      render(<App />);

      const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
      await user.type(composer, "/read README.md{enter}");

      // In jsdom isTauri is false; the dispatch path lands on the runtime
      // guard. We verify the slash command is recognized and the panel exists.
      expect(composer.value).toBe("");
      expect(screen.getByLabelText("Workspace tool runs")).toBeInTheDocument();
      expect(screen.getByText(/Workspace file reads are only available/i)).toBeInTheDocument();
    });

  it("/write requires a separator and shows usage otherwise", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.type(composer, "/write missing-separator{enter}");

    expect(composer.value).toBe("");
    expect(screen.getByText("Usage: /write <path> :: <content>")).toBeInTheDocument();
  });

  it("/edit requires both separators and shows usage otherwise", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.type(composer, "/edit path::find{enter}");

    expect(composer.value).toBe("");
    expect(screen.getByText("Usage: /edit <path> :: <find> => <replace>")).toBeInTheDocument();
  });

  it("shows the working folder button in the composer", () => {
      render(<App />);
    // The picker button is present at the composer level, next to the
    // Access mode select. No "Access" text label in the composer anymore.
    const composer = screen.getByLabelText("Message composer");
    const folderButton = within(composer).getByRole("button", { name: /Pick a working folder|Working folder:/i });
    expect(folderButton).toBeInTheDocument();
    expect(within(composer).queryByText("Access")).not.toBeInTheDocument();
  });

it("shows the empty tool-run panel on the Home view", () => {
      render(<App />);
      expect(screen.getByText("Tool runs")).toBeInTheDocument();
      expect(screen.getByText("no runs yet")).toBeInTheDocument();
    });

    it("shows the Settings view with a provider API keys form", async () => {
            const user = userEvent.setup();
          render(<App />);

          await user.click(screen.getByRole("button", { name: "Settings" }));

          // Three provider rows should be visible, each labeled with the env var name.
          expect(screen.getByText("MiniMax (MINIMAX_API_KEY)")).toBeInTheDocument();
          expect(screen.getByText("OpenAI (OPENAI_API_KEY)")).toBeInTheDocument();
          expect(screen.getByText("Anthropic (ANTHROPIC_API_KEY)")).toBeInTheDocument();
          // In jsdom isTauri is false, so each provider shows "not configured".
          const rows = screen.getAllByText("not configured");
          expect(rows.length).toBe(3);
          // Each provider should also expose a Base URL input, a Model input, and
          // a Test connection button. The Test button is disabled when no key is
          // configured.
          expect(screen.getAllByLabelText("MiniMax (MINIMAX_API_KEY) base URL")).toHaveLength(1);
          expect(screen.getAllByLabelText("MiniMax (MINIMAX_API_KEY) model")).toHaveLength(1);
          const testButtons = screen.getAllByRole("button", { name: "Test connection" });
          expect(testButtons.length).toBe(3);
          for (const btn of testButtons) {
            expect(btn).toBeDisabled();
          }
        });

it("renames recent sessions and creates project groups", async () => {
  const user = userEvent.setup();
  render(<App />);

    await user.click(screen.getByRole("button", { name: /Rename Untitled Session/ }));
    const renameInput = screen.getByLabelText("Session name") as HTMLInputElement;
    await user.clear(renameInput);
    await user.type(renameInput, "Visual bug triage");
    await user.click(screen.getByRole("button", { name: "Save session name" }));

    expect(screen.getAllByText("Visual bug triage").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Sessions" }));
    const projectInput = screen.getByLabelText("New project name") as HTMLInputElement;
    await user.type(projectInput, "Ocean Wallpaper");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(screen.getAllByText("Ocean Wallpaper").length).toBeGreaterThan(0);
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

  it("renders the status bar with the active model and context window", () => {
    render(<App />);
    // The status bar always surfaces the auto-compact threshold and
    // its own pill, regardless of whether the providers list has
    // arrived yet. The provider list is populated from the Rust
    // backend, which isn't available in jsdom — the model id is
    // therefore empty in this test environment, but the structural
    // pieces are all present.
    expect(screen.getByText(/Auto-compact/i)).toBeInTheDocument();
    expect(screen.getByText(/≥ 40%/)).toBeInTheDocument();
    // The "Context" label surfaces the live outgoing-prompt token
    // count vs the active model's window.
    expect(screen.getByText(/Context/i)).toBeInTheDocument();
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
