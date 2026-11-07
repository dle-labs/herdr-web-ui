import { fileAction } from "./files-controls.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page, type Locator } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { installGitDiffFixture } from "./git-diff-fixture.ts";
import { runMoreItem } from "./header-more.ts";
import { sheetsSettled } from "./sheets-settled.ts";
const evidence = process.env.UI_EVIDENCE_DIR;
const app = mkdtempSync(join(tmpdir(), "mobile-files-layout-"));
const treeFile = (dialog: Locator, path: string) => dialog.locator(`.workspace-tree-row[title="${path}"]`);
async function openChanges(page: Page): Promise<Locator> {
  await runMoreItem(page, "Browse files");
  return page.getByRole("dialog", {name:"Files",exact:true});
}
try {
  await buildDemoApp(app);
  installGitDiffFixture(app);
  const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    const path = new URL(request.url).pathname;
    if(path.startsWith("/api/") || path === "/ws") return new Response("Unexpected real API",{status:404});
    const file = Bun.file(join(app,path === "/" ? "index.html" : path));
    return await file.exists() ? new Response(file) : new Response("Not found",{status:404});
  }});
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH ?? chromium.executablePath(),headless:true,args:["--no-sandbox"]});
  try {
    if (evidence) mkdirSync(evidence, {recursive:true});
    for (const [width, height] of [[390, 844], [320, 844], [844, 390]] as const) {
      const context = await browser.newContext({ viewport: {width, height}, isMobile:true, hasTouch:true, locale:"en-US" });
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({language:"en", comments:true, view:"chat", theme:"dark"})));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/index.html`);
      await page.locator(".conn-live").waitFor({state:"attached"});
      let dialog = await openChanges(page);
      page.setDefaultTimeout(10000);
      await dialog.locator(".workspace-file-tree").waitFor();
      await sheetsSettled(page);
      async function measure(mode:string) {
        await sheetsSettled(page);
        const boxes = await dialog.evaluate(node => Object.fromEntries([".files-dialog-header", ".changes-markdown-mode", ".file-viewer-header", ".changes-diff-header", ".file-viewer-body", ".file-viewer-markdown", ".changes-detail", ".workspace-file-tree"].map(selector => {
          const element=node.querySelector(selector);const r=element?.getBoundingClientRect();return [selector,r?{top:r.top,height:r.height,bottom:r.bottom}:null];
        })));
        const bounds = await dialog.boundingBox();
        assert.ok(bounds && bounds.y === 0 && bounds.x === 0 && Math.abs(bounds.height - height) < 1 && Math.abs(bounds.width - width) < 1, "Files covers the app viewport");
        const targets = await dialog.locator(".files-mobile-header > button, .files-mobile-view").evaluateAll(nodes => nodes.map(node => {const r = node.getBoundingClientRect(); return {width:r.width,height:r.height,right:r.right};}));
        assert.ok(targets.every(r => r.width >= 44 && r.height >= 44 && r.right <= width), "toolbar controls keep touch targets and stay onscreen");
        console.log(JSON.stringify({width, height, mode, boxes}));
        assert.ok(boxes[".files-dialog-header"]!.height <= 64, "one compact toolbar row");
        if (mode.startsWith("markdown") && mode !== "markdown-diff") assert.ok(boxes[".file-viewer-body"]!.top <= 64, "Markdown has no extra headers");
        if (evidence) await page.screenshot({path:join(evidence, `mobile-files-${width}-${mode}.png`)});
      }
      await measure("tree");
      await treeFile(dialog,"src").click();
      await treeFile(dialog,"src/new.ts").click();
      await dialog.locator("[data-diff-type]").first().waitFor();
      await measure("diff");
      assert.equal(await dialog.locator(".changes-detail .diff-find-button").count(), 0, "diff search does not add a permanent toolbar row");
      await (await fileAction(dialog, "Find in diff")).click();
      await dialog.getByRole("search", {name:"Find in diff",exact:true}).waitFor();
      await page.keyboard.press("Escape");
      await dialog.getByRole("search", {name:"Find in diff",exact:true}).waitFor({state:"hidden"});
      assert.ok(await dialog.isVisible(), "Escape closes diff search independently");
      const title = dialog.locator(".files-mobile-title h2[title]");
      const filename = await title.textContent();
      await title.evaluate(node => { node.textContent = "exceptionally-long-filename-".repeat(20) + ".ts"; });
      assert.ok(await title.evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).whiteSpace === "nowrap"), "long filenames truncate on one row");
      assert.ok(await dialog.getByRole("button", {name:"Close files",exact:true}).evaluate(node => {
        const box = node.getBoundingClientRect();
        return box.right <= innerWidth && node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), "long filenames never cover Close");
      await title.evaluate((node, text) => { node.textContent = text; }, filename);
      await dialog.getByRole("button",{name:"Close files",exact:true}).click();
      await page.evaluate(() => { (window as any).gitMarkdownCase = true; });
      dialog = await openChanges(page);
      await treeFile(dialog,"docs").click();
      await treeFile(dialog,"docs/modified.md").click();
      await dialog.locator(".file-viewer-markdown").waitFor();
      await measure("markdown");
      const more = dialog.getByRole("button", { name:"More", exact:true });
      const menu = dialog.locator(".files-mobile-actions");
      await more.click();
      await menu.waitFor({state:"visible"});
      if (evidence) await page.screenshot({path:join(evidence, `mobile-files-${width}-menu.png`)});
      await page.keyboard.press("Escape");
      await menu.waitFor({state:"hidden"});
      assert.ok(await dialog.isVisible(), "Escape closes More without closing Files");
      await more.click();
      await page.goBack();
      await menu.waitFor({state:"hidden"});
      assert.ok(await dialog.isVisible(), "Back closes More without closing Files");
      await (await fileAction(dialog,"Wrap long lines")).click();
      await menu.waitFor({state:"hidden"});
      assert.ok(await dialog.isVisible(), "More actions keep the document open");
      await (await fileAction(dialog,"Compare with…")).click();
      await dialog.locator(".commit-picker").waitFor();
      await menu.waitFor({state:"hidden"});
      await page.keyboard.press("Escape");
      await dialog.locator(".commit-picker").waitFor({state:"hidden"});

      await dialog.getByRole("combobox",{name:"File view",exact:true}).selectOption("source");
      await dialog.locator(".source-comments").waitFor();
      await measure("markdown-source");
      await dialog.getByRole("combobox",{name:"File view",exact:true}).selectOption("diff");
      await dialog.locator("[data-diff-type]").first().waitFor();
      await measure("markdown-diff");
      await dialog.getByRole("combobox",{name:"File view",exact:true}).selectOption("source");
      await dialog.locator(".source-comments").waitFor();
      const reader = await dialog.locator(".file-viewer-embedded").elementHandle();
      await page.setViewportSize({width:1024,height:800});
      await dialog.locator(".file-viewer-header").waitFor();
      assert.ok(await reader!.evaluate(node => node.isConnected), "resizing retains the reader instance");
      await page.setViewportSize({width,height});
      await dialog.locator(".files-mobile-header").waitFor();
      await dialog.locator(".source-comments").waitFor();
      assert.ok(await reader!.evaluate(node => node.isConnected), "returning to mobile retains source mode");
      assert.deepEqual(errors, [], "mobile toolbar interactions have no browser exceptions");
      await context.close();
    }
  } finally { await browser.close(); server.stop(); }
} finally { rmSync(app, {recursive:true,force:true}); }
