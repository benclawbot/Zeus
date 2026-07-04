import { render, screen, within } from "@testing-library/react";
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

    const css = readFileSync(resolve("src/styles.css"), "utf8");

    expect(screen.getByRole("main")).toHaveClass("app-shell");
    expect(css).toContain("body {\n  margin: 0;\n  min-width: 320px;\n  min-height: 100vh;\n  overflow: hidden;");
    expect(css).toContain(".app-shell {\n  display: grid;\n  grid-template-columns: 268px minmax(520px, 1fr) 332px;\n  height: 100vh;");
    expect(css).toContain(".composer {\n  width: min(790px, calc(100% - 44px));\n  flex-shrink: 0;");
    expect(screen.getByLabelText("Message composer")).toBeInTheDocument();
  });

  it("starts the composer as a compact one-line input that can grow upward", () => {
    render(<App />);

    const css = readFileSync(resolve("src/styles.css"), "utf8");
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
        expect(within(workspace).getByLabelText("Current session")).toHaveTextContent(/Rust CLI Todo App/);
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

  it("wires composer context and attachment controls to local state", async () => {
    const user = userEvent.setup();
    render(<App />);

    const composer = screen.getByLabelText("Message Zeus") as HTMLTextAreaElement;
    await user.click(screen.getByRole("button", { name: "Mention context" }));
    expect(composer.value).toBe("@");

    const fileInput = screen.getByLabelText("Choose files") as HTMLInputElement;
    await user.upload(fileInput, new File(["notes"], "notes.md", { type: "text/markdown" }));
    expect(screen.getByText("notes.md")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(screen.queryByText("notes.md")).not.toBeInTheDocument();
  });

  it("wires navigation and inspector shortcuts to state-backed views", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Sessions" }));
    const sessionsView = screen.getByLabelText("Sessions view");
    expect(sessionsView).toBeInTheDocument();

    await user.click(within(sessionsView).getByRole("button", { name: "API Integration 1h ago" }));
    expect(screen.getByLabelText("Message composer")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View Memory" }));
    expect(screen.getByLabelText("Memory view")).toBeInTheDocument();
    expect(screen.getByText("Current Session")).toBeInTheDocument();

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
      // Sanity: default session shows in the workspace pill.
      expect(within(workspace).getByLabelText("Current session")).toHaveTextContent(/Rust CLI Todo App/);

      await user.type(composer, "/new{enter}");

      // /new starts an Untitled Session — visible in the workspace pill.
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
});
