import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import panes from "../site/demo/fixtures/panes.json";
import { PI_DELEGATION_TURNS } from "../site/demo/delegation-fixture.ts";

// Real built ChatView, fictional demo transport, no live pane or extension state.
const app = mkdtempSync(join(tmpdir(), "herdr-pi-delegation-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const fixture = JSON.stringify({ source: "pi-transcript", turns: PI_DELEGATION_TURNS, cursor: null }).replace(/</g, "\\u003c");
  const injection = `<script src="./demo-transport.js"></script><script>(() => {
    const demo = window.fetch;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === ${JSON.stringify(panes.web)}) {
        return Promise.resolve(new Response(JSON.stringify(${fixture}), { headers: { "content-type": "application/json" } }));
      }
      if (url.pathname === "/api/pane/prompt") return Promise.resolve(new Response(JSON.stringify({ prompt: null })));
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `${injection}<script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
    try {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, locale: "en-US", isMobile: viewport.width < 500, hasTouch: viewport.width < 500 });
        try {
          await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}&view=chat`);
          for (let reload = 0; reload < 2; reload++) {
            if (reload) await page.reload();
            await page.locator(".delegation-card").first().waitFor({ state: "attached" });
            const launch = page.locator(".chat-turn-agent").filter({ hasText: "Original delegation launch output" });
            // Raw output is folded initially, so find the containing turn by its always-visible task heading.
            const turn = page.locator(".chat-turn-agent").filter({ has: page.locator(".delegation-name", { hasText: "Review retry handling" }) });
            assert.equal(await turn.count(), 1);
            assert.equal(await turn.locator(".work-block.is-folded").count(), 1);
            assert.equal(await turn.locator(".work-row").count(), 0);
            assert.match(await turn.locator(".delegation-activity").textContent() ?? "", /Recorded: background/);
            const card = turn.locator(".delegation-card").first();
            await card.locator("summary").click();
            assert.match(await card.textContent() ?? "", /not live status/);
            assert.match(await page.locator(".delegation-activity").allTextContents().then((rows) => rows.join("\n")), /Recorded: stopped/);
            assert.match(await page.locator(".delegation-activity").allTextContents().then((rows) => rows.join("\n")), /Recorded: failed/);
            assert.match(await page.locator(".delegation-activity").allTextContents().then((rows) => rows.join("\n")), /Recorded: steered/);
            await turn.locator(".work-block-head").click();
            await turn.locator(".work-row-head").first().click();
            assert.equal(await launch.count(), 1, "the original tool output remains accessible");
            await turn.locator(".work-block-head").click();
            assert.equal(await turn.locator(".delegation-card").count(), 2, "folding generic work never hides delegation evidence");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
          }
          assert.deepEqual(errors, []);
          if (process.env.UI_EVIDENCE_DIR) {
            mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `pi-delegation-${viewport.width}.png`) });
          }
          console.log(`PASS pi delegation ${viewport.width}px: evidence outside folds, details, raw output and reload`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
