import { PlanProgressPanel } from "../components/PlanProgressPanel";
import type { RuntimePlan } from "../agentRuntimeDeepLoop";
import { cacheReadPercent } from "../providers/tokenUsage";

interface InspectorPanelProps {
  latestUserObjective: string;
  lastToolFailed: boolean;
  runtimePlan: RuntimePlan | null;
  planPhase: "idle" | "conversation" | "planning" | "ready" | "unavailable";
  latestTurnTokens: { in: number; out: number; cached?: number; cacheWrite?: number } | null;
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
  lastToolFailed,
  runtimePlan,
  planPhase,
  latestTurnTokens,
  runState,
  messageCount,
  onOpenSettings,
}: InspectorPanelProps) {
  const cachedPercent = latestTurnTokens
    ? cacheReadPercent({ input: latestTurnTokens.in, output: latestTurnTokens.out, cacheRead: latestTurnTokens.cached })
    : null;
  return (
    <aside className="inspector" aria-label="Run details">
      <PlanProgressPanel
        latestUserObjective={latestUserObjective}
        lastToolFailed={lastToolFailed}
        runtimePlan={runtimePlan}
        planPhase={planPhase}
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
          <div><dt>Cache read</dt><dd>{latestTurnTokens?.cached !== undefined ? `${latestTurnTokens.cached.toLocaleString()} (${cachedPercent?.toFixed(1)}%)` : "not reported"}</dd></div>
          <div><dt>Cache write</dt><dd>{latestTurnTokens?.cacheWrite !== undefined ? latestTurnTokens.cacheWrite.toLocaleString() : "not reported"}</dd></div>
        </dl>
        <button type="button" onClick={onOpenSettings}>Open settings</button>
      </section>
    </aside>
  );
}
