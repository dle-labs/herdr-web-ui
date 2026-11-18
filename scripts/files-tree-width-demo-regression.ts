import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";
import { runMoreItem } from "./header-more.ts";

// The Files browser on a wide monitor, on the unmodified app over the demo's fixture transport, light
// and dark: the dialog is not capped at a fixed width; the tree column resizes by its edge, folds to
// a small expand button when dragged past its minimum or from the header, and comes back at its
// width; an AsciiDoc file opens as a rendered Preview. A phone keeps the tree and file as steps.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
// Screenshots go to UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "ovis-files-tree-width-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;

// the demo's folders hold no files: an AsciiDoc guide and a README in each
const FILES_SCRIPT = `<script>(${(() => {
  const demoFetch = window.fetch;
  const guide = "= Demo Guide\n:product: Ovis\n\n== Install\n\nRun *{product}* with `bun`.\n\nNOTE: A note.\n\n|===\n|Name |Value\n\n|alpha |1\n|===\n";
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname.endsWith("/workspace/directories") && (init?.method ?? "GET") === "GET") {
      const listing = await (await demoFetch(input, init)).json();
      return Response.json({ ...listing, files: [{ name: "guide.adoc", size: guide.length }, { name: "README.md", size: 64 }] });
    }
    if ((url.searchParams.get("path") ?? "").endsWith("guide.adoc")) {
      if (url.pathname.endsWith("/fs/stat")) return Response.json({ path: url.searchParams.get("path"), name: "guide.adoc", kind: "text", mime: "text/plain", size: guide.length });
      if (url.pathname.endsWith("/fs/file")) return new Response(guide, { headers: { "content-type": "text/plain" } });
    }
    return demoFetch(input, init);
  }) as typeof fetch;
}).toString()})();</script>`;

async function open(browser: Browser, width: number, theme: "light" | "dark"): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 1200 }, locale: "en-US", hasTouch: phone, isMobile: phone });
  await context.addInitScript((value) => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", value);
  }, JSON.stringify({ language: "en", theme }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}&view=chat`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, close: () => context.close() };
}

const shot = async (page: Page, name: string): Promise<void> => {
  if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) });
};

async function wide(browser: Browser, theme: "light" | "dark"): Promise<void> {
  const { page, errors, close } = await open(browser, 2560, theme);
  try {
    await page.locator(".header-files-button").click();
    const dialog = page.locator(".modal-scrim .files-dialog");
    await dialog.waitFor();
    const box = (await dialog.boundingBox())!;
    assert.ok(box.width > 2000, `the dialog uses a wide window (${box.width}px), no 1100px cap`);

    const tree = dialog.locator(".changes-navigation");
    await tree.getByText("guide.adoc").waitFor();
    const before = (await tree.boundingBox())!;
    // the edge: drag it 300px right, and the column follows
    const edge = dialog.getByRole("separator", { name: "Resize file tree" });
    const grip = (await edge.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 200);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 300, grip.y + 200, { steps: 6 });
    await page.mouse.up();
    const widened = (await tree.boundingBox())!;
    assert.ok(Math.abs(widened.width - before.width - 300) <= 2, `the tree widened by the drag (${before.width} → ${widened.width})`);
    assert.equal(await page.evaluate(() => localStorage.getItem("ovis:file-tree-width")), String(Math.round(widened.width)));
    await shot(page, `files-tree-wide-${theme}`);

    // dragged past its minimum it folds to the expand button, which brings back the width it had
    const grip2 = (await edge.boundingBox())!;
    await page.mouse.move(grip2.x + grip2.width / 2, grip2.y + 200);
    await page.mouse.down();
    await page.mouse.move(widened.x + 10, grip2.y + 200, { steps: 8 });
    await page.mouse.up();
    await tree.waitFor({ state: "hidden" });
    const expand = dialog.locator(".changes-navigation-folded").getByRole("button", { name: "Expand file tree" });
    assert.ok((await expand.boundingBox())!.width < 60, "folded, only a small button is left");
    await shot(page, `files-tree-folded-${theme}`);
    await expand.click();
    await tree.waitFor();
    assert.ok(Math.abs((await tree.boundingBox())!.width - widened.width) <= 2, "unfolded at the width it had");

    // the header's toggle folds it too
    const toggle = dialog.locator(".files-dialog-header").getByRole("button", { name: "Collapse file tree" });
    await toggle.click();
    await tree.waitFor({ state: "hidden" });
    await dialog.locator(".files-dialog-header").getByRole("button", { name: "Expand file tree" }).click();
    await tree.waitFor();

    // an AsciiDoc file opens as its Preview: a heading, emphasis from an attribute, an admonition and a table
    await tree.getByText("guide.adoc").click();
    const detail = dialog.locator(".changes-detail");
    await detail.getByRole("heading", { name: "Demo Guide" }).waitFor();
    await detail.getByRole("heading", { name: "Install" }).waitFor();
    assert.equal(await detail.locator("strong", { hasText: "Ovis" }).count() > 0, true, "{product} is substituted and bold");
    await detail.locator("table").getByText("alpha").waitFor();
    await detail.locator("blockquote").getByText("A note.").waitFor();
    await shot(page, `files-asciidoc-preview-${theme}`);
    assert.deepEqual(errors, []);
    console.log(`PASS 2560px ${theme}: uncapped dialog, tree resized, folded and back, AsciiDoc Preview`);
  } finally { await close(); }
}

async function phone(browser: Browser, theme: "light" | "dark"): Promise<void> {
  const { page, errors, close } = await open(browser, 390, theme);
  try {
    // a width chosen on a wide window does not apply: the tree is the whole step
    await page.evaluate(() => { localStorage.setItem("ovis:file-tree-width", "600"); localStorage.setItem("ovis:file-tree-collapsed", "1"); });
    await page.reload();
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await runMoreItem(page, "Browse files");
    const tree = page.locator(".files-dialog .changes-navigation");
    await tree.getByText("guide.adoc").waitFor();
    assert.equal(await page.locator(".changes-navigation-folded").count(), 0, "a phone never folds the tree");
    assert.equal(await page.getByRole("separator", { name: "Resize file tree" }).count(), 0);
    const box = (await tree.boundingBox())!;
    assert.ok(box.width > 340, `the tree fills the phone (${box.width}px)`);
    assert.deepEqual(errors, []);
    console.log(`PASS 390px ${theme}: the tree is its own step, no edge and no fold`);
  } finally { await close(); }
}

let origin = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${FILES_SCRIPT}\n    <script type="module"`));
  const server = serveDemo(app);
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const theme of ["light", "dark"] as const) {
        await wide(browser, theme);
        await phone(browser, theme);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
