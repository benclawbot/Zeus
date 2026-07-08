import { sendMinimaxChat } from "./minimax";
import {
  runAgentTask,
  searchWorkspaceCode,
  type AgentRunResult,
  type AgentRunStepLog,
  type AgentStepRequest,
} from "./workspace";

/**
 * Public type for any chat provider.
 *
 * The `id` is what gets sent to the Rust dispatcher (`send_chat`) and the
 * frontend registry; `displayName` is what the UI renders in the provider
 * picker; `defaultModel` is the model used when the user hasn't picked one.
 * `chat` is the function that actually runs a completion — today every
 * provider's `chat` is just a thin wrapper around the same `send_chat` Tauri
 * command, but in the future providers may diverge (different auth flows,
 * streaming, etc.) and this is the seam.
 */
export interface ProviderClient {
  id: string;
  displayName: string;
  defaultModel: string;
  chat: typeof sendMinimaxChat;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  provider: string;
  messages: ChatMessage[];
  /** Optional skill id. When set, the skill body is loaded and injected server-side. */
  skillId?: string;
  /** Optional model override. Falls back to the provider's default. */
  model?: string;
  /**
   * Optional API base URL override. Falls back to the provider's default
   * (e.g. https://api.minimax.io/v1 for MiniMax). Set this from the
   * Settings panel to point at a self-hosted proxy or a regional host.
   */
  baseUrl?: string;
  /** Optional temperature override. Provider-specific support. */
  temperature?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: unknown;
}

type SearchStep = { kind: "search"; query: string; root?: string; workspaceDir?: string; maxResults?: number; seenFiles?: string[] };
type ParsedToolStep = AgentStepRequest | SearchStep;

const TOOL_BLOCK_PATTERN = /```tool\s*\n([\s\S]*?)\n```/g;
// 12 turns is enough for a "produce a standalone artifact + verify"
// task while still bounding runaway iteration. Earlier default was 6
// which only fit tight in-workspace edits.
const MAX_TOOL_TURNS = 12;
// Allow a little more headroom for the observation so the model can
// see complete HTML/text output of files it just wrote, even when
// individual tool results are large.
const MAX_TOOL_OBSERVATION_CHARS = 80_000;
// When the model emits the same tool block twice in a row, break out
// instead of burning the rest of the budget. This catches the most
// common stuck-iteration failure mode (the model retries a failing
// edit because the previous failure observation didn't reach it).
const MAX_REPEATED_TOOL_BLOCKS = 3;

const WORKSPACE_TOOL_PROMPT = [
  "# Zeus workspace tools",
  "The desktop runtime executes fenced `tool` blocks and returns a structured observation before your final reply.",
  "Available tools: `listDir`, `readFile`, `search`, `editFile`, `writeFile`, `createArtifact`, `runCommand`, `gitOp`, `runTest`, `loadProjectConfig`.",
  "Use `listDir` to inspect structure, `search` for grep/symbol lookup, `readFile` for contents, `editFile` for targeted patches, `writeFile`/`createArtifact` to materialize files (see below), and `runCommand`/`gitOp`/`runTest` for verification.",
  "Each tool line is `<toolName> <json>`, for example: `search {\"query\":\"runAgentTask\",\"maxResults\":20}`.",
  "`createArtifact` is a special raw-body tool for standalone deliverables (HTML pages, READMEs, single-file scripts). Use it like this so you don't have to JSON-escape a large file body:",
  "```tool",
  "createArtifact path=coding-agents.html",
  "<!doctype html>",
  "<html><head><title>...</title></head>",
  "<body>...</body>",
  "</html>",
  "<<<END",
  "```",
  "The first line declares `path=...` (and optionally `create=false` / `overwrite=false`); every line that follows is the literal file body, until a line containing only `<<<END` on its own ends the artifact.",
  "`writeFile {\"path\":...,\"content\":\"...\"}` is for in-repo source edits where you want `create:false` / `overwrite:false` semantics; `createArtifact` is for artifacts where creating-or-overwriting is the expected behavior.",
  "Path resolution: Zeus is currently unrestricted. Use absolute paths whenever needed (Windows drive letters like `C:\\path\\file.html` are accepted), and `..` traversal is allowed. `workspaceDir` is only an anchor for relative paths, not a boundary. For `search`, pass `root` or `workspaceDir` when you need to search outside the launch directory.",
  "Important: when an observation reports `failed [code]: message` with a Suggestion block, fix the call before re-emitting. Do not retry the same tool block if the previous attempt produced a `failed` line.",
  "After two failed attempts for the same tool, switch tools (e.g. `readFile` then `editFile`) or stop and explain what you tried.",
].join("\n");

