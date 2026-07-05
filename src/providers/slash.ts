import { useEffect, useMemo, useRef, useState } from "react";
import { listSkills, type SkillSummary } from "./skills";

/**
 * Available built-in slash commands that don't correspond to a skill.
 * Skills are listed separately because they're discovered at runtime.
 */
export interface BuiltinCommand {
  id: string;
  label: string;
  description: string;
  kind: "builtin";
}

export type SlashItem =
  | (BuiltinCommand & { kind: "builtin" })
  | (SkillSummary & { kind: "skill" });

export interface UseSlashMenuResult {
  open: boolean;
  items: SlashItem[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  /** Reset the highlighted item to 0 (call when the filter changes). */
  resetHighlight: () => void;
  /** True while the picker should appear above the composer. */
  visible: boolean;
  /** The current filter text (the part of the message after the leading `/`). */
  query: string;
  /** Pick the item at `index`. Returns the picked item or null. */
  pick: (index: number) => SlashItem | null;
}

const BUILTINS: BuiltinCommand[] = [
  {
    id: "new",
    label: "/new",
    description: "Start a new conversation. Clears the chat and attached files.",
    kind: "builtin",
  },
  {
    id: "compact",
    label: "/compact",
    description: "Compact the conversation context sent to the model.",
    kind: "builtin",
  },
  {
    id: "stop",
    label: "/stop",
    description: "Cancel any in-flight model request.",
    kind: "builtin",
  },
  {
    id: "goal",
    label: "/goal",
    description: "Set or view the active objective for this Zeus session.",
    kind: "builtin",
  },
  {
    id: "run",
    label: "/run",
    description: "Run a guarded workspace shell command. Example: /run npm test",
    kind: "builtin",
  },
  {
    id: "read",
    label: "/read",
    description: "Read a file inside the configured workspace. Example: /read package.json",
    kind: "builtin",
  },
  {
    id: "write",
    label: "/write",
    description: "Create or overwrite a workspace file. Format: /write path :: content",
    kind: "builtin",
  },
  {
    id: "edit",
    label: "/edit",
    description: "Replace text in a workspace file. Format: /edit path :: find => replace",
    kind: "builtin",
  },
];

/**
 * Detect an active slash invocation at the start of `value`. Returns the
 * filter string (without the leading `/`) when the user is mid-typing a
 * command, or `null` when no slash command is in flight.
 */
export function detectSlash(value: string): string | null {
  if (!value.startsWith("/")) return null;
  // A command must be the only thing at the start of the buffer.
  // If the user has typed anything after whitespace, they're past the slash.
  if (/\s/.test(value.slice(1))) return null;
  return value.slice(1);
}

/**
 * Hook that loads the available skills once and exposes a picker state
 * driven by `message`. Returns the list of filtered items plus keyboard
 * navigation glue the composer can call from its keyDown handler.
 */
export function useSlashMenu(message: string, isTauri: boolean): UseSlashMenuResult {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsStatus, setSkillsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [activeIndex, setActiveIndex] = useState(0);

  // Lazy-load skills on first composer mount. We don't gate the picker on
  // the Skills view like the registry page does — the user is typing in
  // the composer and we want suggestions to show up immediately.
  useEffect(() => {
    if (!isTauri || skillsStatus !== "idle") return;
    let cancelled = false;
    setSkillsStatus("loading");
    listSkills()
      .then((items) => {
        if (cancelled) return;
        setSkills(items);
        setSkillsStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setSkillsStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [isTauri, skillsStatus]);

  const query = detectSlash(message);
  const open = query !== null;
  const visible = open && skillsStatus !== "loading";

  const items = useMemo<SlashItem[]>(() => {
    if (!open) return [];
    const q = (query ?? "").toLowerCase();
    const matches = (text: string) => text.toLowerCase().includes(q);
    const filteredSkills: SlashItem[] = skills
      .filter((skill) => !q || matches(skill.id) || matches(skill.name) || matches(skill.description))
      .map((skill) => ({ ...skill, kind: "skill" }));
    const filteredBuiltins: SlashItem[] = BUILTINS.filter(
      (cmd) => !q || matches(cmd.id) || matches(cmd.description),
    );
    return [...filteredBuiltins, ...filteredSkills];
  }, [open, query, skills]);

  // Clamp the active index when the item count changes.
  const lastCount = useRef(items.length);
  useEffect(() => {
    if (items.length === 0) {
      setActiveIndex(0);
    } else if (lastCount.current !== items.length || activeIndex >= items.length) {
      setActiveIndex(0);
    }
    lastCount.current = items.length;
  }, [items.length, activeIndex]);

  function pick(index: number): SlashItem | null {
    return items[index] ?? null;
  }

  return {
    open,
    items,
    activeIndex,
    setActiveIndex,
    resetHighlight: () => setActiveIndex(0),
    visible,
    query: query ?? "",
    pick,
  };
}
