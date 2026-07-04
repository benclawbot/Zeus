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
    expect(screen.getByText(/approved ·/i)).toBeInTheDocument();
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
    expect(css).toContain(".composer textarea {\n  width: 100%;\n  height: 24px;\n  min-height: 24px;\n  max-height: 160px;");
  });
});
