import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";
import { ZEUS_WORKSPACE_DIR_KEY } from "../WorkspaceDirectoryControl";

export function getSelectedWorkspaceDir(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = window.localStorage.getItem(ZEUS_WORKSPACE_DIR_KEY)?.trim();
  return value || undefined;
}

function withSelectedWorkspace<T extends { workspaceDir?: string }>(request: T): T {
  return { ...request, workspaceDir: request.workspaceDir ?? getSelectedWorkspaceDir() };
}

export interface PolicyDecision {
  accessMode: string;
  commandClass: string;
  approvalRequired: boolean;
  approved: boolean;
}

export interface ShellCommandRequest {
  program: string;
  args?: string[];
  cwd?: string;
  workspaceDir?: string;
  timeoutMs?: number;
  approved?: boolean;
}

export interface ShellCommandResult {
  program: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  policy: PolicyDecision;
}

export interface ReadWorkspaceFileResult {
  path: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
}

export interface WriteWorkspaceFileResult {
  path: string;
  bytesWritten: number;
  created: boolean;
  diff: string;
}

export interface ApplyWorkspaceEditResult {
  path: string;
  replacements: number;
  bytesWritten: number;
  diff: string;
}

export type AgentStepRequest =
  | { kind: "readFile"; path: string }
  | { kind: "writeFile"; path: string; content: string; create: boolean; overwrite: boolean }
  | { kind: "editFile"; path: string; find: string; replace: string; replaceAll: boolean }
  | { kind: "runCommand"; program: string; args: string[]; cwd?: string; timeoutMs?: number };

export interface AgentRunRequest {
  objective: string;
  workspaceDir?: string;
  steps: AgentStepRequest[];
  approved?: boolean;
  stopOnError?: boolean;
}

export interface AgentRunStepLog {
  index: number;
  label: string;
  result: unknown;
}

export interface AgentRunResult {
  objective: string;
  completed: boolean;
  filesTouched: string[];
  logs: AgentRunStepLog[];
  diff: string;
  summary: string;
  proposedHarnessRule: string | null;
  rollbackPlan: string[];
}

function ensureRuntime(feature: string): void {
  if (!isTauriRuntime()) {
    throw new Error(`${feature} is available inside the Zeus desktop runtime.`);
  }
}

export async function runShellCommand(request: ShellCommandRequest): Promise<ShellCommandResult> {
  ensureRuntime("Shell execution");
  return invoke<ShellCommandResult>("run_shell_command", { request: withSelectedWorkspace(request) });
}

export async function readWorkspaceFile(path: string, maxBytes?: number, workspaceDir?: string): Promise<ReadWorkspaceFileResult> {
  ensureRuntime("Workspace file reads");
  return invoke<ReadWorkspaceFileResult>("read_workspace_file", { request: withSelectedWorkspace({ path, maxBytes, workspaceDir }) });
}

export async function writeWorkspaceFile(args: {
  path: string;
  content: string;
  workspaceDir?: string;
  create?: boolean;
  overwrite?: boolean;
  expectedText?: string;
  approved?: boolean;
}): Promise<WriteWorkspaceFileResult> {
  ensureRuntime("Workspace file writes");
  return invoke<WriteWorkspaceFileResult>("write_workspace_file", { request: withSelectedWorkspace(args) });
}

export async function applyWorkspaceEdit(args: {
  path: string;
  workspaceDir?: string;
  find: string;
  replace: string;
  replaceAll?: boolean;
  approved?: boolean;
}): Promise<ApplyWorkspaceEditResult> {
  ensureRuntime("Workspace file edits");
  return invoke<ApplyWorkspaceEditResult>("apply_workspace_edit", { request: withSelectedWorkspace(args) });
}

export async function runAgentTask(request: AgentRunRequest): Promise<AgentRunResult> {
  ensureRuntime("Agent task execution");
  return invoke<AgentRunResult>("run_agent_task", { request: withSelectedWorkspace(request) });
}

export function parseShellWords(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;
  for (const ch of input) {
    if (escaping) { current += ch; escaping = false; continue; }
    if (ch === "\\" && quote !== "'") { escaping = true; continue; }
    if ((ch === '"' || ch === "'") && !quote) { quote = ch; continue; }
    if (quote === ch) { quote = null; continue; }
    if (!quote && /\s/.test(ch)) {
      if (current) { words.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (quote) throw new Error("Unclosed quote in shell command.");
  if (current) words.push(current);
  return words;
}
