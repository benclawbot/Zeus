/**
 * Spec 06 — Code Graph / Structural Index.
 *
 * A lightweight, in-memory structural index of source files. The
 * spec calls for tree-sitter or language-native AST parsers; for the
 * v1 we ship a regex-based outline indexer that handles TypeScript,
 * Rust, and Python well enough to drive the agent's "where is X
 * defined?" questions without reading the whole file.
 *
 * Design notes:
 *   - Pure functions, no I/O. The caller passes file contents; we
 *     produce an outline. Persistence (Spec 06 §3) is layered on top
 *     by `codeGraphStore.ts`.
 *   - Symbol kinds are normalized to a small enum (function, class,
 *     interface, type, const, enum, method, struct, trait, mod,
 *     unknown).
 *   - Call edges are *not* extracted in v1 — out of scope for a
 *     regex-only implementation. The store can be extended later.
 *   - Always fails open: if a file is unparseable, we return an
 *     empty outline with `outlineQuality: "heuristic"` (Spec 06 §7).
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "const"
  | "enum"
  | "struct"
  | "trait"
  | "mod"
  | "macro"
  | "unknown";

export interface SymbolNode {
  /** Stable id: `<file>::<kind>::<name>:<line>`. */
  id: string;
  kind: SymbolKind;
  name: string;
  /** 1-indexed line number where the declaration starts. */
  line: number;
  /** Single-line signature, when extractable. */
  signature: string;
  /** Optional parent symbol id (for methods inside classes, etc.). */
  parentId?: string;
}

export type OutlineQuality = "structural" | "heuristic" | "empty";

export interface FileOutline {
  file: string;
  language: string;
  symbols: SymbolNode[];
  outlineQuality: OutlineQuality;
}

export interface CodeGraphQuery {
  /** Name to look up. Case-insensitive substring. */
  name: string;
  /** Optional kind filter, e.g. "function". */
  kind?: SymbolKind;
  /** Optional file glob, e.g. "src/auth.ts". */
  file?: string;
  /** Max results, default 25. */
  limit?: number;
}

export interface CodeGraphHit {
  symbol: SymbolNode;
  file: string;
}

/* ------------------------------------------------------------------ */
/* Language detection                                                  */
/* ------------------------------------------------------------------ */

export function detectLanguage(file: string): "typescript" | "rust" | "python" | "unknown" {
  const lower = file.toLowerCase();
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "typescript";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".py")) return "python";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Per-language outline extractors                                     */
/* ------------------------------------------------------------------ */

