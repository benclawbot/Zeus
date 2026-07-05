export type HarnessProposalStatus = "ready" | "approved" | "edited" | "rejected" | "applied-once" | "rolled-back";

export interface HarnessProposal {
  id: string;
  title: string;
  summary: string;
  body: string;
  status: HarnessProposalStatus;
}

export interface HarnessHistoryEntry {
  proposalId: string;
  action: HarnessProposalStatus;
  at: string;
}

export function transitionHarnessProposal(
  proposal: HarnessProposal,
  action: Exclude<HarnessProposalStatus, "ready">,
  at = new Date().toISOString(),
): { proposal: HarnessProposal; historyEntry: HarnessHistoryEntry } {
  return {
    proposal: { ...proposal, status: action },
    historyEntry: { proposalId: proposal.id, action, at },
  };
}