/**
 * Single entry point for every chat call. Adds the workspace-tool prompt
 * to the system message, dispatches the request to the active provider,
 * then runs the bounded observe-and-replan loop: each iteration parses
 * `tool` blocks, executes them through the runtime, feeds a structured
 * observation back to the model, and stops when the model produces a
 * final answer (no tool blocks), the budget is exhausted, or the model
 * keeps emitting the same tool block.
 */
export async function dispatchChat(options: ChatOptions): Promise<ChatResponse> {
  const provider = findProvider(options.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${options.provider}`);
  }

  const model = options.model ?? provider.defaultModel;
  const send = (messages: ChatMessage[]) => provider.chat({
    messages,
    skillId: options.skillId,
    model,
    baseUrl: options.baseUrl,
    temperature: options.temperature,
  });

  let messages = withWorkspaceToolPrompt(options.messages);
  let response = await send(messages);
  const objective = lastUserMessage(options.messages) || "workspace task";

  let lastToolBlock: string | null = null;
  let repeatedCount = 0;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
    const toolBlocks = extractToolBlocks(response.content);
    if (toolBlocks.length === 0) return response;

    // Detect the "stuck emitting the same tool block" failure mode early
    // so we don't burn the rest of the budget.
    const serialized = JSON.stringify(toolBlocks);
    if (serialized === lastToolBlock) {
      repeatedCount += 1;
      if (repeatedCount >= MAX_REPEATED_TOOL_BLOCKS) {
        return {
          ...response,
          content: stripToolBlocks(response.content).trim(),
        };
      }
    } else {
      repeatedCount = 1;
      lastToolBlock = serialized;
    }

    const steps = parseToolBlocks(toolBlocks);
    if (steps.length === 0) return response;

    const observation = await runToolSteps(steps, objective);
    messages = [
      ...messages,
      { role: "assistant", content: response.content },
      { role: "user", content: observation },
    ];
    response = await send(messages);
  }

  return {
    ...response,
    content: `${stripToolBlocks(response.content)}\n\nStopped after ${MAX_TOOL_TURNS} tool turns. The model kept requesting workspace actions instead of producing a final answer.`.trim(),
  };
}

function withWorkspaceToolPrompt(messages: ChatMessage[]): ChatMessage[] {
  if (messages.some((message) => message.role === "system" && message.content.includes("# Zeus workspace tools"))) {
    return messages;
  }
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: WORKSPACE_TOOL_PROMPT }, ...messages];
  }
  return messages.map((message, index) => index === systemIndex
    ? { ...message, content: `${message.content}\n\n${WORKSPACE_TOOL_PROMPT}` }
    : message);
}

interface RawToolBlock {
  rawLines: string[];
}

function extractToolBlocks(content: string): RawToolBlock[] {
  const blocks: RawToolBlock[] = [];
  for (const match of content.matchAll(TOOL_BLOCK_PATTERN)) {
    blocks.push({ rawLines: match[1].split(/\r?\n/) });
  }
  return blocks;
}

// Sentinel that marks the end of a `createArtifact` raw-body block. Each
// line up to (and not including) this marker is appended verbatim to the
// file body. The sentinel must appear on its own line, optionally
// indented; the matching is exact against `RAW_BODY_END_MARKER`.
const RAW_BODY_END_MARKER = "<<<END";

function parseToolBlocks(blocks: RawToolBlock[]): ParsedToolStep[] {
  // Each block may contain one or more tool calls. Two syntaxes are
  // supported side by side so the LLM never has to JSON-escape a large
  // multi-line file body just to call a tool.
  //
  //   Standard call — one line:
  //     <kind> <json>
  //
  //   Raw-body call (`createArtifact`) — header line + body lines until
  //   the explicit sentinel `<<<END`:
  //     createArtifact path=coding-agents.html
  //         <!doctype html>
  //         <html>...</html>
  //         <<<END
  // The header line carries `key=value` metadata rather than JSON so the
  // LLM doesn't have to escape every line of a 30 KB HTML body. The body
  // is collected verbatim until the sentinel.
  const RAW_BODY_KINDS = new Set(["createArtifact"]);
  const steps: ParsedToolStep[] = [];
  for (const block of blocks) {
    let i = 0;
    while (i < block.rawLines.length) {
      const rawLine = block.rawLines[i];
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) { i += 1; continue; }
      const split = rawLine.indexOf(" ");
      if (split === -1) { i += 1; continue; }
      const kind = rawLine.slice(0, split).trim();
      const rest = rawLine.slice(split + 1).trim();
      if (RAW_BODY_KINDS.has(kind)) {
        const metadata: Record<string, string> = {};
        for (const token of rest.split(/\s+/)) {
          if (!token) continue;
          const eq = token.indexOf("=");
          if (eq === -1) continue;
          metadata[token.slice(0, eq)] = token.slice(eq + 1);
        }
        const bodyLines: string[] = [];
        let j = i + 1;
        let endSeen = false;
        while (j < block.rawLines.length && !endSeen) {
          const next = block.rawLines[j];
          const nextTrim = next.trim();
          if (nextTrim === RAW_BODY_END_MARKER) {
            endSeen = true;
            j += 1;
            break;
          }
          bodyLines.push(next);
          j += 1;
        }
        i = j;
        if (metadata.path) {
          steps.push({
            kind: "writeFile",
            path: metadata.path,
            content: bodyLines.join("\n"),
            create: metadata.create !== "false",
            overwrite: metadata.overwrite !== "false",
          });
        }
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rest);
      } catch {
        i += 1;
        continue;
      }
      const step = parseToolStep(kind, parsed);
      if (step) steps.push(step);
      i += 1;
    }
  }
  return steps;
}

// `parseToolSteps` is the public alias for `parseToolBlocks(extractToolBlocks(content))`.
// Tests rely on this name; the loop in `dispatchChat` uses the fully
// resolved path internally for type clarity.
function parseToolSteps(content: string): ParsedToolStep[] {
  return parseToolBlocks(extractToolBlocks(content));
}

function parseToolStep(kind: string, parsed: Record<string, unknown>): ParsedToolStep | null {
  if (kind === "readFile" && typeof parsed.path === "string") {
    return { kind: "readFile", path: parsed.path, maxBytes: numberField(parsed.maxBytes) };
  }
  if (kind === "writeFile" && typeof parsed.path === "string" && typeof parsed.content === "string") {
    return { kind: "writeFile", path: parsed.path, content: parsed.content, create: parsed.create === true, overwrite: parsed.overwrite === true };
  }
  if (kind === "editFile" && typeof parsed.path === "string" && typeof parsed.find === "string" && typeof parsed.replace === "string") {
    return { kind: "editFile", path: parsed.path, find: parsed.find, replace: parsed.replace, replaceAll: parsed.replaceAll === true };
  }
  if (kind === "runCommand" && typeof parsed.program === "string" && Array.isArray(parsed.args)) {
    return {
      kind: "runCommand",
      program: parsed.program,
      args: stringList(parsed.args),
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      timeoutMs: numberField(parsed.timeoutMs),
    };
  }
  if (kind === "listDir" && typeof parsed.path === "string") {
    return { kind: "listDir", path: parsed.path, maxEntries: numberField(parsed.maxEntries) };
  }
  if (kind === "search" && typeof parsed.query === "string") {
    return { kind: "search", query: parsed.query, root: typeof parsed.root === "string" ? parsed.root : undefined, workspaceDir: typeof parsed.workspaceDir === "string" ? parsed.workspaceDir : undefined, maxResults: numberField(parsed.maxResults), seenFiles: Array.isArray(parsed.seenFiles) ? stringList(parsed.seenFiles) : undefined };
  }
  if (kind === "loadProjectConfig") {
    return { kind: "loadProjectConfig" };
  }
  if (kind === "gitOp" && Array.isArray(parsed.args)) {
    return { kind: "gitOp", args: stringList(parsed.args), timeoutMs: numberField(parsed.timeoutMs) };
  }
  if (kind === "runTest") {
    return { kind: "runTest", args: Array.isArray(parsed.args) ? stringList(parsed.args) : [], timeoutMs: numberField(parsed.timeoutMs) };
  }
  return null;
}

/**
 * Run a batch of parsed tool steps and produce a single observation
 * the model can act on. Steps are grouped into a single `runAgentTask`
 * call so we receive structured `logs` back from the Rust runtime
 * (including typed failure payloads with code + suggestion) instead of
 * an opaque JSON dump that the model has to parse itself.
 *
 * The observation is plain markdown with one line per step. Failed steps
 * include the structured failure code, the message, and the suggestion
 * so the model can self-correct on the next iteration. Successful steps
 * include a short success summary. This format was the missing piece
 * behind the "Stopped after 6 tool turns" failure mode: previously the
 * observation was a JSON blob the model couldn't easily interpret.
 */
// Exported for unit tests; see `registry.test.ts`.
export { withWorkspaceToolPrompt, extractToolBlocks, parseToolSteps, formatAgentRunResult, formatStepLog };

async function runToolSteps(steps: ParsedToolStep[], objective: string): Promise<string> {
  const agentSteps: AgentStepRequest[] = [];
  const searchSteps: Array<Extract<SearchStep, { kind: "search" }>> = [];
  for (const step of steps) {
    if (step.kind === "search") {
      searchSteps.push({ kind: "search", query: step.query, root: step.root, workspaceDir: step.workspaceDir, maxResults: step.maxResults, seenFiles: step.seenFiles });
    } else {
      agentSteps.push(step);
    }
  }

  const lines: string[] = ["Tool result for the fenced `tool` block. Each step below is a real Zeus workspace observation."];

  if (agentSteps.length > 0) {
    try {
      const result: AgentRunResult = await runAgentTask({ objective, steps: agentSteps, stopOnError: false });
      lines.push(...formatAgentRunResult(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`agent run failed: ${message}`);
    }
  }

  for (const search of searchSteps) {
    try {
      const hits = await searchWorkspaceCode({ query: search.query, workspaceDir: search.root ?? search.workspaceDir, maxResults: search.maxResults, seenFiles: search.seenFiles });
      lines.push(`search "${search.query}" returned ${hits.hits.length} hits under ${hits.root}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`search "${search.query}" failed: ${message}`);
    }
  }

  return clip(lines.join("\n"), MAX_TOOL_OBSERVATION_CHARS);
}

