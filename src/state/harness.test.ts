import { describe, expect, it } from "vitest";
import { transitionHarnessProposal, type HarnessProposal } from "./harness";

describe("transitionHarnessProposal", () => {
  it("records approval in the proposal and change history", () => {
    const proposal: HarnessProposal = {
      id: "hp-1",
      title: "Run tests before final response",
      summary: "Persist the recurring verification rule.",
      body: "Persist the recurring verification rule.",
      status: "ready",
    };

    const result = transitionHarnessProposal(proposal, "approved", "2026-07-04T12:00:00.000Z");

    expect(result.proposal.status).toBe("approved");
    expect(result.historyEntry).toEqual({
      proposalId: "hp-1",
      action: "approved",
      at: "2026-07-04T12:00:00.000Z",
    });
  });

  it("transitions approved → applied with sessionId stamped on history", () => {
    const proposal: HarnessProposal = {
      id: "hp-1",
      title: "T",
      summary: "S",
      body: "B",
      status: "approved",
    };

    const applied = transitionHarnessProposal(proposal, "applied", "2026-07-06T10:00:00.000Z", "session-42");

    expect(applied.proposal.status).toBe("applied");
    expect(applied.historyEntry).toEqual({
      proposalId: "hp-1",
      action: "applied",
      at: "2026-07-06T10:00:00.000Z",
      sessionId: "session-42",
    });
  });

  it("transitions approved → failed when the run does not complete", () => {
    const proposal: HarnessProposal = {
      id: "hp-1",
      title: "T",
      summary: "S",
      body: "B",
      status: "approved",
    };

    const failed = transitionHarnessProposal(proposal, "failed", "2026-07-06T10:00:00.000Z", "session-42");

    expect(failed.proposal.status).toBe("failed");
    expect(failed.historyEntry.sessionId).toBe("session-42");
  });

  it("omits sessionId from history entry when not supplied", () => {
    const proposal: HarnessProposal = {
      id: "hp-1",
      title: "T",
      summary: "S",
      body: "B",
      status: "ready",
    };

    const rejected = transitionHarnessProposal(proposal, "rejected", "2026-07-06T10:00:00.000Z");

    expect(rejected.historyEntry.sessionId).toBeUndefined();
    expect("sessionId" in rejected.historyEntry).toBe(false);
  });
});

