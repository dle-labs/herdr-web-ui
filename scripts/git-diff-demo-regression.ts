import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";

// The real client over fictional demo data, never an attached or mirrored user pane.
// CI copies its shared demo build; a standalone run builds its own copy.
const app = mkdtempSync(join(tmpdir(), "git-diff-regression-"));
const evidence = process.env.UI_EVIDENCE_DIR;
let activePage: Page | undefined;

async function frames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function openChanges(page: Page): Promise<Locator> {
  await page.locator(".header-more-button").click();
  await page.getByText("Browse files", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Files", exact: true });
  await dialog.locator(".changes-view").waitFor();
  return dialog;
}
const treeFile = (dialog: Locator, file: string) => dialog.locator(`.workspace-tree-row[title="${file}"]`);
const section = (dialog: Locator, path = "src/greeting.ts") => dialog.locator(`[data-diff-path="${path}"]`);
const number = (dialog: Locator, side: "old" | "new", line: number) => dialog.locator(`[data-code][data-${side === "old" ? "deletions" : "additions"}] [data-column-number="${line}"]`).first();
const field = (dialog: Locator) => dialog.locator(".diff-comment-editor").getByRole("textbox", { name: "Comment", exact: true });
async function selectComment(dialog: Locator, side: "old" | "new", first = 2, last = first): Promise<void> {
  const start = number(section(dialog), side, first);
  if (first === last) await start.click();
  else {
    await start.scrollIntoViewIfNeeded();
    const from = await start.boundingBox();
    const to = await number(section(dialog), side, last).boundingBox();
    assert.ok(from && to, "both range endpoints are rendered");
    const mouse = dialog.page().mouse;
    await mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await mouse.down();
    await mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
    assert.equal(await field(dialog).count(), 0, "drag does not open an editor until release");
    await mouse.up();
  }
  await field(dialog).waitFor();
  assert.equal(await field(dialog).evaluate((node) => node.tagName), "TEXTAREA", "comments use a plain textarea");
  if (first !== last) assert.ok((await dialog.locator(".diff-comment-editor .diff-comment-heading").innerText()).includes(`:${Math.min(first, last)}-${Math.max(first, last)}`), "drag preserves the complete line range");
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
  // Extend only fictional demo fixtures: a readable unchanged file, a long added
  // file for real scrolling, and revision changes for follow mode. Never use herdr.
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
      const parsed = new URL(url, location.href);
      if (parsed.pathname === "/api/voice" && response.ok) {
        const data = await response.json(); data.configured = !!window.gitVoiceConfigured; return Response.json(data);
      }
      if (url.includes("/workspace/directories") && response.ok) {
        const data = await response.json();
        data.files = data.path.endsWith("/src")
          ? [{ name: "greeting.ts", size: 90 }, { name: "new.ts", size: 3000 }]
          : [{ name: "unchanged.ts", size: 35 }];
        return Response.json(data);
      }
      if (parsed.pathname.endsWith("/fs/stat")) return Response.json({ path: parsed.searchParams.get("path"), name: "unchanged.ts", size: 35, modified: "2026-01-01T00:00:00.000Z", mime: "text/plain", kind: "text" });
      if (parsed.pathname.endsWith("/fs/file")) return new Response("export const unchanged = true;\\n", { headers: { "content-type": "text/plain" } });
      if ((url.includes("/workspace/changes") || url.includes("/workspace/diff")) && response.ok) {
        const data = await response.json();
        if (window.gitRevision) data.revision += "-follow-" + window.gitRevision;
        if (url.includes("/workspace/changes") && window.gitEmpty) data.files = [];
        if (data.path === "src/new.ts") {
          data.new_file.contents = Array.from({ length: 90 }, (_, i) => "export const line" + i + " = " + (i + (window.gitRevision || 0)) + ";").join("\\n") + "\\n";
          data.patch = "diff --git a/src/new.ts b/src/new.ts\\nnew file mode 100644\\n--- /dev/null\\n+++ b/src/new.ts\\n@@ -0,0 +1,90 @@\\n" + data.new_file.contents.trimEnd().split("\\n").map(line => "+" + line).join("\\n") + "\\n";
        }
        return Response.json(data);
      }
      return response;
    };
  })();`);
  // A static-only server makes accidental live API access impossible and needs no
  // dist/index.html from another build running concurrently in this checkout.
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/api/") || pathname === "/ws") return new Response("Unexpected real API request", { status: 404 });
    const file = Bun.file(join(app, pathname === "/" ? "index.html" : pathname));
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const url = `http://127.0.0.1:${server.port}/index.html`;
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
        const shortcut = page.locator(".composer-changes").first();
        await shortcut.waitFor();
        assert.equal(await shortcut.evaluate((node) => node.nextElementSibling?.classList.contains("agent-mark")), true, "changes shortcut is immediately before the agent mark");
        await shortcut.click();
        await page.getByRole("dialog", { name: "Files", exact: true }).getByRole("button", { name: "Close files", exact: true }).click();
        const dialog = await openChanges(page);
        await section(dialog).locator('[data-diff-type]').waitFor();
        assert.equal(await dialog.locator('[data-diff-path]').count(), 2, "Browse files immediately mounts the continuous diff document");
        const bounds = await dialog.boundingBox();
        const viewport = page.viewportSize()!;
        assert.ok(bounds && bounds.width >= viewport.width - 2 && bounds.height >= viewport.height - 2, "Files occupies the full viewport");
        assert.equal(await dialog.getByRole("tab").count(), 0, "there are no Files/Changes tabs");
        if (mobile) await dialog.getByRole("button", { name: "Files", exact: true }).click();
        await treeFile(dialog, "src/greeting.ts").waitFor();
        await treeFile(dialog, "src/new.ts").waitFor();
        assert.equal(await treeFile(dialog, "src/greeting.ts").getAttribute("data-status"), "modified");
        assert.equal(await treeFile(dialog, "src/new.ts").getAttribute("data-status"), "untracked");
        assert.equal(await treeFile(dialog, "unchanged.ts").getAttribute("data-status"), null);
        await treeFile(dialog, "unchanged.ts").click();
        await dialog.locator('.file-viewer-embedded [role="region"]').waitFor();
        await dialog.locator(".file-viewer-embedded").getByText("export const unchanged = true;", { exact: false }).first().waitFor();
        await dialog.locator(".file-viewer-embedded .hl-keyword").first().waitFor();
        assert.equal(await page.getByRole("dialog").count(), 1, "unchanged preview stays inside Files");
        await dialog.getByRole("button", { name: "All changes", exact: true }).click();
        if (mobile) {
          assert.equal(await section(dialog).locator('[data-diff-type]').getAttribute("data-diff-type"), "single");
          assert.equal(await dialog.locator(".changes-navigation").isVisible(), false, "mobile detail replaces the tree");
          await dialog.getByRole("button", { name: "Files", exact: true }).click();
          await treeFile(dialog, "src/new.ts").click();
          await section(dialog, "src/new.ts").locator('[data-diff-type="single"]').waitFor();
          assert.equal(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth), false, "phone dialog does not overflow");
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, "git-changes-mobile.png") }); }
          await dialog.getByRole("button", { name: "Close files", exact: true }).click();
          console.log("PASS Git Changes: phone tree, embedded preview, unified diff and back navigation");
        } else {
          assert.equal(await section(dialog).locator('[data-diff-type]').getAttribute("data-diff-type"), "split");
          await dialog.getByRole("button", { name: "Unified", exact: true }).click();
          await section(dialog).locator('[data-diff-type="single"]').waitFor();
          await dialog.getByRole("button", { name: "Split", exact: true }).click();
          await section(dialog).locator('[data-diff-type="split"]').waitFor();
          for (const name of ["Wrap long lines", "Highlight code"]) {
            const control = dialog.locator(".changes-toolbar").getByRole("button", { name, exact: true });
            const original = await control.getAttribute("aria-pressed");
            await control.click();
            assert.notEqual(await control.getAttribute("aria-pressed"), original, `${name} toggles`);
            if (name === "Highlight code") {
              await page.waitForFunction(() => !document.querySelector('[data-diff-path="src/greeting.ts"] diffs-container')?.shadowRoot?.querySelector('[data-code] span[style*="syntax-"]'));
            }
            await control.click();
            assert.equal(await control.getAttribute("aria-pressed"), original);
            if (name === "Highlight code") await section(dialog).locator('[data-code] span[style*="syntax-"]').first().waitFor();
          }
          await section(dialog, "src/new.ts").locator('[data-diff-type]').waitFor();
          await page.mouse.move(1, 1); // No section hover may influence the scroll-selection assertion.
          await dialog.locator(".changes-detail").evaluate((node) => { const next = node.querySelector('[data-diff-path="src/new.ts"]')!; node.scrollTop += next.getBoundingClientRect().top - node.getBoundingClientRect().top; });
          await page.waitForFunction(() => document.querySelector('.workspace-tree-row[title="src/new.ts"]')?.getAttribute("aria-current") === "true");
          assert.equal(await dialog.locator('[data-diff-path]').count(), 2, "scrolling preserves both diff sections");
          await treeFile(dialog, "src/greeting.ts").click();
          const follow = dialog.getByRole("button", { name: "Follow edits", exact: true });
          await follow.click();
          assert.equal(await follow.getAttribute("aria-pressed"), "true");
          await page.evaluate(() => { (window as any).gitRevision = 1; });
          await section(dialog, "src/new.ts").getByText("export const line0 = 1;", { exact: false }).first().waitFor();
          await page.waitForFunction(() => document.querySelector('.workspace-tree-row[title="src/new.ts"]')?.getAttribute("aria-current") === "true");
          await treeFile(dialog, "src/greeting.ts").click();
          assert.equal(await follow.getAttribute("aria-pressed"), "false", "explicit file navigation stops follow");
          const compare = dialog.getByRole("combobox");
          await compare.selectOption("staged");
          await page.waitForFunction(() => {
            const file = document.querySelector('.workspace-tree-row[title="src/new.ts"]');
            return file !== null && !file.hasAttribute("data-status");
          });
          assert.equal(await section(dialog, "src/new.ts").count(), 0, "unstaged files stay in the tree but not the staged diff document");
          await treeFile(dialog, "src/greeting.ts").waitFor();
          await compare.selectOption("unstaged");
          await section(dialog, "src/new.ts").waitFor();
          await compare.selectOption("all");
          await number(section(dialog), "new", 2).waitFor();
          const line = number(section(dialog), "new", 2);
          await line.hover();
          const plus = section(dialog).getByRole("button", { name: "Add comment", exact: true });
          await plus.click();
          await field(dialog).waitFor();
          const microphone = dialog.locator(".diff-comment-editor").getByRole("button", { name: "Start dictation", exact: true });
          assert.equal(await microphone.count(), 0, "unconfigured dictation is not offered");
          await page.evaluate(() => { (window as any).gitVoiceConfigured = true; window.dispatchEvent(new Event("herdr-voice-status-changed")); });
          await microphone.waitFor();
          assert.equal(await microphone.isEnabled(), true, "configured dictation is available in the comment");
          await page.evaluate(() => { (window as any).gitVoiceConfigured = false; window.dispatchEvent(new Event("herdr-voice-status-changed")); });
          await microphone.waitFor({ state: "detached" });
          await line.hover();
          await plus.click();
          await field(dialog).waitFor({ state: "detached" });
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
          console.log("PASS Git Changes: continuous scroll, preview, follow, controls, comparisons, gutter toggle, mouse range, dirty guards and composer send");
        }
        // An empty repository uses the same response contract, mocked only in this page.
        await page.evaluate(() => { (window as any).gitEmpty = true; });
        const empty = await openChanges(page);
        await empty.getByText("No changes in this comparison.", { exact: true }).waitFor();
        assert.equal(await empty.locator("[data-diff-path]").count(), 0);
        if (mobile) await empty.getByRole("button", { name: "Files", exact: true }).click();
        await treeFile(empty, "unchanged.ts").waitFor();
        assert.deepEqual(errors, [], "no browser exceptions");
        console.log(`PASS Git Changes: ${mobile ? "phone" : "desktop"} empty comparison`);
      } catch (error) {
        if (activePage && evidence) {
          mkdirSync(evidence, { recursive: true });
          await activePage.screenshot({ path: join(evidence, "git-changes-failure.png") }).catch(() => {});
          writeFileSync(join(evidence, "git-changes-failure.html"), await activePage.evaluate(() => {
            const expand = (node: Element): string => node.outerHTML + (node.shadowRoot ? [...node.shadowRoot.children].map(expand).join("\n") : "") + [...node.children].map(expand).join("\n");
            return [...document.querySelectorAll(".changes-view")].map(expand).join("\n");
          }));
        }
        throw error;
      } finally { activePage = undefined; await context.close(); }
    }
  } catch (error) {
    if (activePage && evidence) { mkdirSync(evidence, { recursive: true }); await activePage.screenshot({ path: join(evidence, "git-changes-failure.png") }).catch(() => {}); }
    throw error;
  } finally { await browser.close(); server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
