import React from "react";

// Adapted from the user's MarkdownRenderer.jsx — same parser/structure but
// rendered with the Zeus design-token classes (.chat-md *) instead of
// Tailwind utility classes, since the rest of the app uses pure CSS
// variables and a custom stylesheet.

// ---- inline formatting: bold, italic, strike, code, links, images ----
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let i = 0;

  const patterns: Array<{ re: RegExp; render: (m: RegExpMatchArray, k: string) => React.ReactNode }> = [
    { re: /^!\[([^\]]*)\]\(([^)]+)\)/, render: (m, k) => <img key={k} src={m[2]} alt={m[1]} className="chat-md-image" /> },
    { re: /^\[([^\]]+)\]\(([^)]+)\)/, render: (m, k) => <a key={k} href={m[2]} target="_blank" rel="noreferrer" className="chat-md-link">{m[1]}</a> },
    { re: /^\*\*\*([^*]+)\*\*\*/, render: (m, k) => <strong key={k}><em>{m[1]}</em></strong> },
    { re: /^\*\*([^*]+)\*\*/, render: (m, k) => <strong key={k}>{m[1]}</strong> },
    { re: /^__([^_]+)__/, render: (m, k) => <strong key={k}>{m[1]}</strong> },
    { re: /^\*([^*]+)\*/, render: (m, k) => <em key={k}>{m[1]}</em> },
    { re: /^_([^_]+)_/, render: (m, k) => <em key={k}>{m[1]}</em> },
    { re: /^~~([^~]+)~~/, render: (m, k) => <del key={k}>{m[1]}</del> },
    { re: /^`([^`]+)`/, render: (m, k) => <code key={k} className="chat-md-inline-code">{m[1]}</code> },
  ];

  while (rest.length > 0) {
    let matched = false;
    for (const p of patterns) {
      const m = rest.match(p.re);
      if (m) {
        nodes.push(p.render(m, `${keyPrefix}-${i++}`));
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      const nextSpecial = rest.slice(1).search(/[*_~`[!]/);
      const cut = nextSpecial === -1 ? rest.length : nextSpecial + 1;
      nodes.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
  }
  return nodes;
}

type Block =
  | { type: "code"; lang: string; content: string }
  | { type: "hr" }
  | { type: "header"; level: number; text: string }
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; aligns: (string | null)[]; rows: string[][] }
  | { type: "list"; items: Array<{ indent: number; ordered: boolean; text: string; checked: boolean | null }> }
  | { type: "para"; text: string };

// ---- block-level parser ----
function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    // fenced code block
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++; // skip closing fence
      blocks.push({ type: "code", lang, content: codeLines.join("\n") });
      continue;
    }

    // horizontal rule
    if (/^(---|\*\*\*|___)\s*$/.test(line)) { blocks.push({ type: "hr" }); i++; continue; }

    // headers
    const header = line.match(/^(#{1,6})\s+(.*)/);
    if (header) { blocks.push({ type: "header", level: header[1].length, text: header[2] }); i++; continue; }

    // blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quoteLines.push(lines[i].replace(/^>\s?/, "")); i++; }
      blocks.push({ type: "quote", text: quoteLines.join(" ") });
      continue;
    }

    // table
    if (line.includes("|") && lines[i + 1] && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const headerCells = line.split("|").map(c => c.trim()).filter(Boolean);
      const aligns = lines[i + 1].split("|").map(c => c.trim()).filter(Boolean).map(c =>
        c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(lines[i].split("|").map(c => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === "") && !(idx === arr.length - 1 && c === "")));
        i++;
      }
      blocks.push({ type: "table", header: headerCells, aligns, rows });
      continue;
    }

    // lists (unordered/ordered/task), single-level with indent nesting
    if (/^(\s*)([-*+]|\d+\.)\s+/.test(line)) {
      const items: Array<{ indent: number; ordered: boolean; text: string; checked: boolean | null }> = [];
      while (i < lines.length && /^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)/);
        if (!m) break;
        const indent = m[1].length;
        const ordered = /\d+\./.test(m[2]);
        let text = m[3];
        let checked: boolean | null = null;
        const task = text.match(/^\[( |x|X)\]\s+(.*)/);
        if (task) { checked = task[1].toLowerCase() === "x"; text = task[2]; }
        items.push({ indent, ordered, text, checked });
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // paragraph (collect until blank line)
    const paraLines = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|>|(---|\*\*\*|___)\s*$|(\s*)([-*+]|\d+\.)\s+)/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "para", text: paraLines.join(" ") });
  }

  return blocks;
}

