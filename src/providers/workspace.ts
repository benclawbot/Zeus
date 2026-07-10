import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

export function getSelectedWorkspaceDir(): string | undefined {
  // Workspace selection is now only a convenience anchor for relative paths.
  // The Rust backend currently runs in unrestricted filesystem mode, so
  // absolute paths and parent traversal are accepted by every access mode.
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
  approvalId?: string | null;
}

export interface ShellCommandRequest {
  program: string;
  args?: string[];
  cwd?: string;
  workspaceDir?: string;
  timeoutMs?: number;
  approved?: boolean;
  /** Runtime approval id. Preferred over `approved: bool` for risky
   *  actions — the runtime has validated this id against its
   *  ApprovedOnce/ApprovedForSession ledger. */
  approvalId?: string;
  approvalSessionId?: string;
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
  approvalId?: string | null;
  /** True when the call was blocked because the supplied approval id
   *  was missing, unknown, or already consumed. */
  approvalRequired?: boolean;
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

export interface WorkspaceSearchHit {
  path: string;
  line: number;
  snippet: string;
  symbol: string | null;
  alreadyRead: boolean;
}

export interface WorkspaceSearchRequest {
  query: string;
  workspaceDir?: string;
  maxResults?: number;
  seenFiles?: string[];
}

export interface WorkspaceSearchResult {
  query: string;
  root: string;
  hits: WorkspaceSearchHit[];
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
  policy: PolicyDecision;
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
  approvalId?: string | null;
  approvalRequired?: boolean;
}

export interface ApplyWorkspaceEditResult {
  path: string;
  replacements: number;
  bytesWritten: number;
  diff: string;
  approvalId?: string | null;
  approvalRequired?: boolean;
}

function withExplicitComposerApproval<T extends { approved?: boolean }>(request: T): T {
  // Direct slash-command helpers are only reached after the human submits the
  // composer command. Agent turns execute through the session-bound Rust runtime.
  return { ...request, approved: request.approved ?? true };
}

function ensureRuntime(feature: string): void {
  if (!isTauriRuntime()) {
    throw new Error(`${feature} is available inside the Zeus desktop runtime.`);
  }
}

export async function runShellCommand(request: ShellCommandRequest): Promise<ShellCommandResult> {
  ensureRuntime("Shell execution");
  return invoke<ShellCommandResult>("run_shell_command", { request: withSelectedWorkspace(withExplicitComposerApproval(request)) });
}

export async function readWorkspaceFile(path: string, maxBytes?: number, workspaceDir?: string): Promise<ReadWorkspaceFileResult> {
  ensureRuntime("Workspace file reads");
  return invoke<ReadWorkspaceFileResult>("read_workspace_file", { request: withSelectedWorkspace({ path: normalizeWorkspacePath(path), maxBytes, workspaceDir }) });
}

export async function listWorkspaceDir(path: string, maxEntries?: number, workspaceDir?: string): Promise<ListWorkspaceDirResult> {
  ensureRuntime("Workspace directory listing");
  return invoke<ListWorkspaceDirResult>("list_workspace_dir", { request: withSelectedWorkspace({ path: normalizeWorkspacePath(path), maxEntries, workspaceDir }) });
}

export async function searchWorkspaceCode(request: WorkspaceSearchRequest): Promise<WorkspaceSearchResult> {
  ensureRuntime("Workspace search");
  const selected = withSelectedWorkspace({ workspaceDir: request.workspaceDir });
  const root = selected.workspaceDir && selected.workspaceDir.trim() ? selected.workspaceDir : ".";
  const query = request.query.trim();
  if (!query) throw new Error("Search query is required.");
  const hits = await invoke<WorkspaceSearchHit[]>("agent_runtime_search_code", {
    request: {
      root,
      query,
      maxResults: Math.max(1, Math.min(request.maxResults ?? 50, 200)),
      seenFiles: request.seenFiles ?? [],
    },
  });
  return { query, root, hits };
}

export async function loadProjectConfig(workspaceDir?: string): Promise<ProjectConfigSnapshot> {
  ensureRuntime("Project config discovery");
  return invoke<ProjectConfigSnapshot>("load_project_config", { request: withSelectedWorkspace({ workspaceDir }) });
}

export async function runGitOperation(args: string[], workspaceDir?: string, timeoutMs?: number): Promise<GitOperationResult> {
  ensureRuntime("Git operations");
  return invoke<GitOperationResult>("run_git_operation", { request: withSelectedWorkspace({ args, workspaceDir, timeoutMs, approved: true }) });
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
  approvalId?: string;
}): Promise<WriteWorkspaceFileResult> {
  ensureRuntime("Workspace file writes");
  return invoke<WriteWorkspaceFileResult>("write_workspace_file", { request: withSelectedWorkspace(withExplicitComposerApproval({ ...args, path: normalizeWorkspacePath(args.path) })) });
}

export async function applyWorkspaceEdit(args: {
  path: string;
  workspaceDir?: string;
  find: string;
  replace: string;
  replaceAll?: boolean;
  approved?: boolean;
  approvalId?: string;
}): Promise<ApplyWorkspaceEditResult> {
  ensureRuntime("Workspace file edits");
  return invoke<ApplyWorkspaceEditResult>("apply_workspace_edit", { request: withSelectedWorkspace(withExplicitComposerApproval({ ...args, path: normalizeWorkspacePath(args.path) })) });
}

export interface RalphVerifier {
  program: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface RunRalphRequest {
  provider: string;
  objective: string;
  systemMessage?: string;
  maxIterations?: number;
  completionMarker?: string;
  verifier?: RalphVerifier;
  skillId?: string;
  model?: string;
  baseUrl?: string;
}

export interface RalphIteration {
  index: number;
  markerSeen: boolean;
  assistantExcerpt: string;
}

export interface RunRalphResult {
  completed: boolean;
  iterationsRun: number;
  exitReason: string;
  marker: string;
  iterations: RalphIteration[];
}

/// Run a Ralph-style autonomous loop. Each iteration is a fresh chat call
/// against the configured provider; the model only "completes" when it
/// emits the marker (and the optional verifier exits 0). Use this for
/// long-running tasks that need backpressure (tests, builds, lints) to
/// know when work is genuinely done.
export async function runRalphLoop(request: RunRalphRequest): Promise<RunRalphResult> {
  ensureRuntime("Ralph loop execution");
  return invoke<RunRalphResult>("run_ralph_loop", { request });
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
