/** Working-file comments use the same gutter/inline editor interaction as Git diffs.
 * Real client + fictional demo files only; never touches herdr. Run:
 *   bun scripts/file-viewer-comments-regression.ts
 * FILE_COMMENTS_CASE=desktop|mobile filters devices. HERDR_DEMO_BUILD reuses a demo build.
 * Standalone runs build their own temporary client; no prebuilt dist is needed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { sheetsSettled } from "./sheets-settled.ts";

const SYNC = [
  'import { load, store } from "./store.ts";',
  "", "export interface Note { id: string; revision: number; text: string }", "",
  "/** Writes a note unless a newer one is stored. */",
  "export async function sync(incoming: Note): Promise<Note> {",
  "  const stored = await load(incoming.id);",
  "  if (incoming.revision < stored.revision) {",
  "    return stored;", "  }", "  await store(incoming);", "  return incoming;", "}",
];
const MARKDOWN = "# Sync guide\n\nKeep the **newest** revision.\n\nRetry a conflict.\n";
const LARGE = Array.from({ length: 2600 }, (_, n) => `export const revision${n + 1} = ${n + 1};`).join("\n") + "\n";
const app = mkdtempSync(join(tmpdir(), "source-comments-regression-"));
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const source = (files: Locator) => files.locator(".source-comments");
const number = (files: Locator, line: number) => source(files).locator(`[data-column-number="${line}"]`).first();
const code = (files: Locator, line: number) => source(files).locator(`[data-line="${line}"]`).first();
const editor = (files: Locator) => files.locator(".diff-comment-editor");
const field = (files: Locator) => editor(files).getByRole("textbox", { name: "Comment", exact: true });
const card = (files: Locator, text: string) => source(files).locator(".diff-comment-card").filter({ hasText: text });
interface StoredComment { kind: string; comment: string; path: string; view: string; lines: number[]; source: string[]; quoteLines: string[]; selection?: unknown; diff?: unknown }
const stored = (page: Page): Promise<StoredComment[]> => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("herdr-web-ui:block-comments:")).flatMap((key) => JSON.parse(localStorage.getItem(key)!).comments));

async function openFiles(page: Page): Promise<Locator> {
  await page.locator(".composer").getByRole("button", { name: "Browse files", exact: true }).click();
  const files = page.getByRole("dialog", { name: "Files", exact: true });
  await files.locator(".workspace-file-tree").waitFor();
  await sheetsSettled(page);
  return files;
}
async function openFile(files: Locator, name: string, mobile: boolean): Promise<void> {
  if (mobile && await files.locator(".changes-detail").isVisible()) await files.getByRole("button", { name: "Back to files", exact: true }).click();
  await files.locator(`.workspace-tree-row[title="${name}"]`).click();
  if (name.endsWith(".md")) await files.locator(".file-viewer-markdown").waitFor();
  else await number(files, 2).waitFor();
  await sheetsSettled(files.page());
}
async function save(files: Locator, text: string): Promise<void> {
  await field(files).fill(text);
  await editor(files).getByRole("button", { name: "Save comment", exact: true }).click();
  await editor(files).waitFor({ state: "detached" });
  await card(files, text).waitFor();
}
async function discard(files: Locator): Promise<void> {
  await editor(files).getByRole("button", { name: "Discard comment", exact: true }).click();
  await editor(files).waitFor({ state: "detached" });
}
async function assertRange(files: Locator, start: number, end = start): Promise<void> {
  await field(files).waitFor();
  const label = `:${Math.min(start, end)}${start === end ? "" : `-${Math.max(start, end)}`}`;
  assert.ok((await editor(files).locator(".diff-comment-heading").innerText()).includes(label), `editor names the source range ${label}`);
  assert.equal(await field(files).evaluate((node) => node.tagName), "TEXTAREA", "source uses the shared plain-text inline editor");
  assert.equal(await files.page().locator(".modal-scrim > .comment-popover, .comment-selection, .comment-pin").count(), 0, "no old pin, selection button or detached comment sheet");
}

