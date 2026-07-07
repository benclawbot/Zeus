import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

export function getSelectedWorkspaceDir(): string | undefined {
  // Workspace selection is now a runtime concern. In packaged builds the
  // backend resolves Zeus' installed/resource home and skills directory; in
  // Full mode it may also authorize absolute filesystem paths. The composer
  // no longer owns a per-session workspace folder.
  return undefined;
}

function withSelectedWorkspace<T extends { workspaceDir?: string }>(request: T): T {
  return { ...request, workspaceDir: request.workspaceDir ?? getSelectedWorkspaceDir() };
}

function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  return trimmed === "." || trimmed === "./" ? "" : trimmed;
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

export interface ListWorkspaceDirResult {
  path: string;
  entries: Array<{ name: string; kind: "file" | "dir"; size: number }>;
  truncated: boolean;
}

export interface ProjectConfigSnapshot {
  /** Path of the config file that was loaded (e.g. package.json). */
  path: string;
  /** Project root the config was resolved relative to. */
  root: string;
  /** Parsed contents as a JSON value, or the raw string for non-JSON configs. */
  config: unknown;
}

export interface GitOperationResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** True when the command modified the working tree (commit, write, etc.). */
  mutated: boolean;
}

export interface TestRunResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Number of test cases the runner reported as failed. -1 when unknown. */
  failedCount: number;
  /** Number of test cases the runner reported as passed. -1 when unknown. */
  passedCount: number;
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
  | { kind: "readFile"; path: string; maxBytes?: number }
  | { kind: "writeFile"; path: string; content: string; create: boolean; overwrite: boolean }
  | { kind: "editFile"; path: string; find: string; replace: string; replaceAll: boolean }
  | { kind: "runCommand"; program: string; args: string[]; cwd?: string; timeoutMs?: number }
  | { kind: "listDir"; path: string; maxEntries?: number }
  | { kind: "loadProjectConfig" }
  | { kind: "gitOp"; args: string[]; timeoutMs?: number }
  | { kind: "runTest"; args?: string[]; timeoutMs?: number };

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

export function normalizeAgentStep(step: AgentStepRequest): AgentStepRequest {
  switch (step.kind) {
    case "listDir":
      return { ...step, path: normalizeWorkspacePath(step.path) };
    case "runCommand":
      return { ...step, cwd: step.cwd ? normalizeWorkspacePath(step.cwd) || undefined : undefined };
    case "readFile":
    case "writeFile":
    case "editFile":
      return { ...step, path: normalizeWorkspacePath(step.path) };
    default:
      return step;
  }
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
  return invoke<ReadWorkspaceFileResult>("read_workspace_file", { request: withSelectedWorkspace({ path: normalizeWorkspacePath(path), maxBytes, workspaceDir }) });
}

export async function listWorkspaceDir(path: string, maxEntries?: number, workspaceDir?: string): Promise<ListWorkspaceDirResult> {
  ensureRuntime("Workspace directory listing");
  return invoke<ListWorkspaceDirResult>("list_workspace_dir", { request: withSelectedWorkspace({ path: normalizeWorkspacePath(path), maxEntries, workspaceDir }) });
}

export async function loadProjectConfig(workspaceDir?: string): Promise<ProjectConfigSnapshot> {
  ensureRuntime("Project config discovery");
  return invoke<ProjectConfigSnapshot>("load_project_config", { request: withSelectedWorkspace({ workspaceDir }) });
}

export async function runGitOperation(args: string[], workspaceDir?: string, timeoutMs?: number): Promise<GitOperationResult> {
  ensureRuntime("Git operations");
  return invoke<GitOperationResult>("run_git_operation", { request: withSelectedWorkspace({ args, workspaceDir, timeoutMs }) });
}

export async function runProjectTest(args: string[] = [], workspaceDir?: string, timeoutMs?: number): Promise<TestRunResult> {
  ensureRuntime("Test execution");
  return invoke<TestRunResult>("run_project_test", { request: withSelectedWorkspace({ args, workspaceDir, timeoutMs }) });
}

export async function runBrowserSmoke(visible = false, workspaceDir?: string, timeoutMs = 120_000): Promise<ShellCommandResult> {
  return runShellCommand({
    program: "npm",
    args: ["run", visible ? "browser:smoke:visible" : "browser:smoke"],
    workspaceDir,
    timeoutMs,
  });
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
  return invoke<WriteWorkspaceFileResult>("write_workspace_file", { request: withSelectedWorkspace({ ...args, path: normalizeWorkspacePath(args.path) }) });
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
  return invoke<ApplyWorkspaceEditResult>("apply_workspace_edit", { request: withSelectedWorkspace({ ...args, path: normalizeWorkspacePath(args.path) }) });
}

export async function runAgentTask(request: AgentRunRequest): Promise<AgentRunResult> {
  ensureRuntime("Agent task execution");
  return invoke<AgentRunResult>("run_agent_task", { request: withSelectedWorkspace({ ...request, steps: request.steps.map(normalizeAgentStep) }) });
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
