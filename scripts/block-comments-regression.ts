/** Chat is read/copy only: clicks, drags and touch selections must never offer comments.
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
const app = mkdtempSync(join(tmpdir(), "chat-no-comments-"));
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function noComments(page: Page): Promise<void> {
  await frames(page);
  assert.equal(await page.locator(".comment-selection, .comment-pin, .comment-popover, .diff-comment-editor, .composer-comments-bar").count(), 0, "chat gestures create no comment affordance or composer context");
  assert.equal(await page.locator(".chat-view .is-commentable, .chat-view [data-comment-surface]").count(), 0, "chat is not registered as a comment surface");
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("ovis:block-comments:")).flatMap((key) => JSON.parse(localStorage.getItem(key)!).comments));
  assert.deepEqual(saved, [], "chat gestures save no comments");
}

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
  await noComments(page);
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
        // Deliberately enable comments: their removal from chat must not depend on the setting.
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
        for (const part of [paragraph, chat.locator("li").filter({ hasText: "Retry a conflict" }).first(), chat.locator("code").filter({ hasText: "const revision = 3;" }).first()]) {
          if (mobile) await part.tap(); else await part.click();
          await noComments(page);
        }
        await paragraph.scrollIntoViewIfNeeded();
        if (!mobile) {
          // A real mouse drag, not only a programmatic selection.
          const points = await paragraph.evaluate((node) => {
            // Markdown may wrap words in spans: character offsets belong to text
            // nodes, not to the paragraph's first element child.
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            const nodes: Text[] = [];
            for (let next = walker.nextNode(); next; next = walker.nextNode()) nodes.push(next as Text);
            const at = (offset: number) => {
              for (const text of nodes) {
                if (offset >= text.length) { offset -= text.length; continue; }
                const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1);
                const box = range.getBoundingClientRect(); return { x: box.x + 1, y: box.y + box.height / 2 };
              }
              throw new Error("paragraph has no glyph at the requested offset");
            };
            return [at(0), at(30)];
          });
          await page.mouse.move(points[0]!.x, points[0]!.y);
          await page.mouse.down();
          await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 8 });
          await page.mouse.up();
          await copiedSelection(page);
          // The paragraph's box center can land on whitespace or beyond its text.
          await page.mouse.dblclick(points[0]!.x, points[0]!.y);
          await copiedSelection(page);
        }
        await selectParagraph(paragraph, mobile);
        await copiedSelection(page, TEXT);
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await noComments(page);
        assert.deepEqual(errors, [], "no browser exceptions");
        console.log(`PASS Chat read/copy only: ${name} clicks, selections and copying never comment`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
