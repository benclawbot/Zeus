import type { HarnessHistoryEntry, HarnessProposal } from "../state/harness";
import type { SessionRef } from "../App";

interface HarnessEvolutionViewProps {
  proposal: HarnessProposal;
  history: HarnessHistoryEntry[];
  recentSessions: SessionRef[];
  onApply: () => void;
  onDiscard: () => void;
  onSelectSession: (session: SessionRef) => void;
}

/**
 * Card showing the active harness proposal, its status, and a short
 * history of decisions. Pure props-in; the orchestrator owns the
 * proposal state machine and the apply/discard side effects.
 */
export function HarnessEvolutionView({
  proposal,
  history,
  recentSessions,
  onApply,
  onDiscard,
  onSelectSession,
}: HarnessEvolutionViewProps) {
  const linked = history.find((entry) => entry.sessionId && entry.proposalId === proposal.id);
  const sessionRef = linked?.sessionId ? recentSessions.find((s) => s.id === linked.sessionId) : null;
  const showActions = proposal.status === "ready" || proposal.status === "edited";
  const showLinkedStatus =
    proposal.status === "implementing" || proposal.status === "applied" || proposal.status === "failed";
  return (
    <div className="utility-card">
      <p>{proposal.summary}</p>
      <p className="proposal-body">{proposal.body}</p>
      {showActions ? (
        <div className="proposal-actions">
          <button type="button" onClick={onApply}>Apply</button>
          <button type="button" onClick={onDiscard}>Discard</button>
        </div>
      ) : showLinkedStatus ? (
        <p className="proposal-status-linked">
          {proposal.status === "implementing"
            ? "Implementing session is active in Home. Edit the composer and send to start the agent run."
            : proposal.status === "applied"
              ? "Approved improvement was applied via the implementing session. No further actions on this proposal."
              : "Approved improvement did not complete. Review the implementing session for partial results."}
        </p>
      ) : null}
      <p className="proposal-status">Status: {proposal.status}</p>
      {sessionRef ? (
        <p className="proposal-linked-session">
          Implementing session:{" "}
          <button className="link-button" type="button" onClick={() => onSelectSession(sessionRef)}>
            {sessionRef.label}
          </button>
        </p>
      ) : linked?.sessionId ? (
        <p className="proposal-linked-session">
          <span className="skills-muted">session no longer in recent list</span>
        </p>
      ) : null}
      {history.length === 0 ? (
        <p className="skills-muted">No harness changes applied in this session.</p>
      ) : (
        history.map((entry) => (
          <p key={`${entry.proposalId}-${entry.at}`}>{entry.action} / {new Date(entry.at).toLocaleTimeString()}</p>
        ))
      )}
    </div>
  );
}