/** Real CDP touches exercise pointer capture and prevent native scrolling during gutter selection. */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...from, id: 1 }] });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8, id: 1 }] });
      await frames(page);
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await session.detach(); }
}
/** Virtualization can replace both rows after scrollIntoView. Read live nodes in one
 * task and require stable nonempty boxes across frames, never retain stale handles. */
async function gutterEndpoints(files: Locator, first: number, last: number, utility: boolean): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const deadline = Date.now() + 5000;
  let previous = "";
  while (Date.now() < deadline) {
    const boxes = await source(files).evaluate((node, selectors) => {
      const roots: (Element | ShadowRoot)[] = [node, ...[...node.querySelectorAll("diffs-container")].flatMap((host) => host.shadowRoot ? [host.shadowRoot] : [])];
      return selectors.map((selector) => {
        const row = roots.map((root) => root.querySelector(selector)).find((row) => row !== null);
        if (!row) return null;
        const box = row.getBoundingClientRect();
        return box.width > 0 && box.height > 0 ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      });
    }, [utility ? ".diff-comment-plus" : `[data-column-number="${first}"]`, `[data-column-number="${last}"]`]);
    const snapshot = JSON.stringify(boxes);
    if (boxes.every((box) => box !== null) && snapshot === previous) return boxes as { x: number; y: number; width: number; height: number }[];
    previous = snapshot;
    await frames(files.page());
  }
  throw new Error(`gutter endpoints ${first}-${last} did not stabilize: ${previous}`);
}
async function dragRange(files: Locator, first: number, last: number, mobile: boolean, utility = false): Promise<void> {
  const page = files.page();
  await number(files, first).evaluate((node) => node.scrollIntoView({ block: "nearest" }));
  if (utility) {
    if (mobile) await number(files, first).tap(); else await number(files, first).hover();
  }
  const [from, to] = await gutterEndpoints(files, first, last, utility);
  assert.ok(from && to, "both live gutter endpoints are rendered");
  const a = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const b = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  if (mobile) await touchDrag(page, a, b);
  else {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    if (!utility) assert.equal(await editor(files).count(), 0, "range editor opens on release, not on press");
    await page.mouse.up();
  }
  await assertRange(files, first, last);
  assert.equal(await files.evaluate((node) => node.style.transform), "", "gutter drag never drags the phone sheet");
}

/** A native selection in Pierre's shadow tree (or Markdown's regular tree) remains copyable. */
async function selectAndCopy(part: Locator, mobile: boolean): Promise<string> {
  return part.evaluate((node, mobile) => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString();
    const rect = node.getBoundingClientRect();
    if (mobile) node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, composed: true, pointerType: "touch", clientX: rect.right - 4, clientY: rect.top + rect.height / 2 }));
    else node.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key: "Shift" }));
    const copy = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, composed: true, cancelable: true });
    node.dispatchEvent(copy);
    if (selection.toString() !== selected) throw new Error("copy changed the native selection");
    if (copy.defaultPrevented && copy.clipboardData!.getData("text/plain") !== selected) throw new Error("copy changed ordinary source text");
    return selected;
  }, mobile);
}
async function noEditor(files: Locator): Promise<void> {
  await frames(files.page());
  assert.equal(await editor(files).count(), 0, "ordinary content interactions never open a comment");
  assert.equal(await files.page().locator(".comment-selection, .comment-pin").count(), 0, "no selection-to-comment affordance");
}

