// Code intelligence layer: symbol index, dependency graph, and test-impact
// analysis. Lives alongside the workspace so the runtime can hand the
// model useful search hits instead of raw text matches. The parser is
// deliberately regex-based — we don't need a real Rust/TS parser to
// answer "what functions does this file define" or "which test files
// should I re-run when src/foo.ts changes".

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SymbolKind {
    Function,
    Struct,
    Class,
    Interface,
    Enum,
    Variable,
    Constant,
    Module,
    Test,
}

impl SymbolKind {
    pub fn label(self) -> &'static str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::Struct => "struct",
            SymbolKind::Class => "class",
            SymbolKind::Interface => "interface",
            SymbolKind::Enum => "enum",
            SymbolKind::Variable => "variable",
            SymbolKind::Constant => "constant",
            SymbolKind::Module => "module",
            SymbolKind::Test => "test",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SymbolHit {
    pub path: String,
    pub line: usize,
    pub symbol: String,
    pub kind: String,
    pub snippet: String,
    pub score: u32,
    pub already_read: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchHit {
    pub path: String,
    pub line: usize,
    pub snippet: String,
    pub symbol: Option<String>,
    pub kind: Option<String>,
    pub score: u32,
    pub already_read: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestImpact {
    pub source_files: Vec<String>,
    pub suggested_test_files: Vec<String>,
    pub test_command: Option<String>,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyNode {
    pub path: String,
    pub kind: String, // "package" | "module" | "crate"
    pub depends_on: Vec<String>,
}

/// Build a symbol index for `root`. Walks every text file under `root`
/// (skipping build outputs, vendored trees, and dotfile dirs) and extracts
/// function/struct/class/enum/etc. declarations.
pub fn build_symbol_index(root: &Path) -> Result<Vec<SymbolHit>, String> {
    let mut hits = Vec::new();
    visit_for_symbols(root, root, &mut hits)?;
    Ok(hits)
}

fn visit_for_symbols(root: &Path, dir: &Path, hits: &mut Vec<SymbolHit>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_dir(&name) {
            continue;
        }
        if path.is_dir() {
            visit_for_symbols(root, &path, hits)?;
        } else if path.is_file() && is_text_candidate(&path) {
            extract_symbols_from_file(root, &path, hits)?;
        }
    }
    Ok(())
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "out"
            | ".next"
            | ".turbo"
            | "coverage"
            | ".cache"
            | ".venv"
            | "venv"
            | "__pycache__"
    )
}

fn is_text_candidate(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).unwrap_or(""),
        "rs" | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "mjs"
            | "cjs"
            | "json"
            | "md"
            | "toml"
            | "css"
            | "html"
            | "py"
            | "go"
            | "java"
            | "kt"
            | "swift"
            | "cpp"
            | "c"
            | "h"
    )
}

/// Parse a single file and append every recognized symbol declaration.
pub fn extract_symbols_from_file(
    root: &Path,
    path: &Path,
    hits: &mut Vec<SymbolHit>,
) -> Result<(), String> {
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let raw = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    for (idx, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        for parsed in parse_symbol_line(trimmed, ext) {
            hits.push(SymbolHit {
                path: rel.clone(),
                line: idx + 1,
                symbol: parsed.name,
                kind: parsed.kind.label().to_string(),
                snippet: trimmed.chars().take(200).collect(),
                score: 0,
                already_read: false,
            });
        }
    }
    Ok(())
}

struct ParsedSymbol {
    name: String,
    kind: SymbolKind,
}

