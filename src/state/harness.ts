export type HarnessProposalStatus =
  // Pre-decision states (counted in notification badge).
  | "ready"
  | "edited"
  // User actions.
  | "approved"        // user picked Apply on the harness card
  | "rejected"        // user picked Discard on the harness card
  // Lifecycle of the implementing session.
  | "implementing"    // session created, composer pre-filled with proposal body
  | "applied"         // implementing session reached a successful final reply
  | "failed"          // implementing session ended without success
  // Legacy / one-shot states preserved for history entries imported from older sessions.
  | "applied-once"
  | "rolled-back";

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
  /** Set when the action created or referred to a chat session
   *  (e.g. "approved" → implementing session, "applied" → completed session). */
  sessionId?: string;
}

/**
 * Apply a status transition. Returns the updated proposal plus a history
 * entry stamped at `at`. Prefer this over mutating the proposal directly
 * so callers cannot forget the history entry.
 *
 * `sessionId` is stamped on the history entry only when supplied;
 * callers that have a session to link should pass it explicitly.
 */
export function transitionHarnessProposal(
  proposal: HarnessProposal,
  action: HarnessProposalStatus,
  at = new Date().toISOString(),
  sessionId?: string,
): { proposal: HarnessProposal; historyEntry: HarnessHistoryEntry } {
  const proposalAfter = { ...proposal, status: action };
  const historyEntry: HarnessHistoryEntry = {
    proposalId: proposal.id,
    action,
    at,
  };
  if (sessionId !== undefined) {
    historyEntry.sessionId = sessionId;
  }
  return { proposal: proposalAfter, historyEntry };
}
