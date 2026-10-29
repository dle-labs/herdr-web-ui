/** Reply comments: create, edit, reload, delete and preserve native selection.
 * Fictional demo transport only; no herdr or existing dist required. Run:
 *   bun scripts/block-comments-regression.ts
 * HERDR_DEMO_BUILD reuses a demo build; BLOCK_COMMENTS_CASE=desktop|mobile filters devices.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

const TEXT = "The sync plan keeps every revision in order and never loses a write.";
const app = mkdtempSync(join(tmpdir(), "chat-reply-comments-"));
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** Checks the copy event contract, including the app's Markdown copy handler; no OS clipboard permission required. */
async function copiedSelection(page: Page, expected?: string): Promise<void> {
  const copied = await page.evaluate(() => {
    const selection = window.getSelection()!;
    const before = selection.toString();
    const event = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    selection.anchorNode!.parentElement!.dispatchEvent(event);
    return { before, after: selection.toString(), copied: event.defaultPrevented ? event.clipboardData!.getData("text/plain") : before };
  });
  assert.ok(copied.before.trim(), "native selection contains text");
  if (expected !== undefined) assert.equal(copied.before, expected);
  assert.equal(copied.after, copied.before, "copy preserves the selection");
  assert.equal(copied.copied, copied.before, "ordinary text copies unchanged");

}

async function selectParagraph(part: Locator, touch: boolean): Promise<void> {
  await part.evaluate((node, touch) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    // Chromium emulation cannot long-press native iOS selection handles. Exercise the
    // resulting browser selection and the same touch-release/keyboard completion event.
    const rect = range.getBoundingClientRect();
    if (touch) node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", clientX: rect.right, clientY: rect.bottom - 2 }));
    else node.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
  }, touch);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n<script src="./chat-fixture.js"></script>\n<script type="module"'));
  writeFileSync(join(app, "chat-fixture.js"), `(() => {
    const demoFetch = window.fetch;
    window.fetch = async (input, init) => {
      const response = await demoFetch(input, init);
      const url = new URL(typeof input === "string" ? input : input.url ?? String(input), location.href);
      if (url.pathname.endsWith("/pane/conversation") && response.ok) {
        const data = await response.json();
        data.turns = [
          { role: "user", parts: [{ kind: "text", text: "Show me the sync plan." }] },
          { role: "assistant", parts: [{ kind: "text", text: ${JSON.stringify(`${TEXT}\n\n- Keep the newest revision\n- Retry a conflict\n\n\`\`\`ts\nconst revision = 3;\n\`\`\``)} }] }
          , { role: "user", parts: [{ kind: "text", text: "I am reviewing the answer." }] }
        ];
        return Response.json(data);
      }
      return response;
    };
  })();`);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/") || path === "/ws") return new Response("Unexpected real API request", { status: 404 });
    const file = Bun.file(join(app, path === "/" ? "index.html" : path));
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const mobile of [false, true]) {
      const name = mobile ? "mobile" : "desktop";
      if (process.env.BLOCK_COMMENTS_CASE && !process.env.BLOCK_COMMENTS_CASE.split(",").includes(name)) continue;
      const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, locale: "en-US", serviceWorkers: "block" });
      try {
        // Enable reply comments for both pointer and touch layouts.
        await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", comments: true, view: "chat", theme: "dark" })));
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/index.html`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const chat = page.locator(".pane-frame.is-current .chat-view");
        const paragraph = chat.locator("p").filter({ hasText: TEXT }).first();
        await paragraph.waitFor();
        await paragraph.scrollIntoViewIfNeeded();
        assert.ok(await paragraph.evaluate((node) => node.classList.contains("is-commentable")));
        if (mobile) await paragraph.tap(); else await paragraph.click();
        const field = page.locator(".comment-popover textarea");
        await field.fill("Keep the retry explicit.");
        await page.getByRole("button", { name: "Save comment", exact: true }).click();
        await page.locator(".composer-comments-bar").waitFor();
        assert.equal(await chat.locator(".comment-pin").count(), 1);
        await page.reload();
        await paragraph.waitFor();
        await page.locator(".composer-comments-walk").click();
        await field.fill("Explain the retry limit.");
        await page.getByRole("button", { name: "Save comment", exact: true }).click();
        await page.locator(".composer-comments-walk").click();
        assert.equal(await field.inputValue(), "Explain the retry limit.");
        await page.getByRole("button", { name: "Delete comment", exact: true }).click();
        await page.locator(".composer-comments-bar").waitFor({ state: "detached" });
        await selectParagraph(paragraph, mobile);
        await copiedSelection(page, TEXT);
        await page.locator(".comment-selection").click();
        await field.fill("Comment on this selection.");
        await page.getByRole("button", { name: "Save comment", exact: true }).click();
        await page.locator(".composer-comments-bar").waitFor();
        const saved = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ovis:block-comments:")).flatMap((key) => JSON.parse(localStorage.getItem(key)!).comments));
        assert.equal(saved.length, 1);
        assert.equal(saved[0].quote, TEXT);
        assert.equal(saved[0].comment, "Comment on this selection.");
        // An older reply outside rendered history remains editable from the composer.
        await page.evaluate(() => {
          const key = Object.keys(localStorage).find((key) => key.startsWith("ovis:block-comments:"))!;
          const data = JSON.parse(localStorage.getItem(key)!);
          data.comments[0].anchor = "not-loaded:0:0";
          localStorage.setItem(key, JSON.stringify(data));
        });
        await page.reload();
        await page.locator(".composer-comments-walk").click();
        await field.fill("An unsaved edit.");
        // Simulate another tab editing that same note while our draft stays open.
        await page.evaluate(() => {
          const key = Object.keys(localStorage).find((key) => key.startsWith("ovis:block-comments:"))!;
          const oldValue = localStorage.getItem(key)!;
          const data = JSON.parse(oldValue);
          data.comments[0].id = "changed-in-other-tab";
          data.comments[0].comment = "Another tab's edit.";
          const newValue = JSON.stringify(data);
          localStorage.setItem(key, newValue);
          window.dispatchEvent(new StorageEvent("storage", { key, oldValue, newValue }));
        });
        await page.getByRole("button", { name: "Delete comment", exact: true }).click();
        await page.locator(".composer-comments-bar").waitFor({ state: "detached" });
        assert.deepEqual(errors, [], "no browser exceptions");
        console.log(`PASS Reply comments: ${name} create, reload, edit, delete and selection/copy`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