function formatAgentRunResult(result: AgentRunResult): string[] {
  const lines: string[] = [];
  const header = result.completed
    ? `agent run completed (${result.logs.length} step${result.logs.length === 1 ? "" : "s"}, ${result.filesTouched.length} file${result.filesTouched.length === 1 ? "" : "s"} touched).`
    : `agent run failed (${result.logs.length} step${result.logs.length === 1 ? "" : "s"}, ${result.filesTouched.length} file${result.filesTouched.length === 1 ? "" : "s"} touched).`;
  lines.push(header);
  if (result.summary) lines.push(`summary: ${result.summary}`);
  for (const log of result.logs) {
    lines.push(formatStepLog(log));
  }
  if (result.diff) lines.push(`combined diff:\n${result.diff}`);
  return lines;
}

function formatStepLog(log: AgentRunStepLog): string {
  const result = log.result as Record<string, unknown> & {
    kind?: string;
    code?: string;
    message?: string;
    suggestion?: string;
    occurrences?: number;
    source?: string;
  };
  if (result.kind === "failed" || typeof result.code === "string") {
    const detailParts: string[] = [];
    if (typeof result.occurrences === "number") detailParts.push(`${result.occurrences} occurrences`);
    if (typeof result.source === "string") detailParts.push(result.source);
    const detail = detailParts.length > 0 ? ` (${detailParts.join(", ")})` : "";
    const code = typeof result.code === "string" ? result.code : "failed";
    const message = typeof result.message === "string" ? result.message : "(no message)";
    const suggestion = typeof result.suggestion === "string" ? result.suggestion : null;
    let line = `Step ${log.index + 1} (${log.label}) failed [${code}${detail}]: ${message}`;
    if (suggestion) line += `\n  Suggestion: ${suggestion}`;
    return line;
  }
  return `Step ${log.index + 1} (${log.label}) ok.`;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown[]): string[] {
  return value.filter((item): item is string => typeof item === "string");
}

function lastUserMessage(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return messages[index].content;
  }
  return undefined;
}

function stripToolBlocks(value: string): string {
  return value.replace(TOOL_BLOCK_PATTERN, "").trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

/**
 * Look up a registered provider by id.
 */
export function findProvider(id: string): ProviderClient | undefined {
  return registry.find((provider) => provider.id === id);
}

/**
 * Built-in provider registry. Adding a new provider = appending an entry
 * here and (if its protocol differs from OpenAI completions) wiring a
 * separate `chat` function. See `src/providers/minimax.ts` for an example.
 */
const registry: ProviderClient[] = [
  {
    id: "minimax",
    displayName: "MiniMax",
    defaultModel: "MiniMax-M3",
    chat: sendMinimaxChat,
  },
];

export function listProviders(): ProviderClient[] {
  return registry.slice();
}