fn parse_symbol_line(line: &str, ext: &str) -> Vec<ParsedSymbol> {
    let mut out = Vec::new();
    if line.is_empty() || line.starts_with("//") || line.starts_with('#') || line.starts_with('*') {
        return out;
    }
    // Rust
    if ext == "rs" {
        if let Some(rest) = strip_any(line, &["pub fn ", "async fn ", "fn "]) {
            out.push(symbol_after(rest, SymbolKind::Function, "<("));
        }
        if let Some(rest) = strip_any(line, &["pub struct ", "struct "]) {
            out.push(symbol_after(rest, SymbolKind::Struct, "< {"));
        }
        if let Some(rest) = strip_any(line, &["pub enum ", "enum "]) {
            out.push(symbol_after(rest, SymbolKind::Enum, " {"));
        }
        if let Some(rest) = strip_any(line, &["pub trait ", "trait "]) {
            out.push(symbol_after(rest, SymbolKind::Interface, " {"));
        }
        if let Some(rest) = strip_any(line, &["impl "]) {
            if let Some(name) = take_token_before(rest, "< {") {
                out.push(ParsedSymbol {
                    name: name.to_string(),
                    kind: SymbolKind::Module,
                });
            }
        }
        if line.contains("#[test]") || line.contains("#[") && line.contains("test") {
            // tests are recorded at the fn level by the function rule above.
        }
        if let Some(rest) = strip_any(line, &["pub const ", "const ", "pub static ", "static "]) {
            out.push(symbol_after(rest, SymbolKind::Constant, ": = ;"));
        }
    }
    // TypeScript / JavaScript
    if matches!(ext, "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs") {
        if let Some(rest) = strip_any(
            line,
            &[
                "export function ",
                "export async function ",
                "function ",
                "async function ",
            ],
        ) {
            out.push(symbol_after(rest, SymbolKind::Function, "<({"));
        }
        if let Some(rest) = strip_any(line, &["export class ", "class "]) {
            out.push(symbol_after(rest, SymbolKind::Class, " {"));
        }
        if let Some(rest) = strip_any(line, &["export interface ", "interface "]) {
            out.push(symbol_after(rest, SymbolKind::Interface, " {"));
        }
        if let Some(rest) = strip_any(line, &["export type ", "type "]) {
            out.push(symbol_after(rest, SymbolKind::Interface, " = ;"));
        }
        if let Some(rest) = strip_any(line, &["export const ", "const ", "let ", "var "]) {
            out.push(symbol_after(rest, SymbolKind::Variable, "=:"));
        }
    }
    // Python
    if ext == "py" {
        if let Some(rest) = strip_any(line, &["def ", "async def "]) {
            let kind = if rest.starts_with("test_") || rest.contains("test_") {
                SymbolKind::Test
            } else {
                SymbolKind::Function
            };
            out.push(symbol_after(rest, kind, "(:"));
        }
        if let Some(rest) = strip_any(line, &["class "]) {
            out.push(symbol_after(rest, SymbolKind::Class, "(:"));
        }
    }
    // Go
    if ext == "go" {
        if let Some(rest) = strip_any(line, &["func "]) {
            out.push(symbol_after(rest, SymbolKind::Function, "({"));
        }
        if let Some(rest) = strip_any(line, &["type "]) {
            out.push(symbol_after(rest, SymbolKind::Struct, " {"));
        }
    }
    out
}

fn strip_any<'a>(line: &'a str, prefixes: &[&str]) -> Option<&'a str> {
    for prefix in prefixes {
        if let Some(rest) = line.strip_prefix(prefix) {
            return Some(rest);
        }
    }
    None
}

fn take_token_before<'a>(line: &'a str, terminators: &str) -> Option<&'a str> {
    let trimmed = line.trim_start();
    let end = trimmed
        .find(|c: char| terminators.contains(c))
        .unwrap_or(trimmed.len());
    let token = trimmed[..end].trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn symbol_after(line: &str, kind: SymbolKind, terminators: &str) -> ParsedSymbol {
    let token = take_token_before(line, terminators).unwrap_or("").trim();
    ParsedSymbol {
        name: token.to_string(),
        kind,
    }
}

/// Score and rank search hits. Returns at most `max_results` entries,
/// sorted by descending score. Already-read files get a small penalty so
/// the model surfaces new context first.
pub fn search_symbols(
    index: &[SymbolHit],
    query: &str,
    seen: &HashSet<String>,
    max_results: usize,
) -> Vec<CodeSearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<CodeSearchHit> = index
        .iter()
        .filter(|s| !s.symbol.is_empty())
        .map(|s| {
            let sym = s.symbol.to_lowercase();
            let snippet = s.snippet.to_lowercase();
            let mut score = 0u32;
            if sym == q {
                score += 60;
            } else if sym.contains(&q) {
                score += 30;
            }
            if snippet.contains(&q) {
                score += 10;
            }
            // Token overlap bonus.
            let q_tokens: HashSet<&str> = q
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|t| t.len() > 2)
                .collect();
            let s_tokens: HashSet<&str> = sym
                .split(|c: char| !c.is_ascii_alphanumeric())
                .filter(|t| t.len() > 2)
                .collect();
            score += (q_tokens.intersection(&s_tokens).count() as u32) * 5;
            // Kind-based preference: function/class/struct > tests > variables.
            score += match s.kind.as_str() {
                "function" | "struct" | "class" | "interface" | "enum" => 3,
                "test" => 2,
                _ => 1,
            };
            if seen.contains(&s.path) {
                score = score.saturating_sub(2);
            }
            CodeSearchHit {
                path: s.path.clone(),
                line: s.line,
                snippet: s.snippet.clone(),
                symbol: Some(s.symbol.clone()),
                kind: Some(s.kind.clone()),
                score,
                already_read: seen.contains(&s.path),
            }
        })
        .filter(|h| h.score > 0)
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.path.cmp(&b.path))
            .then(a.line.cmp(&b.line))
    });
    scored.truncate(max_results.max(1));
    scored
}

