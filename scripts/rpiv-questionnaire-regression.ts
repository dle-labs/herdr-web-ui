/** Real PromptCard on the demo transport; no live herdr, extension, or agent session. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator } from "playwright-core";
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
    let prompt = scenario === "fallback" ? ${JSON.stringify(RPIV_PROMPT)} : { ...${JSON.stringify(RPIV_LIVE_PROMPT)}, multi_select: ["multi", "empty", "multi-custom"].includes(scenario), ...(["multi", "empty", "multi-custom"].includes(scenario) ? {} : { checked_option_indices: [] }) };
    window.rpivEnableLive = () => { prompt = { ...${JSON.stringify(RPIV_LIVE_PROMPT)}, multi_select: false, checked_option_indices: [] }; };
    window.rpivDismiss = () => { prompt = null; };
    window.rpivFailNext = false;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/prompt" && url.searchParams.get("pane_id") === ${JSON.stringify(panes.web)}) {
        return Promise.resolve(new Response(JSON.stringify({ prompt, suggestion: null }), { headers: { "content-type": "application/json" } }));
      }
      if (url.pathname === "/api/pane/prompt/answer") {
        window.rpivAnswers.push(JSON.parse(init.body));
        if (window.rpivFailNext) {
          window.rpivFailNext = false;
          return Promise.resolve(new Response(JSON.stringify({ error: { code: "fixture_error", message: "Synthetic answer failure" } }), { status: 500, headers: { "content-type": "application/json" } }));
        }
        prompt = null;
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
      await context.addInitScript((paneId) => {
        localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", enterSends: true }));
        localStorage.setItem(`herdr-web-ui:composer-draft:${paneId}`, "A draft for later");
      }, panes.web);
      const page = await context.newPage();
      const press = (button: Locator) => viewport.width < 500 ? button.tap() : button.click();
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
      assert.equal(await card.locator("button:not(.prompt-card-terminal), input, textarea").count(), 0, "no guessed answer or cancel actions; navigation is not an answer");
      assert.equal(await card.getByRole("button", { name: "Answer in terminal", exact: true }).count(), 1);
      assert.match(await card.innerText(), /Which store should hold the counters/);
      assert.equal(await card.locator("pre").count(), 1, "screen text is literal, never HTML or executable previews");
      assert.ok(await card.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= window.innerWidth + 1;
      }), "card fits desktop and phone width");
      assert.deepEqual(await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers), []);
      const composer = page.locator(".composer");
      const draft = composer.locator(".composer-draft textarea");
      assert.equal(await composer.isVisible(), false, "terminal-only questions hide the ordinary composer too");
      assert.equal(await draft.inputValue(), "A draft for later", "the hidden composer retains the existing draft");
      assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 0);
      await capture("fallback");
      await press(card.getByRole("button", { name: "Answer in terminal", exact: true }));
      await page.locator(`.terminal-stack[data-pane-owner="${panes.web}"]:not(.is-chat)`).waitFor();
      await press(page.locator(".view-switch button").first());
      await card.getByRole("button", { name: "Answer in terminal", exact: true }).waitFor();
      assert.equal(await draft.inputValue(), "A draft for later", "switching lenses preserves the draft");
      assert.equal(await composer.isVisible(), false);
      assert.deepEqual(await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers), [], "navigation sends zero answers");
      // Authoritative state replaces the fallback without exposing or consuming the chat draft.
      await page.evaluate(() => (window as unknown as { rpivEnableLive(): void }).rpivEnableLive());
      await card.getByRole("button", { name: /1\. Memory/ }).waitFor();
      assert.equal(await composer.isVisible(), false);
      assert.equal(await card.getByRole("textbox").count(), 0, "choices do not open a custom field");
      await press(card.getByRole("button", { name: /1\. Memory/ }));
      await page.waitForFunction(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers.length === 1);
      assert.deepEqual(await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers), [{ pane_id: panes.web, prompt_id: RPIV_LIVE_PROMPT.id, option_index: 0 }]);
      await composer.waitFor({ state: "visible" });
      assert.equal(await draft.inputValue(), "A draft for later", "answering restores the unsent chat draft unchanged");
      for (const scenario of ["single", "multi", "empty", "custom", "multi-custom", "custom-error"]) {
        await page.goto(`${base}&rpiv=${scenario}`);
        await card.getByText("Which store should hold the counters?").waitFor();
        assert.equal(await composer.isVisible(), false, "questionnaire replaces the normal input");
        assert.equal(await card.getByRole("textbox").count(), 0, "custom input starts closed");
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
          await press(card.getByRole("button", { name: scenario === "multi" ? "Submit (1)" : "Submit", exact: true }));
        } else if (scenario === "custom" || scenario === "multi-custom" || scenario === "custom-error") {
          const customOption = card.getByRole("button", { name: /Type something\./ });
          await press(customOption);
          assert.equal(await composer.isVisible(), false, "custom input does not reveal the chat composer");
          assert.equal(await card.getByRole("textbox").evaluate((input) => input === document.activeElement), true, "only choosing custom input focuses its field");
          assert.deepEqual(await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers), [], "opening the custom field does not answer");
          await card.getByRole("textbox").fill("A fictional store");
          if (scenario === "multi-custom") {
            assert.equal(await card.getByRole("checkbox", { checked: true }).count(), 0, "custom and option selections are exclusive");
            await card.getByRole("checkbox").nth(1).check();
            assert.equal(await card.getByRole("textbox").count(), 0, "choosing a checkbox closes custom input");
            await press(customOption);
            assert.equal(await card.getByRole("textbox").inputValue(), "A fictional store", "switching modes retains the custom draft");
          }
          await capture(`${scenario}-opened`);
          if (scenario === "custom-error") {
            await page.evaluate(() => { (window as unknown as { rpivFailNext: boolean }).rpivFailNext = true; });
            await press(card.getByRole("button", { name: "Send", exact: true }));
            await card.getByRole("alert").waitFor();
            assert.match(await card.getByRole("alert").innerText(), /Synthetic answer failure/);
            assert.equal(await composer.isVisible(), false, "failed answers keep the questionnaire in control");
            assert.equal(await card.getByRole("textbox").inputValue(), "A fictional store", "failure preserves the custom draft");
            assert.equal(await card.getByRole("button", { name: "Send", exact: true }).isEnabled(), true);
            assert.equal(await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers.length), 1, "a failed answer is not retried automatically");
          }
          await press(card.getByRole("button", { name: "Send", exact: true }));
        } else {
          await press(card.getByRole("button", { name: /2\. Redis/ }));
        }
        const attempts = scenario === "custom-error" ? 2 : 1;
        await page.waitForFunction((count) => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers.length === count, attempts);
        const answers = await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers);
        const expected = { pane_id: panes.web, prompt_id: RPIV_LIVE_PROMPT.id,
          ...(scenario === "multi" || scenario === "empty" ? { option_indices: scenario === "empty" ? [] : [1] } : scenario === "custom" || scenario === "multi-custom" || scenario === "custom-error" ? { custom_text: "A fictional store" } : { option_index: 1 }) };
        assert.deepEqual(answers, Array.from({ length: attempts }, () => expected));
        await composer.waitFor({ state: "visible" });
        assert.equal(await draft.inputValue(), "A draft for later", "choice/custom submission never consumes the ordinary draft");
      }
      // An external terminal dismissal restores chat without submitting either draft;
      // a later question starts with its custom editor closed and empty.
      await page.goto(`${base}&rpiv=custom`);
      await press(card.getByRole("button", { name: /Type something\./ }));
      await card.getByRole("textbox").fill("An unsent custom answer");
      await page.evaluate(() => (window as unknown as { rpivDismiss(): void }).rpivDismiss());
      await composer.waitFor({ state: "visible" });
      assert.equal(await draft.inputValue(), "A draft for later");
      assert.deepEqual(await page.evaluate(() => (window as unknown as { rpivAnswers: unknown[] }).rpivAnswers), []);
      await page.evaluate(() => (window as unknown as { rpivEnableLive(): void }).rpivEnableLive());
      await card.getByRole("button", { name: /1\. Memory/ }).waitFor();
      assert.equal(await composer.isVisible(), false);
      assert.equal(await card.getByRole("textbox").count(), 0);
      await press(card.getByRole("button", { name: /Type something\./ }));
      assert.equal(await card.getByRole("textbox").inputValue(), "", "a new question never inherits another question's custom text");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log("RPIV opt-in single/multi/custom and terminal-only cards: desktop and phone passed");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
