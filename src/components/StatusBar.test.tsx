import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  it("renders the active model id", () => {
    render(<StatusBar modelId="gpt-4o" providerId="openai" promptTokens={0} />);
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
  });

  it("renders the context window for the active model", () => {
    render(<StatusBar modelId="gpt-4o" providerId="openai" promptTokens={0} />);
    // 128K window for gpt-4o.
    expect(screen.getByText(/128K/)).toBeInTheDocument();
  });

  it("renders the percentage as 0.0% for an empty prompt", () => {
    render(<StatusBar modelId="gpt-4o" providerId="openai" promptTokens={0} />);
    expect(screen.getByText("0.0%")).toBeInTheDocument();
  });

  it("renders the auto-compact threshold", () => {
    render(<StatusBar modelId="gpt-4o" providerId="openai" promptTokens={0} />);
    // 40% default threshold.
    expect(screen.getByText(/≥ 40%/)).toBeInTheDocument();
  });

  it("uses the default 32K window for unknown models", () => {
    render(<StatusBar modelId="totally-unknown" providerId="openai" promptTokens={0} />);
    // Default window is 32K.
    expect(screen.getByText(/32K/)).toBeInTheDocument();
  });

  it("applies the green band when well under threshold", () => {
    render(<StatusBar modelId="gpt-4o" providerId="openai" promptTokens={100} />);
    const band = document.querySelector(".status-bar-band.green");
    expect(band).not.toBeNull();
  });

  it("applies the red band when over the threshold", () => {
    // 60K tokens of 128K = 46.9%, over 40%.
    render(<StatusBar modelId="gpt-4o" providerId="openai" promptTokens={60_000} />);
    const band = document.querySelector(".status-bar-band.red");
    expect(band).not.toBeNull();
  });

  it("does not claim an actual over-target turn is currently compacting", () => {
    render(<StatusBar modelId="gpt-4o" providerId="openai" promptTokens={100} actualPromptTokens={60_000} />);
    expect(screen.getByText("over target")).toBeInTheDocument();
    expect(screen.queryByText("compacting")).not.toBeInTheDocument();
  });

  it("applies the amber band at 75% of the threshold", () => {
    // 30K / 128K = 23.4% — green
    // 40K / 128K = 31.3% — amber (75% of 40% = 30%)
    render(<StatusBar modelId="gpt-4o" providerId="openai" promptTokens={40_000} />);
    const band = document.querySelector(".status-bar-band.amber");
    expect(band).not.toBeNull();
  });

  it("renders the settings button when handler provided", () => {
    render(
      <StatusBar
        modelId="gpt-4o"
        providerId="openai"
        promptTokens={0}
        onOpenSettings={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Open settings")).toBeInTheDocument();
  });
});