/// Search the index by raw substring — useful when the query is a token
/// that's likely to appear as a substring (e.g. "AgentRunRequest"). The
/// symbol-aware search above is preferred when the query looks like an
/// identifier, but raw-text fallback catches the rest.
pub fn search_substring(
    index: &[SymbolHit],
    query: &str,
    seen: &HashSet<String>,
    max_results: usize,
) -> Vec<CodeSearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<CodeSearchHit> = index
        .iter()
        .filter(|s| s.snippet.to_lowercase().contains(&q))
        .map(|s| CodeSearchHit {
            path: s.path.clone(),
            line: s.line,
            snippet: s.snippet.clone(),
            symbol: Some(s.symbol.clone()),
            kind: Some(s.kind.clone()),
            score: if seen.contains(&s.path) { 1 } else { 2 },
            already_read: seen.contains(&s.path),
        })
        .collect();
    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.path.cmp(&b.path))
            .then(a.line.cmp(&b.line))
    });
    hits.truncate(max_results.max(1));
    hits
}

/// Build a small dependency graph for the workspace. Parses
/// `package.json`, `Cargo.toml`, and bare `import` / `use` statements to
/// discover what depends on what. Returns at most a few hundred edges.
pub fn build_dependency_graph(root: &Path) -> Result<Vec<DependencyNode>, String> {
    let mut nodes: BTreeMap<String, DependencyNode> = BTreeMap::new();
    if root.join("package.json").is_file() {
        parse_package_json(root, &mut nodes)?;
    }
    if root.join("Cargo.toml").is_file() {
        parse_cargo_toml(root, &mut nodes)?;
    }
    // import/use edges from source files.
    for entry in walk_source(root) {
        let path = entry;
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let raw = match fs::read_to_string(&path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for imp in extract_imports(&raw, &rel) {
            let entry = nodes.entry(rel.clone()).or_insert_with(|| DependencyNode {
                path: rel.clone(),
                kind: if rel.starts_with("src/") {
                    "module".to_string()
                } else {
                    "file".to_string()
                },
                depends_on: Vec::new(),
            });
            if !entry.depends_on.contains(&imp) {
                entry.depends_on.push(imp);
            }
        }
    }
    Ok(nodes.into_values().collect())
}

fn parse_package_json(
    root: &Path,
    nodes: &mut BTreeMap<String, DependencyNode>,
) -> Result<(), String> {
    let raw = fs::read_to_string(root.join("package.json"))
        .map_err(|e| format!("read package.json: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse package.json: {e}"))?;
    let mut deps = BTreeSet::new();
    if let Some(obj) = value.get("dependencies").and_then(|v| v.as_object()) {
        for key in obj.keys() {
            deps.insert(key.clone());
        }
    }
    if let Some(obj) = value.get("devDependencies").and_then(|v| v.as_object()) {
        for key in obj.keys() {
            deps.insert(key.clone());
        }
    }
    if let Some(obj) = value.get("peerDependencies").and_then(|v| v.as_object()) {
        for key in obj.keys() {
            deps.insert(key.clone());
        }
    }
    nodes.insert(
        "package.json".to_string(),
        DependencyNode {
            path: "package.json".to_string(),
            kind: "package".to_string(),
            depends_on: deps.into_iter().collect(),
        },
    );
    Ok(())
}

fn parse_cargo_toml(
    root: &Path,
    nodes: &mut BTreeMap<String, DependencyNode>,
) -> Result<(), String> {
    let raw =
        fs::read_to_string(root.join("Cargo.toml")).map_err(|e| format!("read Cargo.toml: {e}"))?;
    let mut deps = BTreeSet::new();
    let mut in_deps = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_deps = trimmed == "[dependencies]"
                || trimmed == "[dev-dependencies]"
                || trimmed == "[build-dependencies]";
            continue;
        }
        if !in_deps {
            continue;
        }
        if let Some((name, _)) = trimmed.split_once('=') {
            let name = name.trim().trim_matches('"').trim_matches('\'');
            if name.is_empty()
                || !name
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_alphabetic())
                    .unwrap_or(false)
            {
                continue;
            }
            deps.insert(name.to_string());
        }
    }
    nodes.insert(
        "Cargo.toml".to_string(),
        DependencyNode {
            path: "Cargo.toml".to_string(),
            kind: "crate".to_string(),
            depends_on: deps.into_iter().collect(),
        },
    );
    Ok(())
}