async function checkSource(page: Page, files: Locator, mobile: boolean): Promise<void> {
  await openFile(files, "sync.ts", mobile);
  await files.locator(".source-comments-file").waitFor();
  // The async worker replaces initial plain rows once. Exercise native selection
  // on the settled highlighted document, not stale pre-highlight coordinates.
  await files.locator('.source-comments-file [data-line] span[style*="--herdr-code-token"]').first().waitFor();
  const line = code(files, 8);
  if (mobile) await line.tap(); else await line.click();
  await noEditor(files);
  assert.ok((await selectAndCopy(line, mobile)).includes(SYNC[7]!), "code can be selected and copied unchanged");
  await noEditor(files);
  if (!mobile) {
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const ends = await line.evaluate((node) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let next = walker.nextNode(); next; next = walker.nextNode()) if ((next as Text).length) nodes.push(next as Text);
      const point = (text: Text, last: boolean) => {
        const range = document.createRange(), offset = last ? text.length - 1 : 0;
        range.setStart(text, offset); range.setEnd(text, offset + 1);
        const box = range.getBoundingClientRect();
        return { x: last ? box.right - 1 : box.left + 1, y: box.y + box.height / 2 };
      };
      return [point(nodes[0]!, false), point(nodes.at(-1)!, true)];
    });
    await page.mouse.move(ends[0]!.x, ends[0]!.y); await page.mouse.down();
    await page.mouse.move(ends[1]!.x, ends[1]!.y, { steps: 8 }); await page.mouse.up();
    assert.ok((await page.evaluate(() => window.getSelection()?.toString() ?? "")).includes("incoming.revision"), "real code-text dragging selects text");
    await noEditor(files);
  }
  assert.deepEqual(await stored(page), [], "plain clicks and selection save nothing");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  if (mobile) await number(files, 3).tap(); else await number(files, 3).click();
  await assertRange(files, 3);
  await discard(files);
  if (!mobile) {
    await number(files, 5).hover();
    await source(files).locator(".diff-comment-plus").click();
    await assertRange(files, 5);
    await discard(files);
  }
  // Both line-number drag directions and the custom + utility must preserve full ranges.
  await dragRange(files, 9, 7, mobile);
  await save(files, "Compare equal revisions before overwriting.");
  const saved = (await stored(page))[0]!;
  assert.deepEqual(saved.lines, [7, 9]);
  assert.deepEqual(saved.source, SYNC.slice(6, 9));
  assert.deepEqual(saved.quoteLines, SYNC.slice(6, 9), "quotes contain raw complete source lines");
  assert.equal(saved.view, "code");
  assert.equal(saved.selection, undefined, "gutter comments are whole-line targets, not text selections");
  assert.equal(saved.diff, undefined, "working-file comments do not acquire Git coordinates");

  await card(files, saved.comment).click();
  assert.equal(await field(files).inputValue(), saved.comment, "saved card opens directly into editing");
  await field(files).fill("Keep equal revisions safe.");
  for (const close of [
    () => editor(files).getByRole("button", { name: "Close comment", exact: true }).click(),
    () => files.getByRole("button", { name: "Close file", exact: true }).click(),
    () => files.getByRole("button", { name: "Close files", exact: true }).click(),
    () => page.keyboard.press("Escape"),
  ]) {
    await close(); await frames(page);
    assert.ok(await files.isVisible(), "dirty editor keeps Files open");
    assert.ok(await files.locator(".file-viewer-embedded").isVisible(), "dirty editor keeps its document open");
    assert.equal(await field(files).inputValue(), "Keep equal revisions safe.", "close attempts preserve the draft");
  }
  await save(files, "Keep equal revisions safe.");
  await dragRange(files, 4, 6, mobile, true);
  await save(files, "Describe the write contract.");
  const counter = files.locator(".file-viewer-comments");
  assert.equal((await counter.locator(".file-viewer-comments-count").innerText()).trim(), "2");
  const visited = new Set<string>();
  for (let i = 0; i < 2; i++) {
    await counter.click(); await field(files).waitFor();
    visited.add(await field(files).inputValue());
    await editor(files).getByRole("button", { name: "Close comment", exact: true }).click();
    await editor(files).waitFor({ state: "detached" });
  }
  assert.deepEqual([...visited].sort(), ["Describe the write contract.", "Keep equal revisions safe."].sort(), "header counter navigates saved notes rather than creating one");
  await card(files, "Describe the write contract.").click();
  await editor(files).getByRole("button", { name: "Delete comment", exact: true }).click();
  await editor(files).waitFor({ state: "detached" });
  assert.equal(await card(files, "Describe the write contract.").count(), 0);
  assert.equal((await stored(page)).length, 1, "delete removes only the requested note");
}

