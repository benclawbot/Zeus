import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./MarkdownView";

describe("MarkdownView", () => {
  it("renders paragraphs with plain text", () => {
    const { container } = render(<MarkdownView markdown="Hello world." />);
    expect(container.querySelector(".chat-md-para")?.textContent).toContain("Hello world.");
  });

  it("renders inline bold, italic, and code", () => {
    const { container } = render(<MarkdownView markdown="Mix of **bold**, *italic*, and `inline code`." />);
    expect(container.querySelector(".chat-md-para strong")?.textContent).toBe("bold");
    expect(container.querySelector(".chat-md-para em")?.textContent).toBe("italic");
    expect(container.querySelector(".chat-md-para .chat-md-inline-code")?.textContent).toBe("inline code");
  });

  it("renders headings with the right h-level", () => {
    const { container } = render(<MarkdownView markdown={"# H1\n## H2\n### H3"} />);
    expect(container.querySelector(".chat-md-h1")?.tagName).toBe("H1");
    expect(container.querySelector(".chat-md-h2")?.tagName).toBe("H2");
    expect(container.querySelector(".chat-md-h3")?.tagName).toBe("H3");
    expect(container.querySelector(".chat-md-h1")?.textContent).toBe("H1");
  });

  it("renders fenced code blocks", () => {
    const markdown = "```js\nconsole.log(42);\n```";
    const { container } = render(<MarkdownView markdown={markdown} />);
    expect(container.querySelector(".chat-md-codeblock code")?.textContent).toBe("console.log(42);");
    expect(container.querySelector(".chat-md-code-lang")?.textContent).toBe("js");
  });

  it("renders unordered and ordered lists", () => {
    const { container } = render(<MarkdownView markdown={"- one\n- two\n\n1. first\n2. second"} />);
    expect(container.querySelector(".chat-md-list-unordered")?.children.length).toBe(2);
    expect(container.querySelector(".chat-md-list-ordered")?.children.length).toBe(2);
  });

  it("renders task lists with checkboxes", () => {
    const { container } = render(<MarkdownView markdown={"- [x] done\n- [ ] open"} />);
    const checkboxes = container.querySelectorAll<HTMLInputElement>(".chat-md-task input[type=checkbox]");
    expect(checkboxes.length).toBe(2);
    expect(checkboxes[0].checked).toBe(true);
    expect(checkboxes[1].checked).toBe(false);
  });

  it("renders blockquotes", () => {
    const { container } = render(<MarkdownView markdown={"> quoted text"} />);
    expect(container.querySelector(".chat-md-quote")?.textContent).toContain("quoted text");
  });

  it("renders tables with alignment hints", () => {
    const markdown = "| L | C | R |\n|:--|:-:|--:|\n| a | b | c |";
    const { container } = render(<MarkdownView markdown={markdown} />);
    expect(container.querySelector(".chat-md-table")?.querySelectorAll("th").length).toBe(3);
    const cells = container.querySelectorAll<HTMLElement>(".chat-md-table td");
    expect(cells[0].style.textAlign).toBe("left");
    expect(cells[1].style.textAlign).toBe("center");
    expect(cells[2].style.textAlign).toBe("right");
  });

  it("renders horizontal rules", () => {
    const { container } = render(<MarkdownView markdown={"above\n\n---\n\nbelow"} />);
    expect(container.querySelector(".chat-md-hr")).not.toBeNull();
  });

  it("renders links and images", () => {
    const { container } = render(<MarkdownView markdown={"[text](https://example.com) and ![alt](https://img.test/p.png)"} />);
    const link = container.querySelector<HTMLAnchorElement>(".chat-md-link");
    expect(link?.href).toBe("https://example.com/");
    expect(link?.textContent).toBe("text");
    const img = container.querySelector(".chat-md-image");
    expect(img?.getAttribute("src")).toBe("https://img.test/p.png");
    expect(img?.getAttribute("alt")).toBe("alt");
  });

  it("escapes raw HTML by leaving it as text", () => {
    const { container } = render(<MarkdownView markdown={"This <span> is not HTML </span> here."} />);
    expect(container.querySelector("span")).toBeNull();
    expect(container.querySelector(".chat-md-para")?.textContent).toContain("This");
    expect(container.querySelector(".chat-md-para")?.textContent).toContain("</span>");
  });
});