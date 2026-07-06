import { describe, expect, it } from "vitest";
import { CodeGraph, buildFileOutline, detectLanguage, type SymbolKind } from "./codeGraph";

describe("detectLanguage", () => {
  it("recognises TypeScript flavours", () => {
    expect(detectLanguage("src/foo.ts")).toBe("typescript");
    expect(detectLanguage("src/foo.tsx")).toBe("typescript");
    expect(detectLanguage("src/foo.js")).toBe("typescript");
    expect(detectLanguage("src/foo.mjs")).toBe("typescript");
  });
  it("recognises Rust", () => {
    expect(detectLanguage("src/foo.rs")).toBe("rust");
  });
  it("recognises Python", () => {
    expect(detectLanguage("src/foo.py")).toBe("python");
  });
  it("returns 'unknown' for unhandled extensions", () => {
    expect(detectLanguage("src/foo.go")).toBe("unknown");
    expect(detectLanguage("src/foo.md")).toBe("unknown");
  });
});

describe("buildFileOutline (TypeScript)", () => {
  it("extracts top-level functions, classes, interfaces, types, and enums", () => {
    const source = `
export function add(a: number, b: number): number { return a + b; }
export class UserService { findById() {} }
export interface User { id: string }
export type UserId = string;
export const VERSION = "1.0";
export enum Color { Red, Green, Blue }
    `;
    const outline = buildFileOutline("src/foo.ts", source);
    expect(outline.language).toBe("typescript");
    expect(outline.outlineQuality).toBe("structural");
    const names = outline.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["Color", "User", "UserId", "UserService", "VERSION", "add"]);
    const add = outline.symbols.find((s) => s.name === "add");
    expect(add?.kind).toBe("function");
    expect(add?.line).toBe(2);
  });

  it("attaches methods to their parent class", () => {
    const source = `
export class Service {
  findOne() {}
  findAll() {}
}
    `;
    const outline = buildFileOutline("src/svc.ts", source);
    const cls = outline.symbols.find((s) => s.kind === "class");
    expect(cls).toBeDefined();
    const methods = outline.symbols.filter((s) => s.kind === "method");
    expect(methods).toHaveLength(2);
    for (const m of methods) {
      expect(m.parentId).toBe(cls?.id);
    }
  });
});

describe("buildFileOutline (Rust)", () => {
  it("extracts fn, struct, trait, enum, type, mod, and macro", () => {
    const source = `
pub fn add(a: i32, b: i32) -> i32 { a + b }
pub struct User { id: u64 }
pub trait Render { fn render(&self) -> String; }
pub enum Mode { A, B }
pub type Id = u64;
mod inner;
macro_rules! my_macro { () => {} }
    `;
    const outline = buildFileOutline("src/foo.rs", source);
    expect(outline.language).toBe("rust");
    const kinds: Record<string, number> = {};
    for (const s of outline.symbols) {
      kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    }
    expect(kinds["function"]).toBe(1);
    expect(kinds["struct"]).toBe(1);
    expect(kinds["trait"]).toBe(1);
    expect(kinds["enum"]).toBe(1);
    expect(kinds["type"]).toBe(1);
    expect(kinds["mod"]).toBe(1);
    expect(kinds["macro"]).toBe(1);
  });
});

describe("buildFileOutline (Python)", () => {
  it("extracts top-level functions, classes, and methods", () => {
    const source = `
def hello():
    pass

class Service:
    def find_one(self):
        pass
    def find_all(self):
        pass
`;
    const outline = buildFileOutline("src/svc.py", source);
    expect(outline.language).toBe("python");
    const fns = outline.symbols.filter((s) => s.kind === "function");
    const classes = outline.symbols.filter((s) => s.kind === "class");
    const methods = outline.symbols.filter((s) => s.kind === "method");
    expect(fns).toHaveLength(1);
    expect(classes).toHaveLength(1);
    expect(methods).toHaveLength(2);
  });
});

describe("buildFileOutline (unknown)", () => {
  it("returns an empty outline with heuristic quality", () => {
    const outline = buildFileOutline("src/foo.md", "# Title");
    expect(outline.language).toBe("unknown");
    expect(outline.outlineQuality).toBe("heuristic");
    expect(outline.symbols).toHaveLength(0);
  });
});

describe("CodeGraph (in-memory store)", () => {
  it("indexes and finds symbols across multiple files", () => {
    const g = new CodeGraph();
    g.indexFile("src/auth.ts", "export function validateToken(t: string) {}\nexport class AuthService {}");
    g.indexFile("src/user.ts", "export function findUser(id: string) {}\nexport class User {}");
    expect(g.fileCount()).toBe(2);
    expect(g.symbolCount()).toBe(4);

    // "find" substring-matches "findUser" only.
    const hits = g.findSymbol({ name: "find" });
    expect(hits.length).toBe(1);
    expect(hits[0].symbol.name).toBe("findUser");

    // "user" substring-matches both findUser and User.
    const userHits = g.findSymbol({ name: "user" });
    expect(userHits.length).toBe(2);
    const names = userHits.map((h) => h.symbol.name).sort();
    expect(names).toEqual(["User", "findUser"]);
  });

  it("filters by kind and file", () => {
    const g = new CodeGraph();
    g.indexFile("src/auth.ts", "export function foo() {}\nexport class Foo {}");
    g.indexFile("src/user.ts", "export function foo() {}\nexport class Foo {}");
    const onlyFns = g.findSymbol({ name: "foo", kind: "function" });
    expect(onlyFns).toHaveLength(2);
    const inAuth = g.findSymbol({ name: "foo", file: "auth.ts" });
    expect(inAuth).toHaveLength(2);
  });

  it("returns a one-line file summary suitable for the model context", () => {
    const g = new CodeGraph();
    g.indexFile("src/foo.ts", "export function add() {}\nexport class Calc {}");
    const { summary } = g.getFileSummary("src/foo.ts");
    expect(summary).toContain("src/foo.ts");
    expect(summary).toContain("function");
    expect(summary).toContain("class");
  });

  it("removes files from the index", () => {
    const g = new CodeGraph();
    g.indexFile("src/a.ts", "export function a() {}");
    expect(g.fileCount()).toBe(1);
    g.removeFile("src/a.ts");
    expect(g.fileCount()).toBe(0);
  });

  it("is case-insensitive for the name query", () => {
    const g = new CodeGraph();
    g.indexFile("src/foo.ts", "export function HelloWorld() {}");
    expect(g.findSymbol({ name: "helloworld" })).toHaveLength(1);
    expect(g.findSymbol({ name: "HELLO" })).toHaveLength(1);
  });

  it("respects the limit parameter", () => {
    const g = new CodeGraph();
    const src = Array.from({ length: 30 }, (_, i) => `export function helper_${i}() {}`).join("\n");
    g.indexFile("src/many.ts", src);
    const hits = g.findSymbol({ name: "helper", limit: 5 });
    expect(hits).toHaveLength(5);
  });

  it("returns an empty array for empty / null-ish query input", () => {
    const g = new CodeGraph();
    g.indexFile("src/foo.ts", "export function a() {}");
    expect(g.findSymbol({ name: "" })).toEqual([]);
    expect(g.findSymbol({ name: "   " })).toEqual([]);
  });

  it("getFileSummary reports when a file is not indexed", () => {
    const g = new CodeGraph();
    const { summary } = g.getFileSummary("src/unknown.ts");
    expect(summary).toContain("not indexed");
  });
});
