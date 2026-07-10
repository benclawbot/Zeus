#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { dirname, resolve } from "node:path";

const MAX_BODY_CHARS = 80_000;
const sessions = new Map();
let browserPromise;

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function error(message) {
  return { ok: false, message };
}

async function browser() {
  if (!browserPromise) {
    browserPromise = import("playwright").then(({ chromium }) => chromium.launch({ headless: process.env.ZEUS_BROWSER_VISIBLE !== "1" }));
  }
  return browserPromise;
}

async function pageFor(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const context = await (await browser()).newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  sessions.set(sessionId, page);
  return page;
}

async function snapshot(page) {
  const [title, url, body, links, fields] = await Promise.all([
    page.title(),
    page.url(),
    page.locator("body").innerText().catch(() => ""),
    page.locator("a").evaluateAll((nodes) => nodes.slice(0, 100).map((node) => ({ text: (node.textContent || "").trim(), href: node.href }))),
    page.locator("input, textarea, select").evaluateAll((nodes) => nodes.slice(0, 100).map((node) => ({
      tag: node.tagName.toLowerCase(),
      name: node.getAttribute("name") || node.getAttribute("id") || "",
      type: node.getAttribute("type") || "",
      placeholder: node.getAttribute("placeholder") || "",
    }))),
  ]);
  return { title, url, body: body.slice(0, MAX_BODY_CHARS), truncated: body.length > MAX_BODY_CHARS, links, fields };
}

function commandParts(command) {
  const parts = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return parts.map((part) => part.replace(/^("|')|("|')$/g, ""));
}

async function runTest(command) {
  const [program, ...args] = commandParts(command);
  if (!program) return error("A browser test action requires testCommand.");
  return new Promise((resolveResult) => {
    const child = spawn(program, args, { cwd: process.cwd(), shell: false, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-MAX_BODY_CHARS); });
    child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-MAX_BODY_CHARS); });
    child.on("error", (err) => resolveResult(error(`Could not start browser test: ${err.message}`)));
    child.on("close", (code) => resolveResult({
      ok: code === 0,
      message: output || `Browser test exited with code ${code ?? "unknown"}.`,
      testCommand: command,
      exitCode: code,
    }));
  });
}

async function handle(request) {
  const sessionId = request.sessionId || "browser-default";
  if (request.action === "status") {
    return { ok: true, message: "Playwright browser driver is ready." };
  }
  if (request.action === "run_test") return runTest(request.testCommand || "");

  const page = await pageFor(sessionId);
  switch (request.action) {
    case "open":
      if (!request.url) return error("Browser open requires url.");
      await page.goto(request.url, { waitUntil: "domcontentloaded" });
      return { ok: true, message: "Opened page.", snapshot: await snapshot(page) };
    case "snapshot":
      return { ok: true, message: "Captured page snapshot.", snapshot: await snapshot(page) };
    case "click":
      if (!request.selector) return error("Browser click requires selector.");
      await page.locator(request.selector).click();
      return { ok: true, message: "Clicked element.", snapshot: await snapshot(page) };
    case "type":
      if (!request.selector) return error("Browser type requires selector.");
      await page.locator(request.selector).fill(request.text || "");
      return { ok: true, message: "Entered text.", snapshot: await snapshot(page) };
    case "screenshot": {
      const artifactPath = request.artifactPath ? resolve(request.artifactPath) : resolve("artifacts", `${sessionId}.png`);
      await mkdir(dirname(artifactPath), { recursive: true });
      await page.screenshot({ path: artifactPath, fullPage: true });
      return { ok: true, message: "Captured screenshot.", artifact: artifactPath, snapshot: await snapshot(page) };
    }
    case "eval":
      if (!request.script) return error("Browser eval requires script.");
      return { ok: true, message: "Evaluated page script.", value: await page.evaluate(request.script), snapshot: await snapshot(page) };
    default:
      return error(`Unsupported browser action: ${request.action || "(empty)"}.`);
  }
}

process.stdout.on("error", () => process.exit(0));
process.stderr.on("error", () => process.exit(0));
process.on("SIGTERM", async () => { if (browserPromise) (await browserPromise).close(); process.exit(0); });
process.on("SIGINT", async () => { if (browserPromise) (await browserPromise).close(); process.exit(0); });

write({ kind: "ready", provider: "playwright" });
for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    write({ ok: false, message: `Invalid browser-driver request: ${err.message}` });
    continue;
  }
  try {
    write({ id: request.id, sessionId: request.sessionId || "browser-default", action: request.action || "", ...(await handle(request)) });
  } catch (err) {
    write({ id: request.id, sessionId: request.sessionId || "browser-default", action: request.action || "", ok: false, message: err instanceof Error ? err.message : String(err) });
  }
}