fn extract_imports(raw: &str, rel: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        // Rust `use foo::bar;` / `use foo::bar::{...};`
        if trimmed.starts_with("use ") {
            let rest = trimmed.trim_start_matches("use ").trim_end_matches(';');
            // take the leading path
            let path = rest.split(['{', ' ', ':']).next().unwrap_or("");
            if !path.is_empty() {
                out.insert(path.to_string());
            }
            continue;
        }
        // TS/JS `import x from 'y'`, `import 'y'`, `export ... from 'y'`
        if trimmed.starts_with("import ")
            || trimmed.starts_with("export ") && trimmed.contains(" from ")
        {
            if let Some(idx) = trimmed.rfind("from ") {
                let after = trimmed[idx + 5..]
                    .trim()
                    .trim_matches(|c: char| c == '\'' || c == '"' || c == ';');
                out.insert(after.to_string());
            } else {
                // `import 'side-effect-only'`
                let token = trimmed
                    .split_whitespace()
                    .find_map(|w| w.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
                    .or_else(|| {
                        trimmed
                            .split_whitespace()
                            .find_map(|w| w.strip_prefix('"').and_then(|s| s.strip_suffix('"')))
                    });
                if let Some(t) = token {
                    out.insert(t.to_string());
                }
            }
            continue;
        }
        // Python `import x`, `from x import y`.
        if trimmed.starts_with("import ") || trimmed.starts_with("from ") {
            let token = trimmed
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .trim_end_matches(',');
            if !token.is_empty() {
                out.insert(token.to_string());
            }
            continue;
        }
        // Go `import "x"`.
        if trimmed.starts_with("import ") || trimmed.starts_with("\"") {
            let token = trimmed
                .trim_start_matches("import ")
                .trim_matches('"')
                .trim_matches('`');
            if !token.is_empty() && !token.contains(' ') {
                out.insert(token.to_string());
            }
        }
        let _ = rel;
    }
    out.into_iter().collect()
}

fn walk_source(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_source_inner(root, &mut out);
    out
}

fn walk_source_inner(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if should_skip_dir(&name) {
            continue;
        }
        if path.is_dir() {
            walk_source_inner(&path, out);
        } else if path.is_file()
            && matches!(
                path.extension().and_then(|e| e.to_str()).unwrap_or(""),
                "rs" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "go"
            )
        {
            out.push(path);
        }
    }
}

/// Determine which test files should be re-run when the given source
/// files change. Heuristic: same name with `.test.` or `.spec.`
/// inserted before the extension, plus co-located `tests/` directories,
/// plus any package test command we recognize.
pub fn suggest_tests(root: &Path, source_files: &[String]) -> TestImpact {
    let mut suggested: BTreeSet<String> = BTreeSet::new();
    let mut matched = Vec::new();
    for src in source_files {
        let stem = Path::new(src)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        let ext = Path::new(src)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if stem.is_empty() {
            continue;
        }
        let candidates = [
            format!("{stem}.test.{ext}"),
            format!("{stem}.spec.{ext}"),
            format!("{stem}_test.{ext}"),
            format!("{stem}.tests.{ext}"),
        ];
        let mut hit = false;
        for cand in candidates {
            let candidate_path = Path::new(src).parent().map(|p| p.join(&cand));
            if let Some(p) = candidate_path {
                if root.join(&p).is_file() {
                    suggested.insert(p.to_string_lossy().replace('\\', "/"));
                    hit = true;
                }
            }
        }
        // Co-located tests/ directory.
        if let Some(parent) = Path::new(src).parent() {
            let tests_dir = parent.join("tests");
            if root.join(&tests_dir).is_dir() {
                if let Ok(entries) = fs::read_dir(root.join(&tests_dir)) {
                    for entry in entries.flatten() {
                        if entry.path().is_file() {
                            let rel = entry
                                .path()
                                .strip_prefix(root)
                                .unwrap_or(&entry.path())
                                .to_string_lossy()
                                .replace('\\', "/");
                            suggested.insert(rel);
                            hit = true;
                        }
                    }
                }
            }
        }
        if hit {
            matched.push(src.clone());
        }
    }
    // Always include the workspace's full test file set as a last resort.
    if suggested.is_empty() {
        if root.join("package.json").is_file() {
            suggested.insert("(run npm test)".to_string());
        } else if root.join("Cargo.toml").is_file() {
            suggested.insert("(run cargo test)".to_string());
        }
    }
    let test_command = if root.join("package.json").is_file() {
        Some("npm test".to_string())
    } else if root.join("Cargo.toml").is_file() {
        Some("cargo test --no-fail-fast".to_string())
    } else if root.join("pyproject.toml").is_file() || root.join("pytest.ini").is_file() {
        Some("python -m pytest -q".to_string())
    } else if root.join("go.mod").is_file() {
        Some("go test ./...".to_string())
    } else {
        None
    };
    let reasoning = if matched.is_empty() {
        "No co-located test files matched; running the package's full test command is the safest fallback.".to_string()
    } else {
        format!(
            "Touched source files: {}. Mapped to co-located test files and tests/ directories.",
            matched.join(", ")
        )
    };
    TestImpact {
        source_files: source_files.to_vec(),
        suggested_test_files: suggested.into_iter().collect(),
        test_command,
        reasoning,
    }
}

