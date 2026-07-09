import { PlanProgressPanel } from "../components/PlanProgressPanel";
import type { RuntimePlan } from "../agentRuntimeDeepLoop";
import type { AgentRunSummary } from "../components/PlanProgressPanel";

interface InspectorPanelProps {
  latestUserObjective: string;
  lastAgentRun: AgentRunSummary | null;
  lastToolFailed: boolean;
  runtimePlan: RuntimePlan | null;
  latestTurnTokens: { in: number; out: number; cached?: number } | null;
  runState: "idle" | "running" | "error";
  messageCount: number;
  onOpenSettings: () => void;
}

/**
 * Right-hand aside. Hosts the plan progress panel + a compact Session
 * summary (latest turn token cost + link to settings). Pure props-in:
 * the orchestrator owns the state.
 */
export function InspectorPanel({
  latestUserObjective,
  lastAgentRun,
  lastToolFailed,
  runtimePlan,
  latestTurnTokens,
  runState,
  messageCount,
  onOpenSettings,
}: InspectorPanelProps) {
  return (
    <aside className="inspector" aria-label="Run details">
      <PlanProgressPanel
        latestUserObjective={latestUserObjective}
        lastAgentRun={lastAgentRun}
        lastToolFailed={lastToolFailed}
        runtimePlan={runtimePlan}
      />

      <section className="panel session-panel">
        <div className="panel-heading">
          <h2>Session</h2>
          <span>{runState === "running" ? "running" : `${messageCount} messages`}</span>
        </div>
        <p className="skills-muted">Last turn tokens</p>
        <dl>
          <div><dt>In</dt><dd>{latestTurnTokens ? latestTurnTokens.in.toLocaleString() : "—"}</dd></div>
          <div><dt>Out</dt><dd>{latestTurnTokens ? latestTurnTokens.out.toLocaleString() : "—"}</dd></div>
          <div><dt>Cached</dt><dd>{latestTurnTokens?.cached !== undefined ? latestTurnTokens.cached.toLocaleString() : "—"}</dd></div>
        </dl>
        <button type="button" onClick={onOpenSettings}>Open settings</button>
      </section>
    </aside>
  );
}
