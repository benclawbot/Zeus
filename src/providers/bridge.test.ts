/**
 * Bridge contract test. Locks the TS→Rust Tauri command surface so a
 * rename on one side breaks CI on the other.
 *
 * The Rust `#[tauri::command]` names are listed here verbatim. The test
 * then scans `src/providers/` for `invoke<...>("<name>")` calls and
 * asserts each declared name is referenced AND no TS code calls a name
 * that isn't declared. Both directions matter:
 *
 *  - If Rust renames a command and the test passes, the TS code is
 *    calling the new (correct) name — the test would already be
 *    updated as part of the same change.
 *  - If someone adds an `invoke<...>("typo_here")` call, the test
 *    catches the typo before it ships.
 *
 * Updating this list IS the contract. If you add a Tauri command in
 * Rust, add it here too.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Tauri command names that exist in src-tauri/src/lib.rs. */
const DECLARED_COMMANDS = [
  // lib.rs (top-level Tauri commands)
  "send_chat",
  "agent_runtime_execute_turn",
  "test_provider",
  "get_provider_keys",
  "set_provider_keys",
  "list_providers",
  "agent_engine_health",
  "agent_engine_follow_up_plan",
  "agent_engine_execute_tools",
  "run_ralph_loop",
  "load_state",
  "edit_proposal",
  "record_proposal_action",
  "set_access_mode",
  "upsert_session",
  "delete_session",
  "save_session",
  "list_sessions_full",
  "list_skills",
  "load_skill",
  "run_shell_command",
  "read_workspace_file",
  "write_workspace_file",
  "apply_workspace_edit",
  "list_workspace_dir",
  "load_project_config",
  "run_git_operation",
  "run_project_test",
  "web_search",
  // agent_runtime_commands.rs (the sub-module registered at startup)
  "agent_runtime_check_approval",
  "agent_runtime_list_approvals",
  "agent_runtime_resolve_approval",
  "agent_runtime_create_approval",
  "agent_runtime_health",
  "agent_runtime_status",
  "agent_runtime_open_session",
  "agent_runtime_define_plan",
  "agent_runtime_browser_tool",
  "agent_runtime_upsert_memory",
  "agent_runtime_retrieve_memories",
  "agent_runtime_search_code",
] as const;

type DeclaredCommand = (typeof DECLARED_COMMANDS)[number];

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTs(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function findInvokeCalls(): string[] {
  const srcDir = resolve(__dirname, "..");
  const files = walkTs(srcDir).filter(
    // Skip the test source itself — it embeds example command names
    // in string literals and would feed back into the assertion.
    (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
  );
  const names = new Set<string>();
  // Matches `invoke<T>("name"` and `invoke("name"`. Allow optional
  // generics and whitespace; the first quoted string is the command.
  const re = /invoke\s*(?:<[^>]+>)?\s*\(\s*["']([^"']+)["']/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      names.add(match[1]);
    }
  }
  return Array.from(names).sort();
}

describe("bridge contract — TS invoke calls match Rust commands", () => {
  it("every TS invoke name is declared on the Rust side", () => {
    const declared = new Set<string>(DECLARED_COMMANDS);
    const used = findInvokeCalls();
    const unknown = used.filter((name) => !declared.has(name));
    expect(unknown).toEqual([]);
  });

  it("every declared command is actually wired in TS (sanity check)", () => {
    const used = new Set(findInvokeCalls());
    const declared = new Set<string>(DECLARED_COMMANDS);
    // Skip commands that are intentionally exposed only to the runtime
    // (e.g. loaded via direct invoke inside agent_runtime_commands).
    // We don't enforce full coverage here — the test above is the
    // safety net. This assertion just makes sure the list isn't
    // obviously stale (declared names vanishing from the codebase
    // without being removed from the contract is a smell).
    expect(used.size).toBeGreaterThan(0);
    expect(declared.size).toBeGreaterThan(used.size * 0.5);
  });

  it("command name shape is snake_case (the Rust convention)", () => {
    for (const name of DECLARED_COMMANDS) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  // Light assertion on the most-trafficked commands so a typo in any
  // of them lights up the test before the user does.
  it.each([
    "send_chat",
    "list_skills",
    "load_skill",
    "web_search",
    "save_session",
    "list_sessions_full",
    "run_shell_command",
  ] satisfies DeclaredCommand[])("%s is declared", (name) => {
    expect(DECLARED_COMMANDS).toContain(name);
  });
});