function extractTypescriptOutline(file: string, source: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];
  const lines = source.split("\n");

  // Track the active container stack (class/interface/function) and
  // the active brace depth. A scope pops when its block closes
  // (i.e. when brace depth drops below the depth at which it was
  // opened).
  let braceDepth = 0;
  const stack: { startDepth: number; node: SymbolNode }[] = [];
  const parentFor = (): SymbolNode | null => {
    // Walk top-down for the closest *container* (class / interface /
    // function / method). Methods are not containers of each other.
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const kind = stack[i].node.kind;
      if (kind === "class" || kind === "interface" || kind === "function" || kind === "method") {
        return stack[i].node;
      }
    }
    return null;
  };
  const popClosedScopes = () => {
    while (stack.length > 0 && stack[stack.length - 1].startDepth >= braceDepth) {
      stack.pop();
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    // Pop scopes whose block has fully closed by the time we process
    // this line. A scope is "closed" when the brace depth drops below
    // its own start depth. We use `>` (not `>=`) so a scope whose
    // start depth equals the current depth is still considered open.
    const openCount = (line.match(/\{/g) || []).length;
    const closeCount = (line.match(/\}/g) || []).length;
    const depthAfter = braceDepth + openCount - closeCount;
    while (stack.length > 0 && stack[stack.length - 1].startDepth > depthAfter) {
      stack.pop();
    }

    // method shorthand inside a class: name(...): ReturnType { or name(...) {
    // Check this BEFORE the top-level declarations so indented methods
    // are detected even when the class line and method line are the
    // same line (rare but possible).
    let m = /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+|abstract\s+|override\s+)*([A-Za-z_$][\w$]*)\s*(<[^>]*>)?\s*\(/.exec(line);
    if (m && m[1] !== "if" && m[1] !== "for" && m[1] !== "while" && m[1] !== "switch" && m[1] !== "return") {
      const parent = parentFor();
      if (parent && (parent.kind === "class" || parent.kind === "interface")) {
        const node: SymbolNode = {
          id: `${file}::method::${m[1]}:${lineNo}`,
          kind: "method",
          name: m[1],
          line: lineNo,
          signature: line.trim().replace(/\s*\{.*$/, ""),
          parentId: parent.id,
        };
        symbols.push(node);
        // Methods are NOT pushed to the container stack — sibling
        // methods on subsequent lines need to find the *class* as
        // their parent, not the previous method.
        braceDepth = depthAfter;
        continue;
      }
    }

    // export function name(...) or function name(...)
    m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(<[^>]*>)?\s*\(/.exec(line);
    if (m) {
      const parent = parentFor();
      const node: SymbolNode = {
        id: `${file}::function::${m[1]}:${lineNo}`,
        kind: "function",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
        parentId: parent?.id,
      };
      symbols.push(node);
      if (openCount > 0) stack.push({ startDepth: depthAfter, node });
      braceDepth = depthAfter;
      continue;
    }

    // const name = <anything>
    m = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?\s*=\s*\S/.exec(line);
    if (m) {
      const parent = parentFor();
      const node: SymbolNode = {
        id: `${file}::const::${m[1]}:${lineNo}`,
        kind: "const",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
        parentId: parent?.id,
      };
      symbols.push(node);
      if (openCount > 0) stack.push({ startDepth: depthAfter, node });
      braceDepth = depthAfter;
      continue;
    }

    // class Name (extends / implements) {
    m = /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) {
      const parent = parentFor();
      const node: SymbolNode = {
        id: `${file}::class::${m[1]}:${lineNo}`,
        kind: "class",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
        parentId: parent?.id,
      };
      symbols.push(node);
      if (openCount > 0) stack.push({ startDepth: depthAfter, node });
      braceDepth = depthAfter;
      continue;
    }

    // interface Name {
    m = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) {
      const parent = parentFor();
      const node: SymbolNode = {
        id: `${file}::interface::${m[1]}:${lineNo}`,
        kind: "interface",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
        parentId: parent?.id,
      };
      symbols.push(node);
      if (openCount > 0) stack.push({ startDepth: depthAfter, node });
      braceDepth = depthAfter;
      continue;
    }

    // type Name = ...
    m = /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (m) {
      const parent = parentFor();
      const node: SymbolNode = {
        id: `${file}::type::${m[1]}:${lineNo}`,
        kind: "type",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
        parentId: parent?.id,
      };
      symbols.push(node);
      // Type aliases can hold object types with braces.
      if (openCount > 0) stack.push({ startDepth: depthAfter, node });
      braceDepth = depthAfter;
      continue;
    }

    // enum Name {
    m = /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (m) {
      const parent = parentFor();
      const node: SymbolNode = {
        id: `${file}::enum::${m[1]}:${lineNo}`,
        kind: "enum",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
        parentId: parent?.id,
      };
      symbols.push(node);
      if (openCount > 0) stack.push({ startDepth: depthAfter, node });
      braceDepth = depthAfter;
      continue;
    }

    braceDepth = depthAfter;
  }
  return symbols;
}

function extractRustOutline(file: string, source: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;

    // pub fn name(...)
    let m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+|extern\s+(?:"[^"]+"\s+)?)*fn\s+([A-Za-z_][\w]*)\s*(?:<[^>]*>)?\s*\(/.exec(line);
    if (m) {
      symbols.push({
        id: `${file}::function::${m[1]}:${lineNo}`,
        kind: "function",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, "").replace(/\s*->.*$/, (s) => s),
      });
      continue;
    }

    // pub struct Name
    m = /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/.exec(line);
    if (m) {
      symbols.push({
        id: `${file}::struct::${m[1]}:${lineNo}`,
        kind: "struct",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
      });
      continue;
    }

    // pub trait Name
    m = /^\s*(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/.exec(line);
    if (m) {
      symbols.push({
        id: `${file}::trait::${m[1]}:${lineNo}`,
        kind: "trait",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
      });
      continue;
    }

    // pub enum Name
    m = /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/.exec(line);
    if (m) {
      symbols.push({
        id: `${file}::enum::${m[1]}:${lineNo}`,
        kind: "enum",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
      });
      continue;
    }

    // type Name = ...
    m = /^\s*(?:pub\s+)?type\s+([A-Za-z_][\w]*)\s*=/.exec(line);
    if (m) {
      symbols.push({
        id: `${file}::type::${m[1]}:${lineNo}`,
        kind: "type",
        name: m[1],
        line: lineNo,
        signature: line.trim().replace(/\s*\{.*$/, ""),
      });
      continue;
    }

    // mod name;
    m = /^\s*(?:pub\s+)?mod\s+([A-Za-z_][\w]*)/.exec(line);
    if (m) {
      symbols.push({
        id: `${file}::mod::${m[1]}:${lineNo}`,
        kind: "mod",
        name: m[1],
        line: lineNo,
        signature: line.trim(),
      });
      continue;
    }

    // macro_rules! name
    m = /^\s*(?:macro_rules!\s+|pub\s+macro\s+)([A-Za-z_][\w!]*)/.exec(line);
    if (m) {
      symbols.push({
        id: `${file}::macro::${m[1]}:${lineNo}`,
        kind: "macro",
        name: m[1],
        line: lineNo,
        signature: line.trim(),
      });
      continue;
    }
  }
  return symbols;
}

