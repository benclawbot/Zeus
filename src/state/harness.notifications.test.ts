import { describe, expect, it } from "vitest";
import type { HarnessProposal } from "./harness";
import { countPendingProposals } from "./harness.notifications";

function proposal(overrides: Partial<HarnessProposal> = {}): HarnessProposal {
  return {
    id: "p-1",
    title: "Test proposal",
    summary: "Summary",
    body: "Body",
    status: "ready",
    ...overrides,
  };
}

describe("countPendingProposals", () => {
  it("returns 0 when there is no proposal", () => {
    expect(countPendingProposals(null, false)).toBe(0);
  });

  it("returns 1 when the current proposal is in a pending state", () => {
    expect(countPendingProposals(proposal({ status: "ready" }), false)).toBe(1);
    expect(countPendingProposals(proposal({ status: "edited" }), false)).toBe(1);
  });

  it("returns 0 when the current proposal has been decided", () => {
    expect(countPendingProposals(proposal({ status: "approved" }), false)).toBe(0);
    expect(countPendingProposals(proposal({ status: "applied" }), false)).toBe(0);
    expect(countPendingProposals(proposal({ status: "failed" }), false)).toBe(0);
    expect(countPendingProposals(proposal({ status: "rejected" }), false)).toBe(0);
    expect(countPendingProposals(proposal({ status: "implementing" }), false)).toBe(0);
  });

  it("returns 0 when the menu view is open even for a pending proposal", () => {
    expect(countPendingProposals(proposal({ status: "ready" }), true)).toBe(0);
  });
});