/// In-memory cache so repeated calls to `agent_runtime_search_code` don't
/// re-walk the whole repo. The cache is invalidated when the workspace
/// root is replaced (per-process; the runtime service owns one of these).
#[derive(Default)]
pub struct SymbolCache {
    pub root: Option<PathBuf>,
    pub index: Vec<SymbolHit>,
    pub graph: Vec<DependencyNode>,
}

impl SymbolCache {
    pub fn refresh(&mut self, root: &Path) -> Result<(), String> {
        self.root = Some(root.to_path_buf());
        self.index = build_symbol_index(root)?;
        self.graph = build_dependency_graph(root)?;
        Ok(())
    }

    pub fn ensure(&mut self, root: &Path) -> Result<(), String> {
        match &self.root {
            Some(cached) if cached == root => Ok(()),
            _ => self.refresh(root),
        }
    }
}

/// Convenience wrapper: run a search over the cached index and return
/// ranked hits.
pub fn search(
    index: &[SymbolHit],
    query: &str,
    seen: &HashSet<String>,
    max_results: usize,
) -> Vec<CodeSearchHit> {
    let mut hits = search_symbols(index, query, seen, max_results);
    if hits.len() < max_results {
        let extra = search_substring(index, query, seen, max_results);
        let existing: HashSet<(String, usize)> =
            hits.iter().map(|h| (h.path.clone(), h.line)).collect();
        for hit in extra {
            if !existing.contains(&(hit.path.clone(), hit.line)) {
                hits.push(hit);
                if hits.len() >= max_results {
                    break;
                }
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_workspace() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zeus_ci_{}_{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extracts_rust_symbols() {
        let dir = temp_workspace();
        let mut f = fs::File::create(dir.join("foo.rs")).unwrap();
        writeln!(
            f,
            "pub fn run_agent_task() {{}}\npub struct AgentRunRequest {{ x: u32 }}\n"
        )
        .unwrap();
        let mut hits = Vec::new();
        extract_symbols_from_file(&dir, &dir.join("foo.rs"), &mut hits).unwrap();
        let names: Vec<_> = hits.iter().map(|h| h.symbol.as_str()).collect();
        assert!(names.contains(&"run_agent_task"));
        assert!(names.contains(&"AgentRunRequest"));
    }

    #[test]
    fn extracts_ts_symbols_and_searches_them() {
        let dir = temp_workspace();
        fs::create_dir_all(dir.join("src")).unwrap();
        let mut f = fs::File::create(dir.join("src").join("app.ts")).unwrap();
        writeln!(
            f,
            "export function runAgentTask() {{}}\nexport class AgentRunResult {{}}\n"
        )
        .unwrap();
        let index = build_symbol_index(&dir).unwrap();
        let seen = HashSet::new();
        let hits = search(&index, "runAgentTask", &seen, 10);
        assert!(!hits.is_empty());
        assert_eq!(hits[0].symbol.as_deref(), Some("runAgentTask"));
    }

    #[test]
    fn suggests_co_located_tests() {
        let dir = temp_workspace();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("package.json"), "{}").unwrap();
        fs::write(dir.join("src").join("foo.ts"), "export const x = 1;\n").unwrap();
        fs::write(
            dir.join("src").join("foo.test.ts"),
            "test('x', () => {});\n",
        )
        .unwrap();
        let impact = suggest_tests(&dir, &["src/foo.ts".to_string()]);
        assert!(impact
            .suggested_test_files
            .iter()
            .any(|p| p.contains("foo.test.ts")));
        assert_eq!(impact.test_command.as_deref(), Some("npm test"));
    }
}