async function checkMarkdown(page: Page, files: Locator, mobile: boolean): Promise<void> {
  await openFile(files, "guide.md", mobile);
  const paragraph = files.locator(".file-viewer-markdown p").filter({ hasText: "Keep the newest revision." });
  if (mobile) await paragraph.tap(); else await paragraph.click();
  await noEditor(files);
  assert.equal(await selectAndCopy(paragraph, mobile), "Keep the newest revision.");
  await page.getByRole("button", { name: "Comment", exact: true }).waitFor();
  assert.equal(await editor(files).count(), 0, "selection waits for explicit Comment activation");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await field(files).fill("Clarify this rendered paragraph.");
  await editor(files).getByRole("button", { name: "Save comment", exact: true }).click();
  const note = (await stored(page)).find((note) => note.comment === "Clarify this rendered paragraph.")!;
  assert.equal(note.view, "preview");
  assert.deepEqual(note.lines, [3, 3]);
  assert.deepEqual(note.source, ["Keep the **newest** revision."]);
  assert.deepEqual(note.quoteLines, ["Keep the newest revision."]);
  assert.ok(note.selection, "preview retains the selected text coordinates");
  await page.waitForFunction(() => (CSS.highlights.get("block-comment")?.size ?? 0) > 0);
  await files.locator(".file-viewer-comments").click();
  assert.equal(await files.locator(".file-viewer-markdown").count(), 1, "comment navigation keeps rendered Markdown visible");
  assert.equal(await field(files).inputValue(), note.comment);
  await editor(files).getByRole("button", { name: "Close comment", exact: true }).click();
  const previewCard = files.locator(".preview-comments .diff-comment-card").filter({ hasText: note.comment });
  await previewCard.click();
  assert.equal(await field(files).inputValue(), note.comment);
  await editor(files).getByRole("button", { name: "Delete comment", exact: true }).click();
  assert.equal((await stored(page)).length, 1, "preview delete preserves source notes");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await files.getByRole("button", { name: "Show source", exact: true }).click();
  await number(files, 3).click();
  await assertRange(files, 3);
  await save(files, "Explain how conflicts are retried.");
}

