import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { buildDemoApp } from "./demo-build.ts";

// The real client over fictional demo data, never an attached or mirrored user pane.
// CI copies its shared demo build; a standalone run builds its own copy.
const dist = join(import.meta.dir, "../dist/demo");
mkdirSync(dist, { recursive: true });
const app = mkdtempSync(join(dist, "git-diff-regression-"));
const state = mkdtempSync(join(tmpdir(), "herdr-git-diff-demo-"));
process.env.HERDR_SOCKET = join(state, "no-herdr.sock");
const evidence = process.env.UI_EVIDENCE_DIR;
let activePage: Page | undefined;

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function openChanges(page: Page): Promise<Locator> {
  await page.locator(".header-more-button").click();
  await page.getByText("Browse files", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Files", exact: true });
  await dialog.getByRole("button", { name: "Changes", exact: true }).click();
  await dialog.locator(".changes-view").waitFor();
  return dialog;
}
const treeFile = (dialog: Locator, file: string) => dialog.locator("file-tree-container").getByRole("treeitem", { name: file, exact: true });
const number = (dialog: Locator, side: "old" | "new", line: number) => dialog.locator(`[data-code][data-${side === "old" ? "deletions" : "additions"}] [data-column-number="${line}"]`).first();
const field = (dialog: Locator) => dialog.locator(".diff-comment-editor").getByRole("textbox", { name: "Comment", exact: true });
async function selectComment(dialog: Locator, side: "old" | "new", first = 2, last = first): Promise<void> {
  await number(dialog, side, first).click();
  // Pierre toggles an existing single-line selection off by number, even across sides.
  const add = dialog.locator(".diff-comment-tools").getByRole("button", { name: "Add comment", exact: true });
  if (await add.isDisabled()) await number(dialog, side, first).click();
  if (last !== first) await number(dialog, side, last).click({ modifiers: ["Shift"] });
  await dialog.locator(".diff-comment-tools").getByRole("button", { name: "Add comment", exact: true }).click();
  await field(dialog).waitFor();
}
async function saveComment(dialog: Locator, text: string): Promise<void> {
  await field(dialog).fill(text);
  await dialog.getByRole("button", { name: "Save comment", exact: true }).click();
  await dialog.locator(".diff-comment-editor").waitFor({ state: "detached" });
  await dialog.getByText(text, { exact: true }).waitFor();
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n<script src="./regression-patch.js"></script>\n<script type="module"'));
  // Mock only an empty inventory and observe sends, retaining the demo's actual fixture endpoints.
  writeFileSync(join(app, "regression-patch.js"), `(() => {
    const demoFetch = window.fetch;
    window.gitRequests = []; window.gitSent = [];
    const DemoSocket = window.WebSocket;
    window.WebSocket = function(...args) {
      const socket = new DemoSocket(...args), send = socket.send.bind(socket);
      socket.send = (raw) => { const message = JSON.parse(raw); if (message.type === "submit") window.gitSent.push(message); return send(raw); };
      return socket;
    };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.fetch = async (input, init) => {
      const url = String(typeof input === "string" ? input : input.url ?? input);
      if (url.includes("/workspace/changes") || url.includes("/workspace/diff")) window.gitRequests.push(url);
      if (url.includes("/pane/send") && init?.body) window.gitSent.push(JSON.parse(init.body));
      const response = await demoFetch(input, init);
      if (window.gitEmpty && url.includes("/workspace/changes") && response.ok) {
        const data = await response.json(); data.files = []; return Response.json(data);
      }
      return response;
    };
  })();`);
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: "", machines: false, terminalAttach: false });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const url = `http://127.0.0.1:${server.port}/demo/${app.split("/").at(-1)}/index.html`;
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, locale: "en-US", serviceWorkers: "block" });
      try {
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", comments: true, view: "chat", theme: "dark" })));
        const page = await context.newPage(); activePage = page;
        page.setDefaultTimeout(10_000);
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const dialog = await openChanges(page);
        await treeFile(dialog, "greeting.ts").waitFor();
        await treeFile(dialog, "new.ts").waitFor();
        if (mobile) {
          // Activating the initially selected row must open detail too, without a selection change.
          await treeFile(dialog, "greeting.ts").click();
          await dialog.locator(".changes-view.is-showing-file").waitFor();
          await dialog.locator('[data-diff-type="single"]').waitFor();
          await dialog.getByRole("button", { name: "Changed files", exact: true }).click();
        }
        const search = dialog.getByRole("searchbox", { name: "Filter changed files", exact: true });
        await search.fill("new.ts");
        await treeFile(dialog, "greeting.ts").waitFor({ state: "hidden" });
        await treeFile(dialog, "new.ts").waitFor();
        await search.press("Escape");
        assert.equal(await search.inputValue(), "");
        await treeFile(dialog, "greeting.ts").click();
        await dialog.locator('[data-diff-type]').waitFor();
        if (mobile) {
          assert.equal(await dialog.locator('[data-diff-type]').getAttribute("data-diff-type"), "single");
          assert.equal(await search.isVisible(), false, "mobile detail replaces the tree");
          await dialog.getByRole("button", { name: "Changed files", exact: true }).click();
          await search.waitFor();
          await treeFile(dialog, "new.ts").click();
          assert.equal(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth), false, "phone dialog does not overflow");
          await dialog.getByRole("button", { name: "Close files", exact: true }).click();
          console.log("PASS Git Changes: phone tree, unified diff and back navigation");
        } else {
          assert.equal(await dialog.locator('[data-diff-type]').getAttribute("data-diff-type"), "split");
          await dialog.getByRole("button", { name: "Unified", exact: true }).click();
          await dialog.locator('[data-diff-type="single"]').waitFor();
          await dialog.getByRole("button", { name: "Split", exact: true }).click();
          await dialog.locator('[data-diff-type="split"]').waitFor();
          const compare = dialog.getByRole("combobox");
          await compare.selectOption("staged");
          await treeFile(dialog, "new.ts").waitFor({ state: "hidden" });
          await treeFile(dialog, "greeting.ts").waitFor();
          await compare.selectOption("unstaged");
          await treeFile(dialog, "new.ts").waitFor();
          await compare.selectOption("all");
          await number(dialog, "new", 2).waitFor();
          await selectComment(dialog, "new");
          await field(dialog).fill("Preserve this draft");
          const requests = await page.evaluate(() => (window as any).gitRequests.length);
          await dialog.getByRole("button", { name: "Refresh changes", exact: true }).click();
          await dialog.getByRole("button", { name: "Close files", exact: true }).click();
          await page.keyboard.press("Escape");
          await frames(page);
          assert.ok(await dialog.isVisible(), "dirty editor keeps the Files dialog open");
          assert.equal(await field(dialog).inputValue(), "Preserve this draft");
          assert.equal(await page.evaluate(() => (window as any).gitRequests.length), requests, "dirty editor blocks refresh requests");
          await saveComment(dialog, "Review the new greeting");
          await selectComment(dialog, "old");
          await saveComment(dialog, "Explain the old greeting");
          await selectComment(dialog, "new", 1, 3);
          await saveComment(dialog, "Review the whole function");
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, "git-changes-desktop.png") }); }
          await dialog.getByRole("button", { name: "Close files", exact: true }).click();
          await page.locator(".composer-comments-bar").waitFor();
          await page.getByRole("textbox", { name: "Message", exact: true }).fill("Please review these changes.");
          await page.locator(".composer-send").click();
          await page.waitForFunction(() => (window as any).gitSent.length > 0);
          const sent = await page.evaluate(() => JSON.stringify((window as any).gitSent));
          assert.match(sent, /src\/greeting\.ts:2 \(new;all;/);
          assert.match(sent, /src\/greeting\.ts:2 \(old;all;/);
          assert.match(sent, /src\/greeting\.ts:1-3 \(new;all;/);
          assert.match(sent, /Review the new greeting/); assert.match(sent, /Explain the old greeting/);
          console.log("PASS Git Changes: split/unified, comparisons, search, line/range comments, dirty guards and composer send");
        }
        // An empty repository uses the same response contract, mocked only in this page.
        await page.evaluate(() => { (window as any).gitEmpty = true; });
        const empty = await openChanges(page);
        await empty.getByText("No changes in this comparison.", { exact: true }).waitFor();
        assert.equal(await empty.locator("file-tree-container").count(), 0);
        assert.deepEqual(errors, [], "no browser exceptions");
        console.log(`PASS Git Changes: ${mobile ? "phone" : "desktop"} empty comparison`);
      } catch (error) {
        if (activePage && evidence) {
          mkdirSync(evidence, { recursive: true });
          await activePage.screenshot({ path: join(evidence, "git-changes-failure.png") }).catch(() => {});
          writeFileSync(join(evidence, "git-changes-failure.html"), await activePage.evaluate(() => {
            const expand = (node: Element): string => node.outerHTML + (node.shadowRoot ? [...node.shadowRoot.children].map(expand).join("\n") : "") + [...node.children].map(expand).join("\n");
            return [...document.querySelectorAll(".changes-tree-panel, .diff-viewer")].map(expand).join("\n");
          }));
        }
        throw error;
      } finally { activePage = undefined; await context.close(); }
    }
  } catch (error) {
    if (activePage && evidence) { mkdirSync(evidence, { recursive: true }); await activePage.screenshot({ path: join(evidence, "git-changes-failure.png") }).catch(() => {}); }
    throw error;
  } finally { await browser.close(); server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
