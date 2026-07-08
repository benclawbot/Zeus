import { useEffect, useMemo, useRef, useState } from "react";
import { listSkills, type SkillSummary } from "./skills";

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
  resetHighlight: () => void;
  visible: boolean;
  query: string;
  pick: (index: number) => SlashItem | null;
}

const BUILTINS: BuiltinCommand[] = [
  { id: "new", label: "/new", description: "Start a new conversation. Clears the chat and attached files.", kind: "builtin" },
  { id: "compact", label: "/compact", description: "Compact the conversation context sent to the model.", kind: "builtin" },
  { id: "stop", label: "/stop", description: "Cancel any in-flight model request.", kind: "builtin" },
  { id: "goal", label: "/goal", description: "Set or view the active objective for this Zeus session.", kind: "builtin" },
  { id: "run", label: "/run", description: "Run a guarded workspace shell command. Example: /run npm test", kind: "builtin" },
  { id: "read", label: "/read", description: "Read a file inside the configured workspace. Example: /read package.json", kind: "builtin" },
  { id: "write", label: "/write", description: "Create or overwrite a workspace file. Format: /write path :: content", kind: "builtin" },
  { id: "edit", label: "/edit", description: "Replace text in a workspace file. Format: /edit path :: find => replace", kind: "builtin" },
  { id: "ls", label: "/ls", description: "List a workspace directory. Example: /ls src", kind: "builtin" },
  { id: "config", label: "/config", description: "Load project config before planning changes.", kind: "builtin" },
  { id: "test", label: "/test", description: "Run the project's test suite. Example: /test --testPathPattern=foo", kind: "builtin" },
  { id: "git", label: "/git", description: "Run a guarded git subcommand. Example: /git status, /git diff, /git commit -m msg", kind: "builtin" },
  { id: "search", label: "/search", description: "Run a configured public research query before planning changes.", kind: "builtin" },
  { id: "playwright", label: "/playwright", description: "Run headed or headless browser checks for generated UI work.", kind: "builtin" },
  { id: "ralph", label: "/ralph", description: "Run an autonomous Ralph loop until the model emits the completion marker or the iteration cap is reached. Example: /ralph build me an HTML page that explains prompt caching.", kind: "builtin" },
  { id: "artifact", label: "/artifact", description: "Materialize a standalone file artifact at the given path. Example: /artifact path=coding-agents.html <<< then paste the body and end with <<<END on its own line.", kind: "builtin" },
];

export function detectSlash(value: string): string | null {
  if (!value.startsWith("/")) return null;
  if (/\s/.test(value.slice(1))) return null;
  return value.slice(1);
}

export function useSlashMenu(message: string, isTauri: boolean): UseSlashMenuResult {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillsStatus, setSkillsStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [activeIndex, setActiveIndex] = useState(0);

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
    const matchesCommand = (id: string, description: string) => !q || id.toLowerCase().startsWith(q) || description.toLowerCase().includes(q);
    const matchesSkill = (skill: SkillSummary) => {
      const id = skill.id.toLowerCase();
      const name = skill.name.toLowerCase();
      const description = skill.description.toLowerCase();
      return !q || id.startsWith(q) || name.startsWith(q) || description.includes(q);
    };
    const filteredBuiltins: SlashItem[] = BUILTINS.filter((cmd) => matchesCommand(cmd.id, cmd.description));
    const filteredSkills: SlashItem[] = skills.filter(matchesSkill).map((skill) => ({ ...skill, kind: "skill" }));
    return [...filteredBuiltins, ...filteredSkills];
  }, [open, query, skills]);

  const lastCount = useRef(items.length);
  useEffect(() => {
    lastCount.current = items.length;
    if (items.length === 0) {
      if (activeIndex !== 0) setActiveIndex(0);
    } else if (activeIndex >= items.length) {
      setActiveIndex(0);
    }
  }, [items.length, activeIndex]);

  function pick(index: number): SlashItem | null {
    return items[index] ?? null;
  }

  return {
    open,
    items,
    activeIndex,
    setActiveIndex: (index: number) => {
      if (items.length === 0) { setActiveIndex(0); return; }
      const normalized = ((index % items.length) + items.length) % items.length;
      setActiveIndex(normalized);
    },
    resetHighlight: () => setActiveIndex(0),
    visible,
    query: query ?? "",
    pick,
  };
}