async function checkLarge(page: Page, files: Locator, mobile: boolean): Promise<void> {
  await openFile(files, "large.ts", mobile);
  const virtual = files.locator(".virtual-source");
  await virtual.waitFor();
  assert.ok(await virtual.locator("[data-line]").count() < 2600, "large source is a window of rows, not the complete document");
  await dragRange(files, 2, 4, mobile);
  await save(files, "Keep the virtual source range.");
  assert.deepEqual((await stored(page)).find((note) => note.comment === "Keep the virtual source range.")!.quoteLines, LARGE.split("\n").slice(1, 4));
  if (mobile) {
    await code(files, 12).evaluate((node) => node.scrollIntoView({ block: "center" }));
    const row = await code(files, 12).boundingBox();
    assert.ok(row);
    const before = await files.locator(".virtual-source-scroll").evaluate((node) => node.scrollTop);
    await touchDrag(page, { x: row.x + row.width / 2, y: row.y + row.height / 2 }, { x: row.x + row.width / 2, y: row.y - 100 });
    await page.waitForFunction((before) => document.querySelector(".virtual-source-scroll")!.scrollTop > before, before);
    await noEditor(files);
  }
  await files.locator(".virtual-source-scroll").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await frames(page);
  await files.locator(".file-viewer-comments").click();
  await field(files).waitFor();
  assert.equal(await field(files).inputValue(), "Keep the virtual source range.", "counter reveals a saved virtual annotation after scrolling away");
  assert.ok(await field(files).isVisible());
  await editor(files).getByRole("button", { name: "Close comment", exact: true }).click();
  await editor(files).waitFor({ state: "detached" });
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n<script src="./source-fixture.js"></script>\n<script type="module"'));
  writeFileSync(join(app, "source-fixture.js"), `(() => {
    const bodies = ${JSON.stringify({ "sync.ts": SYNC.join("\n") + "\n", "guide.md": MARKDOWN, "large.ts": LARGE })};
    window.sourceSent = [];
    const DemoSocket = window.WebSocket;
    window.WebSocket = function(...args) {
      const socket = new DemoSocket(...args), send = socket.send.bind(socket);
      socket.send = raw => { const message = JSON.parse(raw); if (message.type === "submit") window.sourceSent.push(message); return send(raw); };
      return socket;
    };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    const demoFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url ?? String(input), location.href);
      const path = url.searchParams.get("path") || "", name = path.split("/").pop(), body = bodies[name];
      if (url.pathname.endsWith("/fs/stat") && body !== undefined) return Response.json({ path, name, size: new TextEncoder().encode(body).length, modified: "2026-01-01T00:00:00.000Z", mime: name.endsWith(".md") ? "text/markdown" : "text/plain", kind: "text" });
      if (url.pathname.endsWith("/fs/file") && body !== undefined) return new Response(body, { headers: { "content-type": "text/plain" } });
      if (url.pathname.endsWith("/pane/send") && init?.body) window.sourceSent.push(JSON.parse(init.body));
      const response = await demoFetch(input, init);
      if (url.pathname.endsWith("/workspace/directories") && response.ok) {
        const data = await response.json(); data.directories = []; data.ignored_directories = [];
        data.files = Object.entries(bodies).map(([name, body]) => ({ name, size: body.length }));
        return Response.json(data);
      }
      if (url.pathname.endsWith("/workspace/changes") && response.ok) { const data = await response.json(); data.files = []; return Response.json(data); }
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
      if (process.env.FILE_COMMENTS_CASE && !process.env.FILE_COMMENTS_CASE.split(",").includes(name)) continue;
      const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, locale: "en-US", serviceWorkers: "block" });
      try {
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", comments: true, view: "chat", theme: "dark" })));
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/index.html`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const files = await openFiles(page);
        await checkSource(page, files, mobile);
        await checkMarkdown(page, files, mobile);
        await checkLarge(page, files, mobile);
        await files.getByRole("button", { name: "Close files", exact: true }).click();
        await files.waitFor({ state: "detached" });
        const visited = new Set<string>();
        for (let i = 0; i < 3; i++) {
          await page.locator(".composer-comments-walk").first().click();
          const reopened = page.getByRole("dialog", { name: "Files", exact: true });
          await field(reopened).waitFor();
          visited.add(await field(reopened).inputValue());
          assert.equal(await reopened.locator(".file-viewer-markdown").count(), 0, "composer file-note navigation opens source, not Markdown preview");
          await reopened.getByRole("button", { name: "Close files", exact: true }).click();
          await reopened.waitFor({ state: "detached" });
        }
        assert.deepEqual([...visited].sort(), ["Keep equal revisions safe.", "Explain how conflicts are retried.", "Keep the virtual source range."].sort(), "composer walks all saved working-file notes");
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("Please review these source notes.");
        await page.locator(".composer-send").click();
        await page.waitForFunction(() => (window as unknown as { sourceSent: unknown[] }).sourceSent.length > 0);
        const sent = await page.evaluate(() => JSON.stringify((window as unknown as { sourceSent: unknown[] }).sourceSent));
        for (const quote of ["sync.ts:7-9", "guide.md:3", "large.ts:2-4", "Keep equal revisions safe.", "Explain how conflicts are retried.", "Keep the virtual source range.", "incoming.revision < stored.revision", "Keep the **newest** revision."]) assert.ok(sent.includes(quote), `next message includes ${quote}`);
        assert.ok(!sent.includes("Describe the write contract."), "deleted note is not quoted");
        assert.deepEqual(errors, [], "no browser exceptions");
        console.log(`PASS Source comments: ${name} gutter/+ ranges, edit/delete, dirty guards, Markdown source, virtual rows, navigation and sent quotes`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
