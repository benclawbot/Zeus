import { runAgentTask, searchWorkspaceCode, type AgentRunResult, type AgentRunStepLog, type AgentStepRequest } from "./workspace";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./minimax";
import type { ChatMessage, ChatOptions, ChatResponse } from "./chatTypes";
import { textFromContent } from "./chatTypes";
import { extractToolBlocks, parseToolBlocks, type ParsedToolStep, type SearchStep } from "./toolBlockParser";

// 12 turns is enough for a "produce a standalone artifact + verify"
// task while still bounding runaway iteration. Earlier default was 6
// which only fit tight in-workspace edits.
export const MAX_TOOL_TURNS = 12;
// Allow a little more headroom for the observation so the model can
// see complete HTML/text output of files it just wrote, even when
// individual tool results are large.
export const MAX_TOOL_OBSERVATION_CHARS = 80_000;
// When the model emits the same tool block twice in a row, break out
// instead of burning the rest of the budget. This catches the most
// common stuck-iteration failure mode (the model retries a failing
// edit because the previous failure observation didn't reach it).
export const MAX_REPEATED_TOOL_BLOCKS = 3;

const TOOL_BLOCK_PATTERN = /```tool\s*\n([\s\S]*?)\n```/g;

const WORKSPACE_TOOL_PROMPT = [
  "# Zeus workspace tools",
  "The desktop runtime executes fenced `tool` blocks and returns a structured observation before your final reply.",
  "Available tools: `listDir`, `readFile`, `search`, `webSearch`, `editFile`, `writeFile`, `createArtifact`, `runCommand`, `gitOp`, `runTest`, `loadProjectConfig`.",
  "Use `listDir` to inspect structure, `search` for grep/symbol lookup, `readFile` for contents, `webSearch` for autonomous research (DuckDuckGo, no API key needed — pass `query` and optional `maxResults`), `editFile` for targeted patches, `writeFile`/`createArtifact` to materialize files (see below), and `runCommand`/`gitOp`/`runTest` for verification.",
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
  if (isTauriRuntime()) {
    return invoke<ChatResponse>("agent_runtime_execute_turn", {
      request: {
        sessionId: options.sessionId ?? "desktop-chat",
        objective: options.objective ?? lastUserMessage(options.messages) ?? "workspace task",
        provider: options.provider,
        messages: withWorkspaceToolPrompt(options.messages),
        skillId: options.skillId,
        options: {
          ...(options.model ? { model: options.model } : {}),
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        },
      },
    });
  }
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

// Provider lookup lives in `providerRegistry` to avoid a circular import:
// `registry.ts` re-exports `dispatchChat` from this module, so we cannot
// import from `./registry` here.
import { findProvider } from "./providerRegistry";

export function withWorkspaceToolPrompt(messages: ChatMessage[]): ChatMessage[] {
  if (messages.some((message) => message.role === "system" && textFromContent(message.content).includes("# Zeus workspace tools"))) {
    return messages;
  }
  const systemIndex = messages.findIndex((message) => message.role === "system");
  if (systemIndex === -1) {
    return [{ role: "system", content: WORKSPACE_TOOL_PROMPT }, ...messages];
  }
  return messages.map((message, index) => index === systemIndex
    ? { ...message, content: `${textFromContent(message.content)}\n\n${WORKSPACE_TOOL_PROMPT}` }
    : message);
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
export async function runToolSteps(steps: ParsedToolStep[], objective: string): Promise<string> {
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

export function formatAgentRunResult(result: AgentRunResult): string[] {
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

export function formatStepLog(log: AgentRunStepLog): string {
  const result = log.result as Record<string, unknown> & {
    kind?: string;
    code?: string;
    message?: string;
    suggestion?: string;
    occurrences?: number;
    source?: string;
    provider?: string;
    query?: string;
    hits?: Array<{ title?: string; url?: string; snippet?: string }>;
  };
  if (result.kind === "webSearch") {
    const provider = typeof result.provider === "string" ? result.provider : "web";
    const query = typeof result.query === "string" ? result.query : "";
    const hits = Array.isArray(result.hits) ? result.hits : [];
    const head = `Step ${log.index + 1} (${log.label}) ok: ${provider} returned ${hits.length} hit(s) for "${query}".`;
    if (hits.length === 0) return head;
    const formatted = hits.slice(0, 10).map((hit, idx) => {
      const title = typeof hit.title === "string" ? hit.title : "(untitled)";
      const url = typeof hit.url === "string" ? hit.url : "";
      const snippet = typeof hit.snippet === "string" ? hit.snippet : "";
      const snippetLine = snippet ? ` — ${snippet}` : "";
      return `  ${idx + 1}. ${title}${url ? ` <${url}>` : ""}${snippetLine}`;
    }).join("\n");
    return `${head}\n${formatted}`;
  }
  if (result.kind === "failed" && typeof result.message === "string" && /blocking automated|search provider|webSearch|duckduckgo/i.test(result.message)) {
    // Network-tier failure (bot challenge, dead backend, alternate
    // provider not wired). Surface it loudly so the model doesn't
    // // silently report 0 hits and move on.
    return `Step ${log.index + 1} (${log.label}) failed: ${result.message}\n  Suggestion: ${result.message.includes("blocking automated") ? "DuckDuckGo's anomaly detector is blocking this IP. Configure BRAVE_SEARCH_API_KEY + ZEUS_SEARCH_PROVIDER=brave, or point ZEUS_SEARXNG_URL at a self-hosted SearXNG instance, then retry." : "Switch provider or retry later."}`;
  }
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

function lastUserMessage(messages: ChatMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return textFromContent(messages[index].content);
  }
  return undefined;
}

function stripToolBlocks(value: string): string {
  return value.replace(TOOL_BLOCK_PATTERN, "").trim();
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}
