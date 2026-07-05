import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";

export interface ShellCommandRequest {
  program: string;
  args?: string[];
  cwd?: string;
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
}

export interface ReadWorkspaceFileRequest {
  path: string;
  maxBytes?: number;
}

export interface ReadWorkspaceFileResult {
  path: string;
  content: string;
  bytesRead: number;
  truncated: boolean;
}

export interface WriteWorkspaceFileRequest {
  path: string;
  content: string;
  create?: boolean;
  overwrite?: boolean;
  expectedText?: string;
  approved?: boolean;
}

export interface WriteWorkspaceFileResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export interface ApplyWorkspaceEditRequest {
  path: string;
  find: string;
  replace: string;
  replaceAll?: boolean;
  approved?: boolean;
}

export interface ApplyWorkspaceEditResult {
  path: string;
  replacements: number;
  bytesWritten: number;
}

function requireTauri(feature: string) {
  if (!isTauriRuntime()) {
    throw new Error(`${feature} is available inside the Zeus desktop runtime.`);
  }
}

export async function runShellCommand(request: ShellCommandRequest): Promise<ShellCommandResult> {
  requireTauri("Shell execution");
  return invoke<ShellCommandResult>("run_shell_command", { request });
}

export async function readWorkspaceFile(request: ReadWorkspaceFileRequest): Promise<ReadWorkspaceFileResult> {
  requireTauri("Workspace file reading");
  return invoke<ReadWorkspaceFileResult>("read_workspace_file", { request });
}

export async function writeWorkspaceFile(request: WriteWorkspaceFileRequest): Promise<WriteWorkspaceFileResult> {
  requireTauri("Workspace file writing");
  return invoke<WriteWorkspaceFileResult>("write_workspace_file", { request });
}

export async function applyWorkspaceEdit(request: ApplyWorkspaceEditRequest): Promise<ApplyWorkspaceEditResult> {
  requireTauri("Workspace file editing");
  return invoke<ApplyWorkspaceEditResult>("apply_workspace_edit", { request });
}
