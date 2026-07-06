import type { HarnessProposal } from "./harness";

/**
 * Compute the notification-badge count for the Harness Evolution menu.
 *
 * Today Zeus carries exactly one pending proposal at a time, so this
 * returns 1 or 0. If the project ever moves to multiple proposals,
 * change the implementation to a `.filter().length` over the array —
 * the call sites stay the same.
 */
export function countPendingProposals(
  currentProposal: HarnessProposal | null,
  viewOpen: boolean,
): number {
  if (viewOpen) return 0;
  if (!currentProposal) return 0;
  return currentProposal.status === "ready" || currentProposal.status === "edited"
    ? 1
    : 0;
}