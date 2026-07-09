import type { AccessMode, SessionRef } from "../App";

interface MemoryViewProps {
  projectName: string;
  activeSession: SessionRef | null;
  messageCount: number;
  activeGoal: { objective: string } | null;
  activeProviderLabel: string;
  accessMode: AccessMode;
  accessSummary: string;
  skillsCount: number;
  skillsStatus: "idle" | "loading" | "ready" | "error";
  activeSkillId: string | null;
  compactFromId: number | null;
}

/**
 * Read-only snapshot of the state Zeus carries into the next turn.
 * Pure props-in; the orchestrator owns every value rendered here.
 */
export function MemoryView({
  projectName,
  activeSession,
  messageCount,
  activeGoal,
  activeProviderLabel,
  accessMode,
  accessSummary,
  skillsCount,
  skillsStatus,
  activeSkillId,
  compactFromId,
}: MemoryViewProps) {
  const skillsLine =
    skillsStatus === "ready"
      ? `${skillsCount} indexed locally`
      : skillsStatus === "loading"
        ? "loading..."
        : skillsStatus === "error"
          ? "discovery failed"
          : "open Skills to index";
  return (
    <div className="utility-card">
      <p className="skills-muted">Memory Snapshot shows the current local state Zeus should carry into the next turn: project, session, goal, provider, access mode, compact window, and active skill.</p>
      <dl>
        <div><dt>Project</dt><dd>{projectName}</dd></div>
        <div><dt>Session Project</dt><dd>{activeSession?.projectName ?? "none"}</dd></div>
        <div><dt>Current Session</dt><dd>{activeSession ? `${activeSession.label} (${messageCount} turn(s))` : "none"}</dd></div>
        <div><dt>Goal</dt><dd>{activeGoal?.objective ?? "none"}</dd></div>
        <div><dt>Provider</dt><dd>{activeProviderLabel}</dd></div>
        <div><dt>Access</dt><dd>{accessMode}</dd></div>
        <div><dt>Skills</dt><dd>{skillsLine}</dd></div>
        <div><dt>Active Skill</dt><dd>{activeSkillId ?? "none"}</dd></div>
        <div><dt>Context Anchor</dt><dd>{compactFromId === null ? "full visible session" : `messages from #${compactFromId}`}</dd></div>
      </dl>
      <p className="skills-muted">{accessSummary}</p>
    </div>
  );
}
