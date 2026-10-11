/** Real PromptCard on the demo transport; no live herdr, extension, or agent session. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { RPIV_PROMPT, RPIV_LIVE_PROMPT } from "../site/demo/fixtures.ts";
import panes from "../site/demo/fixtures/panes.json";

const app = mkdtempSync(join(tmpdir(), "herdr-rpiv-browser-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  const injection = `<script src="./demo-transport.js"></script><script>(() => {
    const demo = window.fetch;
    window.rpivAnswers = [];
    const scenario = new URLSearchParams(location.search).get("rpiv") ?? "fallback";
    let prompt = scenario === "fallback" ? ${JSON.stringify(RPIV_PROMPT)} : { ...${JSON.stringify(RPIV_LIVE_PROMPT)}, multi_select: ["multi", "empty"].includes(scenario), ...(["multi", "empty"].includes(scenario) ? {} : { checked_option_indices: [] }) };
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/prompt" && url.searchParams.get("pane_id") === ${JSON.stringify(panes.web)}) {
        return Promise.resolve(new Response(JSON.stringify({ prompt, suggestion: null }), { headers: { "content-type": "application/json" } }));
      }
      if (url.pathname === "/api/pane/prompt/answer") {
        window.rpivAnswers.push(JSON.parse(init.body)); prompt = null;
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `${injection}<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(prefix)) return new Response("not found", { status: 404 });
    let path: string;
    try { path = decodeURIComponent(url.pathname.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!path || path.endsWith("/")) path += "index.html";
    if (path.split("/").includes("..") || path.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, path));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: "en-US", hasTouch: viewport.width < 500, isMobile: viewport.width < 500 });
    try {
      await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
      const page = await context.newPage();
      const capture = async (name: string) => {
        if (!process.env.UI_EVIDENCE_DIR) return;
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `rpiv-${name}-${viewport.width}.png`) });
      };
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const base = `http://127.0.0.1:${server.port}${prefix}?pane=${encodeURIComponent(panes.web)}&view=chat`;
      await page.goto(base);
      const card = page.locator(".prompt-card");
      await card.getByText("Answer this questionnaire in the terminal. Its live keybindings cannot be verified here.").waitFor();
      assert.equal(await card.locator("button, input, textarea").count(), 0, "no guessed answer or cancel actions");
      assert.match(await card.innerText(), /Which store should hold the counters/);
      assert.equal(await card.locator("pre").count(), 1, "screen text is literal, never HTML or executable previews");
      assert.ok(await card.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1;
      }), "card fits desktop and phone width");
      assert.deepEqual(await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers), []);
      await capture("fallback");
      for (const scenario of ["single", "multi", "empty", "custom"]) {
        await page.goto(`${base}&rpiv=${scenario}`);
        await card.getByText("Which store should hold the counters?").waitFor();
        await capture(scenario);
        if (scenario === "multi" || scenario === "empty") {
          const checks = card.getByRole("checkbox");
          assert.equal(await checks.nth(0).isChecked(), true, "live checked state appears initially");
          // The app consumes notification query targets; reload with the same explicit target.
          await page.goto(`${base}&rpiv=${scenario}`);
          await card.getByText("Which store should hold the counters?").waitFor();
          assert.equal(await checks.nth(0).isChecked(), true, "reload reads authoritative state");
          await checks.nth(0).uncheck();
          if (scenario === "multi") await checks.nth(1).check();
          await card.getByRole("button", { name: scenario === "multi" ? "Submit (1)" : "Submit", exact: true }).click();
        } else if (scenario === "custom") {
          await card.getByRole("textbox").fill("A fictional store");
          await card.getByRole("button", { name: "Send", exact: true }).click();
        } else {
          await card.getByRole("button", { name: /2\. Redis/ }).click();
        }
        await page.waitForFunction(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers.length === 1);
        const answers = await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers);
        assert.deepEqual(answers, [{ pane_id: panes.web, prompt_id: RPIV_LIVE_PROMPT.id,
          ...(scenario === "multi" || scenario === "empty" ? { option_indices: scenario === "empty" ? [] : [1] } : scenario === "custom" ? { custom_text: "A fictional store" } : { option_index: 1 }) }]);
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log("RPIV opt-in single/multi/custom and terminal-only cards: desktop and phone passed");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
