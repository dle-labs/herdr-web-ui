import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import { VOICE_CONFIG_EVENT } from "../src/lib/voice.ts";

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
const number = (dialog: Locator, side: "old" | "new", line: number) => dialog.locator(
  `[data-code][data-${side === "old" ? "deletions" : "additions"}] [data-column-number="${line}"], ` +
  `[data-code][data-unified] [data-line-type="change-${side === "old" ? "deletion" : "addition"}"][data-column-number="${line}"]`,
).first();
const field = (dialog: Locator) => dialog.locator(".diff-comment-editor").getByRole("textbox", { name: "Comment", exact: true });
async function selectComment(dialog: Locator, side: "old" | "new", first = 2, last = first): Promise<void> {
  const start = number(section(dialog), side, first);
  if (first === last) await start.click();
  else {
    // Annotation updates can replace gutter nodes while Playwright waits for
    // scroll stability. Resolve the live locator and scroll in the same task.
    await start.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
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
  // Extend only fictional demo fixtures with readable files, ignored folders and
  // a long added file for real scrolling. Never use herdr.
  writeFileSync(join(app, "regression-patch.js"), `(() => {
    const demoFetch = window.fetch;
    window.gitRequests = []; window.gitSent = [];
    const markdownFiles = [
      { path: "docs/untracked.md", status: "untracked", heading: "Untracked guide" },
      { path: "docs/added.md", status: "added", heading: "Added guide" },
      { path: "docs/modified.md", status: "modified", heading: "Modified guide" },
    ];
    const markdownBody = (file) => "# " + file.heading + "\\n\\nCurrent **Markdown** content.\\n";
    const DemoWorker = window.Worker;
    window.Worker = class extends DemoWorker {
      constructor(url, options) { super(url, options); this.markdownPreview = String(url).includes("markdownPreview"); }
      postMessage(message, ...rest) {
        if (window.gitMarkdownRefuse && this.markdownPreview) {
          window.gitMarkdownRefusals = (window.gitMarkdownRefusals || 0) + 1;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, result: null } })));
        } else super.postMessage(message, ...rest);
      }
    };
    window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
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
      const parsed = new URL(url, location.href);
      if (window.gitDiffFailure && parsed.pathname.endsWith("/workspace/diff") && parsed.searchParams.get("path") === "docs/modified.md") return Response.json({ error: { code: "git_too_large", message: "Fixture diff unavailable" } }, { status: 413 });
      if (window.gitMarkdownCase) {
        const path = parsed.searchParams.get("path") || "";
        const markdown = markdownFiles.find(file => path === file.path || path.endsWith("/" + file.path));
        if (parsed.pathname.endsWith("/workspace/diff") && markdown) {
          const changesUrl = new URL(parsed); changesUrl.pathname = changesUrl.pathname.replace(/diff$/, "changes");
          const changes = await (await demoFetch(changesUrl.href)).json();
          const body = markdownBody(markdown), modified = markdown.status === "modified";
          const old = "# " + markdown.heading + "\\n\\nPrevious Markdown content.\\n";
          return Response.json({ root: changes.root, revision: changes.revision + "-markdown", path: markdown.path, binary: false,
            old_file: modified ? { name: markdown.path, contents: old } : null,
            new_file: { name: markdown.path, contents: body },
            patch: "diff --git a/" + markdown.path + " b/" + markdown.path + "\\n" +
              (modified ? "--- a/" + markdown.path : "new file mode 100644\\n--- /dev/null") + "\\n+++ b/" + markdown.path + "\\n" +
              (modified ? "@@ -1,3 +1,3 @@\\n # " + markdown.heading + "\\n \\n-Previous Markdown content.\\n+Current **Markdown** content.\\n"
                : "@@ -0,0 +1,3 @@\\n" + body.trimEnd().split("\\n").map(line => "+" + line).join("\\n") + "\\n") });
        }
        if (markdown && parsed.pathname.endsWith("/fs/stat")) return Response.json({ path, name: markdown.path.split("/").pop(), size: markdownBody(markdown).length, modified: "2026-01-01T00:00:00.000Z", mime: "text/markdown", kind: "text" });
        if (markdown && parsed.pathname.endsWith("/fs/file")) return new Response(markdownBody(markdown), { headers: { "content-type": "text/markdown" } });
      }
      const response = await demoFetch(input, init);
      if (window.gitManyCommitResults && parsed.pathname.endsWith("/workspace/commits") && response.ok) {
        const data = await response.json();
        data.commits = Array.from({ length: 12 }, (_, i) => ({ id: (i + 1).toString(16).padStart(40, "0"), subject: "Overlay commit " + i + " with a long fictional subject", author: "Fictional author", date: "2026-01-01" }));
        data.truncated = false;
        return Response.json(data);
      }
      if (window.gitManySearchResults && parsed.pathname.endsWith("/workspace/files") && response.ok) {
        const data = await response.json();
        data.files = Array.from({ length: 12 }, (_, i) => "src/nested/long-search-result-path-" + String(i).padStart(2, "0") + ".ts");
        data.truncated = false;
        return Response.json(data);
      }
      if (parsed.pathname === "/api/voice" && response.ok) {
        const data = await response.json(); data.configured = !!window.gitVoiceConfigured; return Response.json(data);
      }
      if (url.includes("/workspace/directories") && response.ok) {
        const data = await response.json();
        if (window.gitMarkdownCase && data.path.endsWith("/docs")) {
          data.directories = []; data.ignored_directories = [];
          data.files = markdownFiles.map(file => ({ name: file.path.split("/").pop(), size: markdownBody(file).length }));
          return Response.json(data);
        }
        const source = data.path.endsWith("/src"), ignored = data.path.endsWith("/ignored"), nested = data.path.endsWith("/ignored/nested");
        data.directories = source || nested ? [] : ignored ? ["nested"] : ["src", "ignored"];
        if (window.gitMarkdownCase && !source && !ignored && !nested) data.directories.push("docs");
        data.ignored_directories = source || ignored || nested ? [] : ["ignored"];
        data.files = source ? [{ name: "greeting.ts", size: 90 }, { name: "new.ts", size: 3000 }]
          : ignored || nested ? [{ name: "hidden.txt", size: 35 }]
          : [{ name: "unchanged.ts", size: 35 }, { name: "notes.md", size: 35 }, { name: "picture.png", size: 35 }];
        return Response.json(data);
      }
      if (parsed.pathname.endsWith("/fs/stat")) return Response.json({ path: parsed.searchParams.get("path"), name: "unchanged.ts", size: 35, modified: "2026-01-01T00:00:00.000Z", mime: "text/plain", kind: "text" });
      if (parsed.pathname.endsWith("/fs/file")) return new Response("export const unchanged = true;\\n", { headers: { "content-type": "text/plain" } });
      if ((url.includes("/workspace/changes") || url.includes("/workspace/diff")) && response.ok) {
        const data = await response.json();
        if (window.gitMarkdownCase && url.includes("/workspace/changes")) {
          data.files = markdownFiles.map(({ path, status }) => ({ path, status }));
          data.revision += "-markdown";
          window.gitMarkdownRoot = data.root;
        }
        if (window.gitNested && url.includes("/workspace/changes")) data.files.push({ path: "deep/inside/nested/changed.ts", status: "modified" });
        if (window.gitRevision) data.revision += "-follow-" + window.gitRevision;
        if (window.gitLongContext) {
          data.revision += "-long-context";
          if (data.path === "src/greeting.ts") {
            const oldLines = Array.from({ length: 240 }, (_, i) => "export const context" + (i + 1) + " = " + i + ";");
            const newLines = oldLines.slice();
            for (const line of [70, 180]) newLines[line - 1] = "export const context" + line + " = updated;";
            data.old_file.contents = oldLines.join("\\n") + "\\n";
            data.new_file.contents = newLines.join("\\n") + "\\n";
            data.patch = "diff --git a/src/greeting.ts b/src/greeting.ts\\n--- a/src/greeting.ts\\n+++ b/src/greeting.ts\\n" + [70, 180].map(line => {
              const start = line - 23, end = line + 23;
              return "@@ -" + start + ",47 +" + start + ",47 @@\\n" + oldLines.slice(start - 1, end).map((text, i) => start + i === line ? "-" + text + "\\n+" + newLines[line - 1] : " " + text).join("\\n") + "\\n";
            }).join("");
          }
        }
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
    for (const mobile of [true, false]) {
      const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile, locale: "en-US", serviceWorkers: "block" });
      try {
        await context.addInitScript(() => { if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", comments: true, view: "chat", theme: "dark" })); });
        const page = await context.newPage(); activePage = page;
        page.setDefaultTimeout(10_000);
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => { if (message.type() === "error") console.error(message.text()); });
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        if (mobile) await page.locator(".tab-strip-menu").first().click();
        else await page.locator(".pane-frame.is-current").first().click({ button: "right", position: { x: 12, y: 12 } });
        await page.getByRole(mobile ? "button" : "menuitem", { name: "Split right", exact: true }).waitFor();
        assert.equal(await page.getByRole(mobile ? "button" : "menuitem", { name: "Changed files", exact: true }).count(), 0, "Changed files is no longer a pane/tab menu action");
        await page.keyboard.press("Escape");
        await page.locator(".composer-browse .browse-files-dot").waitFor();
        await page.keyboard.press("ControlOrMeta+Shift+Comma");
        await openSettingsPage(page, "File viewer");
        let shortcutSettings = page.getByRole("dialog", { name: "Settings", exact: true });
        await shortcutSettings.getByRole("switch", { name: "Show Browse files shortcut", exact: true }).click();
        assert.equal(await page.locator(".composer-browse").count(), 0, "shortcut can be hidden without removing the menu action");
        await shortcutSettings.getByRole("button", { name: "Close settings", exact: true }).click();
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".composer").waitFor();
        assert.equal(await page.locator(".composer-browse").count(), 0, "shortcut setting survives reload");
        await page.locator(".header-more-button").click();
        const browseEntry = page.getByRole(mobile ? "button" : "menuitem", { name: "Browse files", exact: true });
        await browseEntry.locator(".browse-files-dot").waitFor();
        await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+Shift+Comma");
        await openSettingsPage(page, "File viewer");
        shortcutSettings = page.getByRole("dialog", { name: "Settings", exact: true });
        assert.equal(await shortcutSettings.getByRole("switch", { name: "Show Browse files shortcut", exact: true }).getAttribute("aria-checked"), "false");
        await shortcutSettings.getByRole("switch", { name: "Show Browse files shortcut", exact: true }).click();
        await shortcutSettings.getByRole("button", { name: "Close settings", exact: true }).click();
        await page.locator(".composer-browse .browse-files-dot").waitFor();
        console.log(`PASS Git Changes: ${mobile ? "phone" : "desktop"} shortcut setting, persistence and menu/shortcut dots`);
        const openPaneChanges = async () => {
          assert.ok(await page.locator(".composer-browse").evaluate((button) => button.previousElementSibling?.matches(".voice-mic, .composer-attach")), "file quick action is immediately beside microphone or plus");
          await page.locator(".composer").getByRole("button", { name: "Browse files", exact: true }).click();
        };
        await openPaneChanges();
        await page.getByRole("dialog", { name: "Files", exact: true }).getByRole("button", { name: "Close files", exact: true }).click();
        await page.waitForFunction(() => !history.state?.["herdr-web-ui:sheet"]);
        const dialog = await openChanges(page);
        await dialog.locator(".workspace-file-tree").waitFor();
        assert.equal(await dialog.locator('[data-diff-path], .file-viewer-embedded').count(), 0, "opening Files does not load a diff automatically");
        assert.equal(await dialog.locator('.workspace-tree-row[aria-current="true"]').count(), 0, "opening Files selects no file");
        const bounds = await dialog.boundingBox();
        const viewport = page.viewportSize()!;
        assert.ok(bounds && bounds.width <= (mobile ? viewport.width : Math.min(viewport.width * .96, 1100)) + 2 && bounds.height <= viewport.height * .92 + 2, "Files is a bounded dialog or full-width 92% phone sheet");
        if (!mobile) assert.ok(bounds && Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 2, "desktop Files is centered");
        assert.equal(await page.getByRole("dialog").count(), 1, "there is one Files dialog");
        assert.equal(await dialog.getByRole("tab").count(), 0, "there are no Files/Changes tabs");
        assert.equal(await dialog.locator(".changes-toolbar, .changes-filepath, .changes-path").count(), 0, "old changes toolbar and file path bar are absent");
        assert.equal(await dialog.getByRole("combobox", { name: "Compare", exact: true }).count(), 0, "the retired mode selector is absent");
        for (const name of ["Compare", "Follow edits", "Open file", "All changes", "Wrap long lines", "Highlight code"]) {
          assert.equal(await dialog.getByRole("button", { name, exact: true }).count(), 0, `${name} is not a Files control`);
        }
        assert.equal(await dialog.locator(".modal-header").getByRole("button", { name: "Refresh changes", exact: true }).count(), 1, "refresh is in the modal header");
        assert.equal(await dialog.locator(".modal-header").getByRole("combobox", { name: "Find files…", exact: true }).count(), 1, "filename search is in the modal header");
        assert.equal(await dialog.locator(".modal-header").getByRole("button", { name: "Compare with…", exact: true }).count(), 1, "Compare with is in the modal header");
        assert.equal(await dialog.locator(".workspace-file-search-field svg").count(), 0, "the redundant search icon is removed");
        assert.ok(await dialog.locator(".files-dialog-header").evaluate((node) => {
          const style = getComputedStyle(node);
          return Number.parseFloat(style.columnGap) > Number.parseFloat(style.getPropertyValue("--space-2"));
        }), "header controls have wider horizontal spacing");
        assert.equal(await dialog.locator(".modal-body .workspace-file-search, .workspace-file-tools").count(), 0, "there is no separate search toolbar in the body");
        await frames(page);
        assert.equal(await dialog.getByRole("combobox", { name: "Find files…", exact: true }).getAttribute("aria-expanded"), "false", "opening Files never auto-opens a search dropdown over its content");
        if (mobile) {
          assert.equal(await dialog.locator(".changes-navigation").isVisible(), true, "Browse files starts on the phone tree");
          assert.equal(await dialog.locator(".changes-detail").isVisible(), false, "detail does not cover the initial phone tree");
        }
        await treeFile(dialog, "src").click();
        await treeFile(dialog, "src/greeting.ts").waitFor();
        await treeFile(dialog, "src/new.ts").waitFor();
        assert.equal(await treeFile(dialog, "src/greeting.ts").getAttribute("data-status"), "modified");
        assert.equal(await treeFile(dialog, "src/new.ts").getAttribute("data-status"), "untracked");
        assert.equal(await treeFile(dialog, "unchanged.ts").getAttribute("data-status"), null);
        const heights = await dialog.locator(".workspace-tree-row").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
        assert.ok(heights.length > 0 && heights.every((height) => height > 0 && height <= 32), "tree rows are compact, at most 32px");
        const icons = await Promise.all(["unchanged.ts", "notes.md", "picture.png"].map((path) => treeFile(dialog, path).locator("svg").evaluate((svg) => svg.outerHTML)));
        assert.equal(new Set(icons).size, 3, "code, Markdown and image files have different file-type icons");
        const iconColors = await Promise.all(["unchanged.ts", "notes.md", "picture.png"].map((path) => treeFile(dialog, path).locator(".workspace-tree-icon").evaluate((icon) => getComputedStyle(icon).color)));
        assert.equal(new Set(iconColors).size, 3, "code, Markdown and image icons have distinct theme-aware colors");
        const ignored = treeFile(dialog, "ignored");
        assert.equal(await ignored.getAttribute("data-ignored"), "true");
        await ignored.click();
        await treeFile(dialog, "ignored/hidden.txt").waitFor();
        await treeFile(dialog, "ignored/nested").click();
        const inherited = treeFile(dialog, "ignored/nested/hidden.txt");
        await inherited.waitFor();
        assert.equal(await inherited.getAttribute("data-ignored"), "true", "ignored state propagates through expanded directories");
        assert.equal(await inherited.evaluate((row) => getComputedStyle(row).color), await ignored.evaluate((row) => getComputedStyle(row).color), "ignored descendants retain dim styling");
        assert.notEqual(await ignored.evaluate((row) => getComputedStyle(row).color), await treeFile(dialog, "unchanged.ts").evaluate((row) => getComputedStyle(row).color), "ignored folders are dimmer than ordinary rows");
        const ignoredColor = await ignored.evaluate((row) => getComputedStyle(row).color);
        assert.equal(await ignored.locator(".workspace-tree-icon").evaluate((icon) => getComputedStyle(icon).color), ignoredColor, "ignored folder icons remain gray");
        assert.equal(await inherited.locator(".workspace-tree-icon").evaluate((icon) => getComputedStyle(icon).color), ignoredColor, "ignored file icons remain gray");
        assert.notEqual(await treeFile(dialog, "src").locator(".workspace-tree-icon").evaluate((icon) => getComputedStyle(icon).color), ignoredColor, "ordinary folder icons are colored");
        for (const theme of ["light", "dark"]) {
          await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
          const colors = await Promise.all(["unchanged.ts", "notes.md", "picture.png"].map((path) => treeFile(dialog, path).locator(".workspace-tree-icon").evaluate((icon) => getComputedStyle(icon).color)));
          assert.equal(new Set(colors).size, 3, `${theme}: file-type colors remain distinct`);
          assert.equal(await inherited.locator(".workspace-tree-icon").evaluate((icon) => getComputedStyle(icon).color), await inherited.evaluate((row) => getComputedStyle(row).color), `${theme}: ignored icons stay dim`);
        }
        await treeFile(dialog, "unchanged.ts").click();
        await dialog.locator('.file-viewer-embedded [role="region"]').waitFor();
        await dialog.locator(".file-viewer-embedded").getByText("export const unchanged = true;", { exact: false }).first().waitFor();
        await dialog.locator(".file-viewer-embedded .hl-keyword").first().waitFor();
        assert.equal(await page.getByRole("dialog").count(), 1, "unchanged preview stays inside Files");
        if (mobile) await dialog.getByRole("button", { name: "Back to files", exact: true }).click();
        await treeFile(dialog, "src/greeting.ts").click();
        await section(dialog).locator('[data-diff-type]').waitFor();
        if (mobile) {
          assert.equal(await section(dialog).locator('[data-diff-type]').getAttribute("data-diff-type"), "single");
          assert.equal(await dialog.locator(".changes-navigation").isVisible(), false, "mobile detail replaces the tree");
          await selectComment(dialog, "old");
          await field(dialog).fill("Discard this phone diff draft");
          await dialog.getByRole("button", { name: "Discard comment", exact: true }).click();
          await field(dialog).waitFor({ state: "detached" });
          await dialog.getByRole("button", { name: "Back to files", exact: true }).click();
          await treeFile(dialog, "src/new.ts").click();
          await section(dialog, "src/new.ts").locator('[data-diff-type="single"]').waitFor();
          assert.equal(await dialog.evaluate((node) => node.scrollWidth > node.clientWidth), false, "phone dialog does not overflow");
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, "git-changes-mobile.png") }); }
          await dialog.getByRole("button", { name: "Close files", exact: true }).click();
          console.log("PASS Git Changes: phone tree, embedded preview, unified diff and back navigation");
        } else {
          assert.equal(await section(dialog).locator('[data-diff-type]').getAttribute("data-diff-type"), "split");
          assert.equal(await dialog.locator(".diff-comment-keyboard").count(), 0, "diffs do not show a side/line comment form");
          const browserLayout = dialog.locator(".modal-header").getByRole("group", { name: "Diff layout", exact: true });
          await browserLayout.getByRole("button", { name: "Unified", exact: true }).click();
          await section(dialog).locator('[data-diff-type="single"]').waitFor();
          await browserLayout.getByRole("button", { name: "Split", exact: true }).click();
          await section(dialog).locator('[data-diff-type="split"]').waitFor();
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await openSettingsPage(page, "File viewer");
          const settings = page.getByRole("dialog", { name: "Settings", exact: true });
          const layout = settings.getByRole("group", { name: "Diff layout", exact: true });
          await layout.getByRole("button", { name: "Unified", exact: true }).click();
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").splitDiff === false);
          await section(dialog).locator('[data-diff-type="single"]').waitFor();
          await layout.getByRole("button", { name: "Split", exact: true }).click();
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").splitDiff === true);
          await section(dialog).locator('[data-diff-type="split"]').waitFor();
          for (const name of ["Wrap long lines", "Highlight code"]) {
            const control = settings.getByRole("switch", { name, exact: true });
            const original = await control.getAttribute("aria-checked");
            await control.click();
            assert.notEqual(await control.getAttribute("aria-checked"), original, `${name} toggles in Settings`);
            if (name === "Highlight code") {
              await page.waitForFunction(() => !document.querySelector('[data-diff-path="src/greeting.ts"] diffs-container')?.shadowRoot?.querySelector('[data-code] span[style*="syntax-"]'));
            }
            await control.click();
            assert.equal(await control.getAttribute("aria-checked"), original);
            if (name === "Highlight code") await section(dialog).locator('[data-code] span[style*="syntax-"]').first().waitFor();
          }
          await settings.getByRole("button", { name: "Close settings", exact: true }).click();
          await settings.waitFor({ state: "hidden" });
          await section(dialog, "src/new.ts").locator('[data-diff-type]').waitFor();
          await page.mouse.move(1, 1); // No section hover may influence the scroll-selection assertion.
          await dialog.locator(".changes-detail").evaluate((node) => { const next = node.querySelector('[data-diff-path="src/new.ts"]')!; node.scrollTop += next.getBoundingClientRect().top - node.getBoundingClientRect().top; });
          await frames(page);
          assert.notEqual(await treeFile(dialog, "src/new.ts").getAttribute("aria-current"), "true", "programmatic scrolling does not select another file");
          assert.equal(await dialog.locator('[data-diff-path]').count(), 2, "scrolling preserves both diff sections");
          await treeFile(dialog, "src/greeting.ts").click();
          await page.evaluate(() => { (window as any).gitRevision = 1; });
          await dialog.locator(".modal-header").getByRole("button", { name: "Refresh changes", exact: true }).click();
          await section(dialog, "src/new.ts").getByText("export const line0 = 1;", { exact: false }).first().waitFor();
          assert.equal(await dialog.locator('[data-diff-path]').count(), 2, "refresh retains the continuous all-changes document");
          await treeFile(dialog, "src/greeting.ts").click();
          await number(section(dialog), "new", 2).waitFor();
          const line = number(section(dialog), "new", 2);
          await line.hover();
          const plus = section(dialog).locator(".diff-comment-plus");
          await plus.click();
          await field(dialog).waitFor();
          const microphone = dialog.locator(".diff-comment-editor").getByRole("button", { name: "Dictate (hold)", exact: true });
          await microphone.waitFor();
          assert.equal(await microphone.isDisabled(), true, "unconfigured comment dictation explains its unavailable state");
          await page.evaluate((eventName) => { (window as any).gitVoiceConfigured = true; window.dispatchEvent(new Event(eventName)); }, VOICE_CONFIG_EVENT);
          await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".diff-comment-editor .voice-mic")?.disabled === false);
          assert.equal(await microphone.isEnabled(), true, "configured dictation is available in the comment");
          await page.evaluate((eventName) => { (window as any).gitVoiceConfigured = false; window.dispatchEvent(new Event(eventName)); }, VOICE_CONFIG_EVENT);
          await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".diff-comment-editor .voice-mic")?.disabled === true);
          await line.hover();
          await plus.click();
          await field(dialog).waitFor({ state: "detached" });
          await selectComment(dialog, "new");
          await field(dialog).fill("Preserve this draft");
          const requests = await page.evaluate(() => (window as any).gitRequests.length);
          await dialog.getByRole("button", { name: "Refresh changes", exact: true }).click();
          await browserLayout.getByRole("button", { name: "Unified", exact: true }).click();
          assert.equal(await section(dialog).locator('[data-diff-type]').getAttribute("data-diff-type"), "split", "dirty editor blocks layout changes");
          await dialog.getByRole("button", { name: "Close files", exact: true }).click();
          await page.keyboard.press("Escape");
          await frames(page);
          assert.ok(await dialog.isVisible(), "dirty editor keeps the Files dialog open");
          assert.equal(await field(dialog).inputValue(), "Preserve this draft");
          assert.equal(await page.evaluate(() => (window as any).gitRequests.length), requests, "dirty editor blocks refresh requests");
          await saveComment(dialog, "Review the new greeting");
          for (const name of ["Split", "Unified"]) {
            await browserLayout.getByRole("button", { name, exact: true }).click();
            await section(dialog).locator(`[data-diff-type="${name === "Split" ? "split" : "single"}"]`).waitFor();
            await selectComment(dialog, "old");
            await field(dialog).fill("Discard this old-side draft");
            await dialog.getByRole("button", { name: "Close comment", exact: true }).click();
            assert.equal(await field(dialog).inputValue(), "Discard this old-side draft", "Close still protects dirty drafts");
            await dialog.getByRole("button", { name: "Discard comment", exact: true }).click();
            await field(dialog).waitFor({ state: "detached" });
            assert.equal(await section(dialog).getByText("Discard this old-side draft", { exact: true }).count(), 0);
            assert.equal(await section(dialog).getByText("Review the new greeting", { exact: true }).count(), 1, "discard does not remove saved comments");
          }
          await browserLayout.getByRole("button", { name: "Split", exact: true }).click();
          await section(dialog).locator('[data-diff-type="split"]').waitFor();
          await selectComment(dialog, "old");
          await saveComment(dialog, "Explain the old greeting");
          await section(dialog).getByText("Explain the old greeting", { exact: true }).click();
          await field(dialog).fill("Keep this changed editor open");
          const otherPage = await context.newPage();
          try {
            await otherPage.goto(url);
            await otherPage.locator(".conn-live").waitFor({ state: "attached" });
            await otherPage.evaluate(() => { (window as any).gitRevision = 1; });
            const otherDialog = await openChanges(otherPage);
            await treeFile(otherDialog, "src").click();
            await treeFile(otherDialog, "src/greeting.ts").click();
            await section(otherDialog).getByText("Explain the old greeting", { exact: true }).click();
            await saveComment(otherDialog, "Old-side comment updated in another tab");
            await section(dialog).getByText("Old-side comment updated in another tab", { exact: true }).waitFor();
            assert.equal(await field(dialog).inputValue(), "Keep this changed editor open", "another tab's save preserves the dirty editor");
            await dialog.getByRole("button", { name: "Delete comment", exact: true }).click();
            await field(dialog).waitFor({ state: "detached" });
            await section(dialog).getByText("Old-side comment updated in another tab", { exact: true }).waitFor({ state: "detached" });
            await section(otherDialog).getByText("Old-side comment updated in another tab", { exact: true }).waitFor({ state: "detached" });
            assert.equal(await section(dialog).getByText("Review the new greeting", { exact: true }).count(), 1, "old-side deletion preserves the new-side comment");
            await selectComment(dialog, "old");
            await field(dialog).fill("Discard only this local draft");
            await selectComment(otherDialog, "old");
            await saveComment(otherDialog, "Keep the other tab's new comment");
            await section(dialog).getByText("Keep the other tab's new comment", { exact: true }).waitFor();
            await dialog.getByRole("button", { name: "Discard comment", exact: true }).click();
            await field(dialog).waitFor({ state: "detached" });
            assert.equal(await section(dialog).getByText("Keep the other tab's new comment", { exact: true }).count(), 1, "discarding a new draft never deletes a concurrent save");
            await section(dialog).getByText("Keep the other tab's new comment", { exact: true }).click();
            await field(dialog).waitFor();
            await dialog.getByRole("button", { name: "Delete comment", exact: true }).click();
            await field(dialog).waitFor({ state: "detached" });
            await section(otherDialog).getByText("Keep the other tab's new comment", { exact: true }).waitFor({ state: "detached" });
          } finally { await otherPage.close(); }
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
          console.log("PASS Git Changes: continuous scroll, embedded preview, Settings controls, refresh, gutter toggle, mouse range, dirty guards and composer send");
        }
        await page.evaluate(() => { (window as any).gitLongContext = true; });
        const scrolling = await openChanges(page);
        await treeFile(scrolling, "src").click();
        await treeFile(scrolling, "src/greeting.ts").click();
        for (const name of mobile ? ["Unified"] : ["Split", "Unified"]) {
          await scrolling.locator(".modal-header").getByRole("group", { name: "Diff layout", exact: true }).getByRole("button", { name, exact: true }).click();
          await section(scrolling).locator(`[data-diff-type="${name === "Split" ? "split" : "single"}"]`).waitFor();
          const sourceLine = number(section(scrolling), "old", 180);
          await sourceLine.waitFor();
          const detail = scrolling.locator(".changes-detail");
          const lineBounds = await sourceLine.boundingBox();
          assert.ok(lineBounds);
          await detail.evaluate((node, top) => { node.scrollTop += top - node.getBoundingClientRect().top - node.clientHeight + 48; }, lineBounds.y);
          await frames(page);
          await sourceLine.waitFor();
          const before = await detail.evaluate((node) => node.scrollTop);
          await sourceLine.waitFor();
          // Read both rectangles atomically: focusing a phone editor can hide
          // its tools between separate browser calls and skew the subtraction.
          const sourceOffset = () => sourceLine.evaluate((node) => {
            const tree = node.getRootNode();
            const host = tree instanceof ShadowRoot ? tree.host : node;
            return node.getBoundingClientRect().y - host.closest(".changes-detail")!.getBoundingClientRect().y;
          });
          const sourceBefore = await sourceOffset();
          await sourceLine.click();
          await field(scrolling).waitFor();
          await frames(page);
          assert.ok(Math.abs(await detail.evaluate((node) => node.scrollTop) - before) <= 1, `${name}: opening an old-side comment does not scroll the document`);
          const sourceAfter = await sourceOffset();
          assert.ok(Math.abs(sourceAfter - sourceBefore) <= 1, `${name}: the selected source line stays in place inside the diff viewport (${sourceBefore} → ${sourceAfter})`);
          assert.equal(await section(scrolling).locator('[data-code] [data-column-number="120"]').count(), 0, "opening a comment does not expand unrelated context");
          assert.equal(await field(scrolling).evaluate((node) => node === document.activeElement), true, "the editor receives focus without scrolling");
          // Scrolling to an offscreen editor is the reader's choice. Typing in
          // that now-visible editor must not trigger another application reveal.
          await field(scrolling).scrollIntoViewIfNeeded();
          await frames(page);
          const typingTop = await detail.evaluate((node) => node.scrollTop);
          await field(scrolling).evaluate((node) => {
            (window as any).commentHeightWrites = 0;
            const observer = new MutationObserver((records) => { (window as any).commentHeightWrites += records.length; });
            observer.observe(node, { attributes: true, attributeFilter: ["style"] });
            (window as any).commentHeightObserver = observer;
          });
          await page.keyboard.type("Keep reading here");
          await frames(page);
          assert.ok(Math.abs(await detail.evaluate((node) => node.scrollTop) - typingTop) <= 1, "typing in the visible editor does not scroll the diff");
          assert.ok(await page.evaluate(() => (window as any).commentHeightWrites) <= 1, "typing one line changes height at most once, not on every character");
          await page.evaluate(() => { (window as any).commentHeightObserver.disconnect(); });
          const shortHeight = await field(scrolling).evaluate((node) => node.clientHeight);
          await field(scrolling).fill(Array.from({ length: 12 }, (_, i) => `Comment line ${i}`).join("\n"));
          await frames(page);
          assert.ok(await field(scrolling).evaluate((node) => node.clientHeight) > shortHeight, "the isolated measurement still grows multiline drafts");
          assert.ok(await field(scrolling).evaluate((node) => node.scrollHeight > node.clientHeight), "long drafts keep the bounded field and scroll inside it");
          await field(scrolling).fill("Short again");
          await frames(page);
          assert.ok(Math.abs(await field(scrolling).evaluate((node) => node.clientHeight) - shortHeight) <= 1, "deleting text shrinks the field back");
          assert.equal(await page.locator(".comment-editor-measure").count(), 1, "one isolated measuring field belongs to the open editor");
          await scrolling.getByRole("button", { name: "Discard comment", exact: true }).click();
          await field(scrolling).waitFor({ state: "detached" });
          assert.equal(await page.locator(".comment-editor-measure").count(), 0, "closing the editor removes its measuring field");
        }
        await scrolling.getByRole("button", { name: "Close files", exact: true }).click();
        await page.evaluate(() => { (window as any).gitLongContext = false; });
        console.log(`PASS Diff comments: ${mobile ? "phone" : "desktop"} old-side opening and typing preserve the viewport and collapsed context`);

        // An empty repository uses the same response contract, mocked only in this page.
        await page.evaluate(() => { (window as any).gitEmpty = true; });
        const empty = await openChanges(page);
        await empty.getByRole("button", { name: "Compare with…", exact: true }).click();
        await empty.getByRole("option", { name: "Working changes", exact: true }).click();
        await empty.getByText("No changes in this comparison.", { exact: true }).waitFor({ state: "attached" });
        assert.equal(await empty.locator("[data-diff-path]").count(), 0);
        assert.equal(await page.locator(".composer-browse .browse-files-dot").count(), 0, "empty working inventory clears the shortcut dot");
        assert.equal(await empty.locator(".modal-header").getByRole("group", { name: "Diff layout", exact: true }).count(), 0, "empty inventory hides layout controls");
        if (mobile) {
          await empty.getByRole("button", { name: "Back to files", exact: true }).click();
          await treeFile(empty, "unchanged.ts").waitFor();
          await treeFile(empty, "unchanged.ts").click();
          await empty.locator(".file-viewer-embedded").waitFor();
          await empty.getByRole("button", { name: "Back to files", exact: true }).click();
        }
        await treeFile(empty, "unchanged.ts").waitFor();
        const requests: string[] = await page.evaluate(() => (window as any).gitRequests);
        assert.ok(requests.length > 0, "git requests were observed");
        assert.ok(requests.every((request) => new URL(request, url).searchParams.get("mode") === "all"), "every changes and diff request uses all mode");
        assert.deepEqual(errors, [], "no browser exceptions");
        console.log(`PASS Git Changes: ${mobile ? "phone" : "desktop"} empty comparison`);

        await empty.getByRole("button", { name: "Close files", exact: true }).click();
        await page.waitForFunction(() => !history.state?.["herdr-web-ui:sheet"]);
        await page.locator(".header-more-button").click();
        assert.equal(await page.getByRole(mobile ? "button" : "menuitem", { name: "Browse files", exact: true }).locator(".browse-files-dot").count(), 0, "clean workspace has no menu dot");
        await page.keyboard.press("Escape");
        await page.evaluate(() => { (window as any).gitEmpty = false; (window as any).gitRevision = 0; });
        await openPaneChanges();
        const quick = page.getByRole("dialog", { name: "Files", exact: true });
        const finder = quick.getByRole("combobox", { name: "Find files…", exact: true });
        await quick.locator(".modal-header").getByRole("group", { name: "Diff layout", exact: true }).waitFor();
        const layout = quick.locator(".changes-layout");
        await finder.focus();
        await page.waitForFunction(() => document.querySelector(".files-dialog")?.getAnimations().every((animation) => animation.playState !== "running"));
        await frames(page);
        const layoutBefore = await layout.boundingBox();
        assert.ok(layoutBefore);
        await page.evaluate(() => { (window as any).gitManySearchResults = true; });
        await finder.fill("search-result");
        const searchList = quick.getByRole("listbox", { name: "Find files…", exact: true });
        await searchList.getByRole("option").nth(11).waitFor({ state: "attached" });
        assert.equal(await quick.locator(".workspace-file-search-results").evaluate((node) => getComputedStyle(node).position), "absolute", "search results float over the content below");
        const layoutOpen = await layout.boundingBox();
        assert.ok(layoutOpen && Math.abs(layoutOpen.y - layoutBefore.y) <= 1 && Math.abs(layoutOpen.height - layoutBefore.height) <= 1, "opening search results does not move or shrink the browser content");
        const rows = await searchList.evaluate((node) => ({ height: node.clientHeight, scrollHeight: node.scrollHeight, rows: [...node.children].map((row) => row.getBoundingClientRect().height) }));
        assert.equal(rows.rows.length, 12, "remaining results are retained, not truncated to five");
        assert.ok(rows.rows.every((height) => Math.abs(height - rows.rows[0]!) <= 1), "long paths retain one fixed-height row");
        assert.ok(Math.abs(rows.height - rows.rows[0]! * 5) <= 1, "the list displays five rows at a time");
        assert.ok(rows.scrollHeight > rows.height, "the rest of the results are scrollable");
        assert.ok(await searchList.getByRole("option").nth(4).evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
        }), "the header dropdown receives clicks above the browser content");
        const pageTop = await page.evaluate(() => window.scrollY);
        for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowDown");
        await frames(page);
        assert.equal(await searchList.getByRole("option").nth(5).getAttribute("aria-selected"), "true");
        assert.ok(await searchList.evaluate((node) => node.scrollTop) > 0, "keyboard navigation scrolls to the sixth result");
        assert.equal(await page.evaluate(() => window.scrollY), pageTop, "result navigation never scrolls the page");
        const layoutScrolled = await layout.boundingBox();
        assert.ok(layoutScrolled && Math.abs(layoutScrolled.y - layoutBefore.y) <= 1, "result navigation leaves the browser content in place");
        await page.keyboard.press("Escape");
        await searchList.waitFor({ state: "detached" });
        const layoutClosed = await layout.boundingBox();
        assert.ok(layoutClosed && Math.abs(layoutClosed.y - layoutBefore.y) <= 1 && Math.abs(layoutClosed.height - layoutBefore.height) <= 1, "closing the result overlay does not shift the browser content");
        await page.evaluate(() => { (window as any).gitManySearchResults = false; });
        await finder.fill("greeting");
        await quick.getByRole("option", { name: "src/greeting.ts", exact: true }).waitFor();
        await page.keyboard.press("Enter");
        await section(quick).locator("[data-diff-type]").waitFor();
        await page.keyboard.press("ControlOrMeta+p");
        await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Find files…");
        await finder.fill("file-that-does-not-exist");
        await quick.locator(".workspace-file-search").getByText("No matches", { exact: true }).waitFor();
        await page.keyboard.press("Escape");
        assert.ok(await quick.isVisible(), "Escape dismisses search results without closing Files");
        await finder.focus();
        await page.keyboard.press("Escape");
        await frames(page);
        const beforeCompare = await layout.boundingBox();
        assert.ok(beforeCompare);
        const diffTop = await quick.locator(".changes-detail").evaluate((node) => node.scrollTop);
        await page.evaluate(() => { (window as any).gitManyCommitResults = true; });
        const compareButton = quick.locator(".modal-header").getByRole("button", { name: "Compare with…", exact: true });
        await compareButton.click();
        const commitList = quick.getByRole("listbox", { name: "Search commits…", exact: true });
        await commitList.getByRole("option").nth(12).waitFor({ state: "attached" });
        assert.equal(await quick.locator(".modal-header .commit-picker").evaluate((node) => getComputedStyle(node).position), "absolute", "the commit picker floats from the header");
        assert.equal(await quick.locator(".modal-body .commit-picker").count(), 0);
        const compareOpen = await layout.boundingBox();
        assert.ok(compareOpen && Math.abs(compareOpen.y - beforeCompare.y) <= 1 && Math.abs(compareOpen.height - beforeCompare.height) <= 1, "opening Compare with does not push or shrink the file view");
        const commitRows = await commitList.evaluate((node) => ({ height: node.clientHeight, scrollHeight: node.scrollHeight, row: node.children[0]!.getBoundingClientRect().height }));
        assert.ok(Math.abs(commitRows.height - commitRows.row * 5) <= 1, "the commit list displays up to five rows");
        assert.ok(commitRows.scrollHeight > commitRows.height);
        for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowDown");
        await frames(page);
        assert.equal(await commitList.getByRole("option").nth(6).getAttribute("aria-selected"), "true");
        assert.ok(await commitList.evaluate((node) => node.scrollTop) > 0);
        assert.equal(await quick.locator(".changes-detail").evaluate((node) => node.scrollTop), diffTop, "commit navigation scrolls only its results");
        await compareButton.click();
        await quick.locator(".commit-picker").waitFor({ state: "detached" });
        assert.equal(await compareButton.getAttribute("aria-expanded"), "false", "the trigger toggles the overlay closed");
        await compareButton.click();
        await quick.getByRole("combobox", { name: "Search commits…", exact: true }).waitFor();
        await page.keyboard.press("ControlOrMeta+p");
        await quick.locator(".commit-picker").waitFor({ state: "detached" });
        assert.equal(await finder.evaluate((node) => node === document.activeElement), true, "Mod+P dismisses comparison and focuses file search");
        await page.keyboard.press("Escape");
        await compareButton.click();
        await quick.getByRole("combobox", { name: "Search commits…", exact: true }).waitFor();
        await quick.locator(".modal-title").click();
        await quick.locator(".commit-picker").waitFor({ state: "detached" });
        await page.evaluate(() => { (window as any).gitManyCommitResults = false; });
        await treeFile(quick, "src/greeting.ts").click({ button: "right" });
        await quick.getByRole("menuitem", { name: "Compare with…", exact: true }).click();
        const commitSearch = quick.getByRole("combobox", { name: "Search commits…", exact: true });
        await commitSearch.waitFor();
        await quick.locator(".commit-picker-subject").first().waitFor();
        const subject = await quick.locator(".commit-picker-subject").first().innerText();
        await commitSearch.fill(subject);
        await quick.locator(".commit-picker-subject").filter({ hasText: subject }).first().waitFor();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await section(quick).locator("[data-diff-type]").waitFor();
        assert.equal(await quick.locator("[data-diff-path]").count(), 1, "a file context comparison renders only that file");
        await quick.locator(".changes-comparison-label").waitFor();
        const selectedBase = await quick.locator(".changes-comparison-label").getAttribute("title");
        assert.match(selectedBase!, /^[a-f0-9]{40,64}$/);
        await quick.getByRole("button", { name: "Compare with…", exact: true }).click();
        await quick.locator(".commit-picker-subject").first().waitFor();
        await quick.locator(".commit-picker-option").nth(1).click();
        await page.waitForFunction(() => document.querySelectorAll("[data-diff-path]").length > 1);
        assert.ok((await page.evaluate(() => (window as any).gitRequests as string[])).some((request) => new URL(request, url).searchParams.get("base_commit") === selectedBase), "historical comparisons pass the chosen base to the API");
        await selectComment(quick, "old");
        await field(quick).fill("Discard this historical diff draft");
        await quick.getByRole("button", { name: "Discard comment", exact: true }).click();
        await field(quick).waitFor({ state: "detached" });
        await quick.getByRole("button", { name: "Close files", exact: true }).click();
        await page.waitForFunction(() => !history.state?.["herdr-web-ui:sheet"]);
        console.log(`PASS File tools: ${mobile ? "phone" : "desktop"} filename search, keyboard commit search, single-file context comparison and all-file comparison`);

        // The same demo build serves both entry intents and all Markdown states.
        await page.evaluate(() => { (window as any).gitMarkdownCase = true; });
        const markdown = await openChanges(page);
        await treeFile(markdown, "docs").click();
        const modes = markdown.getByRole("group", { name: "Markdown view", exact: true });
        const preview = modes.getByRole("button", { name: "Preview", exact: true });
        const diff = modes.getByRole("button", { name: "Diff", exact: true });
        const markdownCases = [
          { path: "docs/untracked.md", status: "untracked", heading: "Untracked guide" },
          { path: "docs/added.md", status: "added", heading: "Added guide" },
          { path: "docs/modified.md", status: "modified", heading: "Modified guide" },
        ];
        for (const file of markdownCases) {
          const row = treeFile(markdown, file.path);
          await row.waitFor();
          assert.equal(await row.getAttribute("data-status"), file.status);
          await row.click();
          await markdown.locator(".file-viewer-markdown").getByRole("heading", { name: file.heading, exact: true }).waitFor();
          assert.equal(await preview.getAttribute("aria-pressed"), "true", `${file.status}: ordinary browsing renders Markdown Preview`);
          assert.equal(await diff.getAttribute("aria-pressed"), "false");
          assert.equal(await markdown.locator(".file-viewer-text").count(), 0, "preview is not highlighted Markdown source");
          await diff.click();
          await section(markdown, file.path).locator("[data-diff-type]").waitFor();
          await number(section(markdown, file.path), "new", 3).waitFor();
          assert.equal(await diff.getAttribute("aria-pressed"), "true", "Diff renders real selectable Git lines");
          if (file.status === "modified") {
            await number(section(markdown, file.path), "new", 3).click();
            await field(markdown).waitFor();
            await field(markdown).fill("Keep the Markdown diff draft");
            await preview.click();
            await frames(page);
            assert.equal(await diff.getAttribute("aria-pressed"), "true", "dirty diff draft refuses Preview");
            assert.equal(await field(markdown).inputValue(), "Keep the Markdown diff draft");
            await markdown.getByRole("button", { name: "Compare with…", exact: true }).click();
            await markdown.getByRole("option", { name: "Working changes", exact: true }).click();
            assert.equal(await field(markdown).inputValue(), "Keep the Markdown diff draft", "changing the comparison preserves a dirty comment");
            await markdown.locator(".commit-picker").waitFor({ state: "detached" });
            await saveComment(markdown, "Saved Markdown diff note");
          }
          await preview.click();
          await markdown.locator(".file-viewer-markdown").getByRole("heading", { name: file.heading, exact: true }).waitFor();
          if (file.status === "modified") {
            await diff.click();
            await section(markdown, file.path).getByText("Saved Markdown diff note", { exact: true }).waitFor();
            await preview.click();
            await markdown.locator(".file-viewer-markdown").getByRole("heading", { name: file.heading, exact: true }).waitFor();
          }
          const browserEntry = await page.evaluate(() => history.state);
          await markdown.getByRole("button", { name: "Close file", exact: true }).click();
          await markdown.locator(".file-viewer-embedded").waitFor({ state: "detached" });
          assert.ok(await markdown.isVisible(), "Close file leaves the Files browser open");
          assert.ok(await markdown.locator(".workspace-file-tree").isVisible(), "Close file returns to file navigation on desktop and phone");
          assert.equal(await markdown.locator('.workspace-tree-row[aria-current="true"]').count(), 0, "the closed document is no longer selected");
          assert.equal(await modes.count(), 0, "a closed Markdown document has no Preview/Diff controls");
          assert.deepEqual(await page.evaluate(() => history.state), browserEntry, "closing only a document preserves the browser's Back entry");
          if (!mobile) await markdown.getByText("Select a file to view.", { exact: true }).waitFor();
          await markdown.getByRole("button", { name: "Refresh changes", exact: true }).click();
          await frames(page);
          assert.equal(await markdown.locator(".file-viewer-embedded, .changes-markdown-mode, [data-diff-path]").count(), 0, "refresh does not reopen or reselect a closed document");
          await row.click();
          await markdown.locator(".file-viewer-markdown").getByRole("heading", { name: file.heading, exact: true }).waitFor();
          if (file.status === "modified") {
            await diff.click();
            await section(markdown, file.path).getByText("Saved Markdown diff note", { exact: true }).waitFor();
            await preview.click();
            await markdown.locator(".file-viewer-markdown").getByRole("heading", { name: file.heading, exact: true }).waitFor();
          }
          if (mobile) await markdown.getByRole("button", { name: "Back to files", exact: true }).click();
        }
        console.log(`PASS Close file: ${mobile ? "phone" : "desktop"} keeps the browser, navigation, history and saved Markdown comments; refresh stays closed and the same file reopens`);
        await markdown.getByRole("button", { name: "Close files", exact: true }).click();
        await page.locator(".composer-comments-walk").first().click();
        const reopened = page.getByRole("dialog", { name: "Files", exact: true });
        await field(section(reopened, "docs/modified.md")).waitFor();
        assert.equal(await field(reopened).inputValue(), "Saved Markdown diff note", "comment navigation opens the requested editor");
        await page.waitForFunction(() => document.activeElement?.matches(".diff-comment-editor textarea") === true);
        assert.equal(await reopened.getByRole("group", { name: "Markdown view", exact: true }).getByRole("button", { name: "Diff", exact: true }).getAttribute("aria-pressed"), "true", "composer comment navigation forces Diff rather than browse Preview");
        await reopened.getByRole("button", { name: "Close files", exact: true }).click();
        // A still-inventory file whose diff fails must keep its saved comment editable.
        await page.evaluate(() => { (window as any).gitDiffFailure = true; });
        await page.locator(".composer-comments-walk").first().click();
        const unavailable = page.getByRole("dialog", { name: "Files", exact: true });
        await unavailable.locator(".changes-orphan-comments .diff-comment-editor").waitFor();
        assert.equal(await field(unavailable).inputValue(), "Saved Markdown diff note", "failed diff preserves access to the requested saved comment");
        await unavailable.getByRole("button", { name: "Close files", exact: true }).click();
        await page.evaluate(() => { (window as any).gitDiffFailure = false; });

        await openPaneChanges();
        const explicit = page.getByRole("dialog", { name: "Files", exact: true });
        await explicit.getByRole("button", { name: "Compare with…", exact: true }).click();
        await explicit.getByRole("option", { name: "Working changes", exact: true }).click();
        if (mobile) await explicit.getByRole("button", { name: "Back to files", exact: true }).click();
        if (await treeFile(explicit, "docs").getAttribute("aria-expanded") !== "true") await treeFile(explicit, "docs").click();
        await treeFile(explicit, "docs/added.md").click();
        await section(explicit, "docs/added.md").locator("[data-diff-type]").waitFor();
        assert.equal(await explicit.getByRole("group", { name: "Markdown view", exact: true }).getByRole("button", { name: "Diff", exact: true }).getAttribute("aria-pressed"), "true", "an explicit comparison keeps changed Markdown in Diff");
        await explicit.getByRole("button", { name: "Close files", exact: true }).click();

        // A plain source file's comments remain separate from Markdown diff cards.
        const sourceDialog = await openChanges(page);
        await treeFile(sourceDialog, "unchanged.ts").click();
        await sourceDialog.locator('.file-viewer-text .hl-line[data-source-line="1"]').click();
        const sourcePopover = page.locator(".comment-popover");
        await sourcePopover.getByRole("textbox", { name: "Comment", exact: true }).fill("Saved ordinary source note");
        // Menu-opened phone Files must restore its sheet entry each time Back is refused.
        if (mobile) {
          const entry = await page.evaluate(() => history.state["herdr-web-ui:sheet"]);
          assert.ok(entry, "Files owns a phone sheet history entry");
          for (let attempt = 0; attempt < 2; attempt++) {
            await page.evaluate(() => new Promise<void>((resolve) => {
              window.addEventListener("popstate", () => resolve(), { once: true, capture: true });
              history.back();
            }));
            assert.equal(await page.evaluate(() => history.state["herdr-web-ui:sheet"]), entry, "refused Back restores the sheet entry");
            assert.equal(await sourcePopover.getByRole("textbox", { name: "Comment", exact: true }).inputValue(), "Saved ordinary source note");
          }
        }
        // The phone's comment sheet physically covers Close file; Escape is its available dismissal.
        if (mobile) await page.keyboard.press("Escape");
        else await sourceDialog.getByRole("button", { name: "Close file", exact: true }).click();
        assert.ok(await sourceDialog.locator(".file-viewer-embedded").isVisible(), "an unsaved source comment keeps the document open");
        assert.equal(await sourcePopover.getByRole("textbox", { name: "Comment", exact: true }).inputValue(), "Saved ordinary source note", "Close file preserves the unsaved draft");
        await sourcePopover.getByRole("button", { name: "Save comment", exact: true }).click();
        await sourcePopover.waitFor({ state: "detached" });
        await sourceDialog.locator(".comment-pin:not(.is-pending)").waitFor();
        await sourceDialog.getByRole("button", { name: "Close file", exact: true }).click();
        await sourceDialog.locator(".file-viewer-embedded").waitFor({ state: "detached" });
        assert.ok(await sourceDialog.isVisible(), "closing a plain source file also preserves its browser");
        assert.ok(await sourceDialog.locator(".workspace-file-tree").isVisible());
        await treeFile(sourceDialog, "docs").click();
        await treeFile(sourceDialog, "docs/modified.md").click();
        await sourceDialog.locator(".file-viewer-markdown").getByRole("heading", { name: "Modified guide", exact: true }).waitFor();
        if (mobile) await sourceDialog.getByRole("button", { name: "Back to files", exact: true }).click();
        await treeFile(sourceDialog, "unchanged.ts").click();
        await sourceDialog.locator(".comment-pin:not(.is-pending)").click();
        await sourcePopover.getByRole("textbox", { name: "Comment", exact: true }).waitFor();
        assert.equal(await sourcePopover.getByRole("textbox", { name: "Comment", exact: true }).inputValue(), "Saved ordinary source note", "plain source comment survives Markdown navigation");
        await page.keyboard.press("Escape");
        await sourcePopover.waitFor({ state: "detached" });
        await sourceDialog.getByRole("button", { name: "Close files", exact: true }).click();

        await page.evaluate(() => { (window as any).gitNested = true; });
        const nestedDialog = await openChanges(page);
        for (const path of ["deep", "deep/inside", "deep/inside/nested"]) {
          const folder = treeFile(nestedDialog, path);
          await folder.waitFor();
          assert.equal(await folder.getAttribute("data-contains-changes"), "true", `${path}: every ancestor indicates changes before expansion`);
          assert.ok(await folder.getByRole("img", { name: "Changed files", exact: true }).isVisible(), "changed folders have a non-color indicator");
          await folder.click();
        }
        await treeFile(nestedDialog, "deep/inside/nested/changed.ts").waitFor();
        await treeFile(nestedDialog, "deep").click();
        assert.equal(await treeFile(nestedDialog, "deep").getAttribute("data-contains-changes"), "true", "collapsed ancestors retain the indicator");
        await nestedDialog.getByRole("button", { name: "Close files", exact: true }).click();
        await page.waitForFunction(() => !history.state?.["herdr-web-ui:sheet"]);
        await page.evaluate(() => { (window as any).gitNested = false; });

        const target = await page.evaluate(() => {
          const request = new URL((window as any).gitRequests.find((request: string) => new URL(request, location.href).searchParams.has("pane_id")), location.href);
          return {
            pane: request.searchParams.get("pane_id"),
            machine: request.pathname.match(/\/api\/machines\/([^/]+)\//)?.[1] ?? "local",
            root: (window as any).gitMarkdownRoot as string,
          };
        });
        assert.ok(target.pane && target.root, "deep link uses the pane and root observed in synthetic requests");
        await context.addInitScript(() => {
          (window as any).gitMarkdownCase = true;
          (window as any).gitMarkdownRefuse = new URL(location.href).searchParams.has("markdownRefuse");
        });
        const deepLink = new URL(url);
        deepLink.searchParams.set("pane", target.pane);
        deepLink.searchParams.set("machine", target.machine);
        deepLink.searchParams.set("file", `${target.root}/docs/modified.md`);
        await page.goto(deepLink.href);
        const linked = page.getByRole("dialog", { name: "Files", exact: true });
        await linked.locator(".file-viewer-markdown").getByRole("heading", { name: "Modified guide", exact: true }).waitFor();
        assert.equal(await linked.getByRole("group", { name: "Markdown view", exact: true }).getByRole("button", { name: "Preview", exact: true }).getAttribute("aria-pressed"), "true", "ordinary pane/file deep link defaults to rendered Preview");

        // Refuse parsing in a fresh document so a cached successful parse cannot
        // hide the worker failure. Highlight/diff workers still run normally.
        deepLink.searchParams.set("markdownRefuse", "1");
        await page.goto(deepLink.href);
        const refused = page.getByRole("dialog", { name: "Files", exact: true });
        const refusalNotice = refused.getByRole("status").filter({ hasText: "Markdown preview is unavailable. Showing source." });
        await refusalNotice.waitFor();
        assert.equal(await refusalNotice.innerText(), "Markdown preview is unavailable. Showing source.");
        await refused.locator(".file-viewer-text .hl-line").first().waitFor();
        assert.match(await refused.locator(".file-viewer-text").innerText(), /# Modified guide/);
        assert.equal(await refused.locator(".file-viewer-markdown").count(), 0, "parser refusal shows source, not an empty preview");
        assert.ok(await page.evaluate(() => (window as any).gitMarkdownRefusals > 0), "Markdown worker actually refused a parse");
        await refused.getByRole("group", { name: "Markdown view", exact: true }).getByRole("button", { name: "Diff", exact: true }).click();
        await section(refused, "docs/modified.md").locator("[data-diff-type]").waitFor();
        assert.deepEqual(errors, [], "Markdown intents, comments and parser refusal have no browser exceptions");
        console.log(`PASS Git Markdown: ${mobile ? "phone" : "desktop"} browse/deep-link Preview, changes/comment Diff, dirty guard, saved comments and explicit parser fallback`);
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