type ListNode = {
  indent: number;
  ordered: boolean;
  text: string;
  checked: boolean | null;
  children: ListNode[];
  key: number;
};

function buildNestedList(items: Array<{ indent: number; ordered: boolean; text: string; checked: boolean | null }>): ListNode[] {
  const root: ListNode[] = [];
  const stack: Array<{ indent: number; children: ListNode[] }> = [{ indent: -1, children: root }];
  items.forEach((item, idx) => {
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) stack.pop();
    const node: ListNode = { ...item, children: [], key: idx };
    stack[stack.length - 1].children.push(node);
    stack.push({ indent: item.indent, children: node.children });
  });
  return root;
}

function renderList(nodes: ListNode[], keyPrefix: string): React.ReactNode {
  const ordered = nodes[0]?.ordered;
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag key={keyPrefix} className={ordered ? "chat-md-list chat-md-list-ordered" : "chat-md-list chat-md-list-unordered"}>
      {nodes.map((n) => (
        <li key={`${keyPrefix}-${n.key}`} className={n.checked !== null ? "chat-md-task" : undefined}>
          {n.checked !== null && (
            <input type="checkbox" checked={n.checked} readOnly className="chat-md-checkbox" />
          )}
          <span>{renderInline(n.text, `${keyPrefix}-${n.key}`)}</span>
          {n.children.length > 0 && renderList(n.children, `${keyPrefix}-${n.key}`)}
        </li>
      ))}
    </Tag>
  );
}

interface MarkdownViewProps {
  markdown: string;
}

/**
 * Render markdown into structured React. Pure presentational component —
 * emits stable JSX keys so it composes cleanly inside chat bubbles. The
 * caller decides the alignment (left/right) via the parent container.
 */
export function MarkdownView({ markdown }: MarkdownViewProps) {
  const blocks = parseBlocks(markdown);
  return (
    <div className="chat-md">
      {blocks.map((b, idx) => {
        const key = `b-${idx}`;
        switch (b.type) {
          case "header": {
            const Tag = `h${b.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return <Tag key={key} className={`chat-md-header chat-md-h${b.level}`}>{renderInline(b.text, key)}</Tag>;
          }
          case "para":
            return <p key={key} className="chat-md-para">{renderInline(b.text, key)}</p>;
          case "hr":
            return <hr key={key} className="chat-md-hr" />;
          case "quote":
            return <blockquote key={key} className="chat-md-quote">{renderInline(b.text, key)}</blockquote>;
          case "code":
            return (
              <pre key={key} className="chat-md-codeblock">
                {b.lang ? <div className="chat-md-code-lang">{b.lang}</div> : null}
                <code>{b.content}</code>
              </pre>
            );
          case "list":
            return <React.Fragment key={key}>{renderList(buildNestedList(b.items), key)}</React.Fragment>;
          case "table":
            return (
              <table key={key} className="chat-md-table">
                <thead>
                  <tr>
                    {b.header.map((h, ci) => (
                      <th key={ci} style={{ textAlign: (b.aligns[ci] || "left") as React.CSSProperties["textAlign"] }}>
                        {renderInline(h, `${key}-h-${ci}`)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci} style={{ textAlign: (b.aligns[ci] || "left") as React.CSSProperties["textAlign"] }}>
                          {renderInline(cell, `${key}-${ri}-${ci}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}