function extractPythonOutline(file: string, source: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];
  const lines = source.split("\n");

  // For Python, track indentation to attach defs to their enclosing class.
  const stack: { indent: number; node: SymbolNode }[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    const indentMatch = /^(\s*)/.exec(line);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const trimmed = line.trim();

    // Pop entries from the stack whose indent is >= the current line's.
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    // def name(...):
    let m = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(trimmed);
    if (m) {
      const node: SymbolNode = {
        id: `${file}::function::${m[1]}:${lineNo}`,
        kind: stack.length > 0 && stack[stack.length - 1].node.kind === "class" ? "method" : "function",
        name: m[1],
        line: lineNo,
        signature: trimmed.replace(/^def\s+/, "def ").replace(/\).*$/, ")"),
      };
      if (stack.length > 0) node.parentId = stack[stack.length - 1].node.id;
      symbols.push(node);
      stack.push({ indent, node });
      continue;
    }

    // class Name(.../bases):
    m = /^class\s+([A-Za-z_][\w]*)/.exec(trimmed);
    if (m) {
      const node: SymbolNode = {
        id: `${file}::class::${m[1]}:${lineNo}`,
        kind: "class",
        name: m[1],
        line: lineNo,
        signature: trimmed,
      };
      if (stack.length > 0) node.parentId = stack[stack.length - 1].node.id;
      symbols.push(node);
      stack.push({ indent, node });
      continue;
    }
  }
  return symbols;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Compute the structural outline of a single file. Returns an empty
 * outline with `outlineQuality: "empty"` for unsupported languages —
 * the caller (and the model) can then decide to fall back to a full
 * read.
 */
export function buildFileOutline(file: string, source: string): FileOutline {
  const language = detectLanguage(file);
  let symbols: SymbolNode[] = [];
  let quality: OutlineQuality = "empty";
  if (language === "typescript") {
    symbols = extractTypescriptOutline(file, source);
    quality = symbols.length > 0 ? "structural" : "heuristic";
  } else if (language === "rust") {
    symbols = extractRustOutline(file, source);
    quality = symbols.length > 0 ? "structural" : "heuristic";
  } else if (language === "python") {
    symbols = extractPythonOutline(file, source);
    quality = symbols.length > 0 ? "structural" : "heuristic";
  } else {
    quality = "heuristic";
  }
  return { file, language, symbols, outlineQuality: quality };
}

/* ------------------------------------------------------------------ */
/* In-memory store + query                                             */
/* ------------------------------------------------------------------ */

export class CodeGraph {
  private outlines = new Map<string, FileOutline>();

  /** Index a file's source. Re-indexing replaces the previous entry. */
  indexFile(file: string, source: string): FileOutline {
    const outline = buildFileOutline(file, source);
    this.outlines.set(file, outline);
    return outline;
  }

  /** Drop a file from the index (called when a file is deleted). */
  removeFile(file: string): void {
    this.outlines.delete(file);
  }

  /** Total symbol count, for status / metrics. */
  symbolCount(): number {
    let total = 0;
    for (const outline of this.outlines.values()) total += outline.symbols.length;
    return total;
  }

  /** Total indexed file count. */
  fileCount(): number {
    return this.outlines.size;
  }

  /** Get the outline for a specific file. */
  getOutline(file: string): FileOutline | null {
    return this.outlines.get(file) ?? null;
  }

  /**
   * Find symbols by name (case-insensitive substring). Optional kind
   * and file filters narrow the result set.
   */
  findSymbol(query: CodeGraphQuery): CodeGraphHit[] {
    const name = query.name.trim().toLowerCase();
    if (!name) return [];
    const limit = query.limit ?? 25;
    const out: CodeGraphHit[] = [];
    for (const [file, outline] of this.outlines) {
      if (query.file && !file.includes(query.file)) continue;
      for (const sym of outline.symbols) {
        if (query.kind && sym.kind !== query.kind) continue;
        if (!sym.name.toLowerCase().includes(name)) continue;
        out.push({ symbol: sym, file });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /**
   * List the signatures of a file's symbols. Returns
   * `{ outline, summary }` where `summary` is a one-line text
   * representation suitable for stuffing into the model context.
   */
  getFileSummary(file: string): { outline: FileOutline | null; summary: string } {
    const outline = this.outlines.get(file) ?? null;
    if (!outline) return { outline: null, summary: `(not indexed: ${file})` };
    if (outline.symbols.length === 0) {
      return { outline, summary: `(${outline.language} file, no symbols extracted — fallback to full read)` };
    }
    const lines = outline.symbols.map((s) => {
      const parent = s.parentId ? ` (in ${s.parentId.split("::")[1] ?? "parent"})` : "";
      return `  L${String(s.line).padStart(4, " ")}  ${s.kind.padEnd(9, " ")}  ${s.signature}${parent}`;
    });
    return { outline, summary: `${file} (${outline.language}, ${outline.symbols.length} symbols)\n${lines.join("\n")}` };
  }
}
