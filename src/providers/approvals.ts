// Frontend wrapper around the runtime-issued approval ledger. The
// runtime's `agent_runtime_check_approval` command tells us whether a
// given approval id is still usable, session-wide reusable, or already
// consumed. This module caches the last-known status so the composer
// doesn't have to round-trip for every tool call.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

export type ApprovalCheckStatus =
  | "valid"
  | "session-wide"
  | "already-consumed"
  | "unknown"
  | "not-approved";

export interface ApprovalCheckResult {
  status: ApprovalCheckStatus;
  approved: boolean;
  message: string;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  objective: string;
  riskClass:
    | "readOnly"
    | "localWrite"
    | "shell"
    | "network"
    | "dependency"
    | "browser"
    | "destructive";
  actionLabels: string[];
  affectedFiles: string[];
  diffPreview: string | null;
  commands: string[];
  rollbackPlan: string[];
  status: "pending" | "approvedOnce" | "rejected" | "approvedForSession";
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export async function checkApproval(id: string, consumeOneShot = true): Promise<ApprovalCheckResult> {
  if (!isTauriRuntime()) {
    throw new Error("Approval checks are available inside the Zeus desktop runtime.");
  }
  return invoke<ApprovalCheckResult>("agent_runtime_check_approval", {
    request: { id, consumeOneShot },
  });
}

export async function listPendingApprovals(sessionId?: string): Promise<PendingApproval[]> {
  if (!isTauriRuntime()) {
    throw new Error("Approval listing is available inside the Zeus desktop runtime.");
  }
  return invoke<PendingApproval[]>("agent_runtime_list_approvals", { sessionId });
}

export async function resolveApproval(
  id: string,
  status: "approvedOnce" | "approvedForSession" | "rejected",
  note?: string,
): Promise<PendingApproval> {
  if (!isTauriRuntime()) {
    throw new Error("Approval resolution is available inside the Zeus desktop runtime.");
  }
  return invoke<PendingApproval>("agent_runtime_resolve_approval", { id, status, note });
}

export async function createApproval(args: {
  sessionId: string;
  objective: string;
  actionLabels: string[];
  affectedFiles: string[];
  riskClass: PendingApproval["riskClass"];
  diffPreview?: string;
  commands?: string[];
  rollbackPlan?: string[];
}): Promise<PendingApproval> {
  if (!isTauriRuntime()) {
    throw new Error("Approval creation is available inside the Zeus desktop runtime.");
  }
  return invoke<PendingApproval>("agent_runtime_create_approval", { request: args });
}

/**
 * In-memory cache of the most recent approval status checks so the
 * composer can show badges without an extra round-trip. Entries are
 * invalidated when the agent reports `approvalRequired: true` on a
 * tool call.
 */
class ApprovalCache {
  private readonly entries = new Map<string, ApprovalCheckResult>();

  remember(id: string, result: ApprovalCheckResult): void {
    this.entries.set(id, result);
  }

  recall(id: string): ApprovalCheckResult | undefined {
    return this.entries.get(id);
  }

  invalidate(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}

export const approvalCache = new ApprovalCache();