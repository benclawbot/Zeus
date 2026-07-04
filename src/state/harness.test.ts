import { describe, expect, it } from "vitest";
import { transitionHarnessProposal, type HarnessProposal } from "./harness";

describe("transitionHarnessProposal", () => {
  it("records approval in the proposal and change history", () => {
    const proposal: HarnessProposal = {
      id: "hp-1",
      title: "Run tests before final response",
      summary: "Persist the recurring verification rule.",
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
});
