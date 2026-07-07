#!/usr/bin/env node

const target = process.env.ZEUS_TEST_BASE_URL || "http://127.0.0.1:5173";
const visible = process.env.ZEUS_BROWSER_VISIBLE === "1";

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    console.error("Browser smoke runner requires the Playwright package. Install it in devDependencies, then run this script again.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: !visible });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  try {
    await page.goto(target, { waitUntil: "networkidle" });
    await page.getByLabel("Message Zeus").waitFor({ timeout: 10_000 });
    const title = await page.title();
    if (!/Zeus/i.test(title)) throw new Error(`Unexpected page title: ${title}`);
    await page.screenshot({ path: "artifacts/browser-smoke.png", fullPage: true });
    console.log(`Browser smoke passed for ${target}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
