import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const driverPath = fileURLToPath(new URL("./zeus-browser-driver.mjs", import.meta.url));
const child = spawn(process.execPath, [driverPath], {
  stdio: ["pipe", "pipe", "pipe"],
});
const childExited = once(child, "exit");

let pending = "";
const messages = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf("\n")) >= 0) {
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (line) messages.push(JSON.parse(line));
  }
});

async function waitFor(predicate, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const index = messages.findIndex(predicate);
    if (index >= 0) return messages.splice(index, 1)[0];
    if (child.exitCode !== null) {
      throw new Error(`Browser driver exited before ${description} (code ${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  const ready = await waitFor((message) => message.kind === "ready", "driver ready frame");
  assert.equal(ready.provider, "playwright");

  child.stdin.write(`${JSON.stringify({
    id: 1,
    action: "open",
    sessionId: "smoke",
    url: "data:text/html,<title>Zeus browser driver</title><main><a href='/docs'>Docs</a><input name='goal' type='text'></main>",
  })}\n`);
  const opened = await waitFor((message) => message.id === 1, "open response");
  assert.equal(opened.ok, true, opened.message);
  assert.equal(opened.snapshot.title, "Zeus browser driver");
  assert.match(opened.snapshot.body, /Docs/);

  child.stdin.write(`${JSON.stringify({ id: 2, action: "type", sessionId: "smoke", selector: "input[name=goal]", text: "verify Zeus" })}\n`);
  const typed = await waitFor((message) => message.id === 2, "type response");
  assert.equal(typed.ok, true, typed.message);

  child.stdin.write(`${JSON.stringify({ id: 3, action: "snapshot", sessionId: "smoke" })}\n`);
  const snapshot = await waitFor((message) => message.id === 3, "snapshot response");
  assert.equal(snapshot.ok, true, snapshot.message);
  assert.equal(snapshot.snapshot.fields[0].name, "goal");
} finally {
  child.stdin.end();
  if (child.exitCode === null && !child.killed) child.kill();
  await childExited;
}
