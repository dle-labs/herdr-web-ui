/** Mobile history regression using a real chat transcript and an owned herdr pane. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-file-back-"));
const codexHome = join(root, "codex-home");
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc11";
mkdirSync(join(codexHome, "sessions"), { recursive: true });
const transcript = join(codexHome, "sessions", `rollout-2026-09-28T00-00-00-${thread}.jsonl`);
writeFileSync(transcript, [
  { type: "session_meta", payload: { id: thread, cwd: root } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Show me the demo video." }] } },
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Open [demo video](./preview.webm) or [notes](./notes.txt) or [guide](./docs/guide.md) or [big](./big.txt) or [big code](./big.ts) or [deep quotes](./deep.md) or [empty](./empty.txt) or [slow preview](./slow.md) or [long notes](./long.md) or [file URI notes](${new URL(`file://${join(root, "notes.txt")}`).href}) or [folder](${new URL(`file://${root}`).href}).\n\n${new URL(`file://${join(root, "notes.txt")}`).href}\n\n\`\`\`ts\nconst answer = 42;\n\nexport { answer };\n\`\`\`` }] } },
  // a block the highlighter is quadratic on (a line of dashes in YAML): seconds on the page
  { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Dashes:\n\n\`\`\`yaml\n${"-".repeat(90_000)}\n\`\`\`` }] } },
].map((row) => JSON.stringify(row)).join("\n"));
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(thread, transcript, root, "Show me the demo video.");
db.close();
const standIn = join(root, "codex");
writeFileSync(standIn, "#!/bin/sh\nsleep 600\n");
chmodSync(standIn, 0o755);
copyFileSync(join(import.meta.dir, "fixtures", "file-preview.webm"), join(root, "preview.webm"));
writeFileSync(join(root, "notes.txt"), "File preview history regression\n");
// in a subfolder, so a link is resolved from the file's folder (../notes.txt), not the pane's
mkdirSync(join(root, "docs"));
writeFileSync(join(root, "docs", "guide.md"), "# Guide\n\nSee [notes](../notes.txt).\n\n```ts\nconst x = 1;\n```\n");
// the viewer loads the first 256 KB of a text file (TEXT_LOAD_LIMIT in src/lib/textPreview.ts)
const TEXT_LOAD_LIMIT = 256 * 1024;
writeFileSync(join(root, "big.txt"), "a line of plain text, 0123456789\n".repeat(Math.ceil(TEXT_LOAD_LIMIT / 30)).slice(0, TEXT_LOAD_LIMIT + 10));
// code past the load limit: its first 256 KB, still highlighted
writeFileSync(join(root, "big.ts"), "export const value = 1;\n".repeat(Math.ceil((TEXT_LOAD_LIMIT + 1024) / 24)));
// 20 KB of nested quotes: parsed one level per `>`, they overflowed the stack and blanked the app
writeFileSync(join(root, "deep.md"), `${">".repeat(20_000)} deepest\n`);
// a YAML block of dashes in a Markdown file: seconds for the highlighter in Chromium as in Bun (8 s at
// 64 KB), while the Markdown parser reads it in a millisecond. A line of "[a" is slow in Bun alone:
// Chromium highlights 256 KB of it in under half a second, within the worker's budget.
writeFileSync(join(root, "slow.md"), `Notes on a slow file.\n\n\`\`\`yaml\n${"-".repeat(90_000)}\n\`\`\`\n`);
// ordinary Markdown past the load limit: its start is previewed
writeFileSync(join(root, "long.md"), "# Notes\n\nA paragraph of ordinary notes, with *emphasis* and a [link](./notes.txt).\n\n".repeat(4_000));
// an empty file has no first byte: its range answers 416, which is not an error
writeFileSync(join(root, "empty.txt"), "");
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-file-back" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${standIn} resume ${thread}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { argv?: string[] }[] } }>("pane.process_info", { pane_id: pane });
    if (info.process_info?.foreground_processes?.some((process) => process.argv?.includes(standIn))) break;
    if (attempt === 99) throw new Error("test Codex process did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "idle", agent_session_path: transcript });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), codexHome });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  // seeded once: a later step changes a setting and reloads. The chat's own font size and
  // family are set, so a Markdown preview can be shown to take them over
  await page.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", chatFontSize: 17, chatFontFamily: "Georgia" }));
  });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A known prior document proves explicit close leaves no invisible preview entry.
  await page.goto(`${origin}/api/health`);
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  const videoLink = page.getByRole("button", { name: "demo video", exact: true });
  await videoLink.waitFor();
  await page.locator(".markdown-code .hl-keyword", { hasText: "const" }).waitFor();
  await page.locator(".markdown-code .hl-number", { hasText: "42" }).waitFor();
  console.log("PASS Chat fenced code block is syntax highlighted");
  // a blank line must survive in the text a copy picks up
  const codeText = await page.locator(".markdown-code .hl-code").first().innerText();
  if (codeText !== "const answer = 42;\n\nexport { answer };") throw new Error(`Chat code block text lost its blank line: ${JSON.stringify(codeText)}`);
  console.log("PASS Chat code block keeps its blank line in the text");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("Keep my mobile draft");
  const chatUrl = page.url();
  await page.evaluate(() => {
    history.replaceState({ ...history.state, testMarker: "preserved" }, "");
    (window as unknown as { testDocument: string }).testDocument = "same-document";
  });
  const baseline = await page.evaluate(() => history.length);
  const preview = page.getByRole("dialog", { name: "preview.webm", exact: true });
  await videoLink.click();
  await preview.locator("video").waitFor();
  await page.waitForFunction(() => (document.querySelector("video")?.readyState ?? 0) >= 1);
  assert.equal(await page.evaluate(() => history.length), baseline + 1);
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-video-open.png") });
  }
  // The Android system Back button uses this same browser history traversal.
  await page.goBack();
  await preview.waitFor({ state: "hidden" });
  assert.equal(page.url(), chatUrl);
  assert.equal(await composer.inputValue(), "Keep my mobile draft");
  assert.equal(await page.evaluate(() => (window as unknown as { testDocument: string }).testDocument), "same-document");
  assert.equal(await page.evaluate(() => history.state.testMarker), "preserved");
  await videoLink.waitFor();
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "mobile-back-to-chat.png") });
  console.log("PASS mobile Back closes a playable video and preserves the chat document and draft");

  await page.goForward();
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  // Repeated opens must not accumulate extra history entries.
  await videoLink.click();
  await preview.waitFor();
  assert.equal(await page.evaluate(() => history.length), baseline + 1);
  await page.keyboard.press("Escape");
  await preview.waitFor({ state: "hidden" });
  await videoLink.click();
  await preview.waitFor();
  // A press on the backdrop itself closes the viewer. On a touch device the viewer fills the
  // scrim edge to edge, so the press is sent to the scrim rather than aimed at an exposed pixel.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator(".file-viewer-scrim").evaluate((scrim) => scrim.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  await preview.waitFor({ state: "hidden" });
  await page.setViewportSize({ width: 390, height: 844 });
  console.log("PASS Forward restores the viewer; X, Escape and scrim close consume its entry");

  // The Settings shortcut must open a visible dialog above the preview. Its history entries
  // retain the file beneath it, so only Settings may handle Escape until those entries land.
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await videoLink.click();
    await preview.waitFor();
    const previewEntry = await page.evaluate(() => history.state["herdr-web-ui:file-preview"]);
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await settings.waitFor();
    await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] !== undefined);
    const settingsClose = settings.getByRole("button", { name: "Close settings", exact: true });
    assert.equal(await settingsClose.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest(".settings-dialog"));
    }), true, `Settings is above the preview at ${width}px`);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `settings-over-preview-${width}.png`) });
    // two traps are open: only the one in front moves the focus, so Tab walks Settings' controls
    // instead of being sent back to its first one by the preview's trap beneath
    const focused: string[] = [];
    for (let press = 0; press < 3; press++) {
      await page.keyboard.press("Tab");
      focused.push(await page.evaluate(() => {
        const active = document.activeElement;
        return active?.closest(".settings-dialog") ? active.outerHTML.slice(0, 120) : `outside: ${active?.outerHTML.slice(0, 80)}`;
      }));
    }
    assert.ok(focused.every((entry) => !entry.startsWith("outside")), `Tab stays inside Settings at ${width}px: ${focused.join(" | ")}`);
    // Settings has two stops on a phone (Close, and the one focusable tab of its roving list): Tab
    // moves between them; the trap beneath held it on the first
    assert.ok(new Set(focused).size >= 2 && focused[0] !== focused[1], `Tab moves through Settings at ${width}px: ${focused.join(" | ")}`);
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "hidden" });
    await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] === undefined);
    await preview.waitFor();
    assert.deepEqual(await page.evaluate(() => history.state["herdr-web-ui:file-preview"]), previewEntry, "Escape closes only Settings and preserves the preview entry");
    await preview.getByRole("button", { name: "Close file", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => history.state?.["herdr-web-ui:file-preview"]), undefined, "one click on Close file consumes the preview entry");
    assert.equal(await composer.inputValue(), "Keep my mobile draft");

    // System Back follows the same order, preserving the document instead of closing the file.
    await videoLink.click();
    await preview.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await settings.waitFor();
    await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] !== undefined);
    await page.goBack();
    await settings.waitFor({ state: "hidden" });
    await preview.waitFor();
    await preview.getByRole("button", { name: "Close file", exact: true }).click();
    await preview.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => (window as unknown as { testDocument: string }).testDocument), "same-document");
    console.log(`PASS Settings opens above the preview at ${width}px; Escape and Back preserve it, then X closes the file once`);
  }

  // Add PC from Settings over a preview: Settings closes, the preview stays mounted beneath, and
  // the native modal Add PC opens is on top. Tab walks Add PC's own controls; the preview's trap
  // must not take it back to its own, now inert, controls.
  await page.setViewportSize({ width: 1280, height: 800 });
  await videoLink.click();
  await preview.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const settingsOverPreview = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsOverPreview.waitFor();
  await openSettingsPage(page, "Remote PCs");
  await settingsOverPreview.getByRole("button", { name: "Add PC", exact: true }).click();
  const addPc = page.locator("dialog.machine-dialog");
  await addPc.waitFor();
  await settingsOverPreview.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".file-viewer").count(), 1, "the preview stays beneath Add PC");
  await page.waitForFunction(() => Boolean(document.activeElement?.closest("dialog.machine-dialog")));
  const addPcFocus: string[] = [];
  for (let press = 0; press < 3; press++) {
    await page.keyboard.press("Tab");
    addPcFocus.push(await page.evaluate(() => {
      const active = document.activeElement;
      return active?.closest("dialog.machine-dialog") ? active.outerHTML.slice(0, 120) : `outside: ${active?.outerHTML.slice(0, 80)}`;
    }));
  }
  assert.ok(addPcFocus.every((entry) => !entry.startsWith("outside")), `Tab stays inside Add PC over a preview: ${addPcFocus.join(" | ")}`);
  assert.ok(new Set(addPcFocus).size >= 2, `Tab moves through Add PC over a preview: ${addPcFocus.join(" | ")}`);
  // Escape is Add PC's too: it closes Add PC alone, and the preview and its entry stay
  const previewUnderAddPc = await page.evaluate(() => history.state["herdr-web-ui:file-preview"]);
  await page.keyboard.press("Escape");
  await addPc.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".file-viewer").count(), 1, "Escape over Add PC leaves the preview beneath it");
  assert.deepEqual(await page.evaluate(() => history.state["herdr-web-ui:file-preview"]), previewUnderAddPc, "Escape over Add PC preserves the preview entry");
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  console.log("PASS Add PC opened from Settings over a preview keeps Tab inside Add PC, and its Escape closes Add PC alone");

  // With no preview beneath it, Settings stays on the layer every dialog shares, so the palette
  // its shortcut opens is drawn above Settings instead of taking focus and Escape unseen.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const settingsAlone = page.getByRole("dialog", { name: "Settings", exact: true });
  await settingsAlone.waitFor();
  await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] !== undefined);
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const paletteSearch = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
  await paletteSearch.waitFor();
  assert.equal(await paletteSearch.evaluate((input) => {
    const rect = input.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
  }), true, "the command palette is above Settings");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "palette-over-settings-1280.png") });
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await settingsAlone.waitFor();
  await page.keyboard.press("Escape");
  await settingsAlone.waitFor({ state: "hidden" });
  await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] === undefined);
  console.log("PASS the command palette opens above Settings; Escape closes the palette, then Settings");

  // Over Settings raised above a preview, too, the palette it opens is the top layer: it takes
  // focus and Escape, so it must not be drawn beneath either of them.
  await videoLink.click();
  await preview.waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await settingsAlone.waitFor();
  await page.waitForFunction(() => history.state?.["herdr-web-ui:settings"] !== undefined);
  await page.keyboard.press("ControlOrMeta+Shift+K");
  await paletteSearch.waitFor();
  const topmost = (input: Element) => {
    const rect = input.getBoundingClientRect();
    return { above: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input, focused: document.activeElement === input };
  };
  // the palette takes focus once it has mounted: wait for that, then say which part is missing
  await page.waitForFunction((input) => {
    const rect = input!.getBoundingClientRect();
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input && document.activeElement === input;
  }, await paletteSearch.elementHandle(), { timeout: 5000 }).catch(() => undefined);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "palette-over-settings-over-preview-1280.png") });
  assert.deepEqual(await paletteSearch.evaluate(topmost), { above: true, focused: true }, "the command palette is above Settings and the preview, and has focus");
  await page.keyboard.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await settingsAlone.waitFor();
  await preview.waitFor();
  await page.keyboard.press("Escape");
  await settingsAlone.waitFor({ state: "hidden" });
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  console.log("PASS the command palette opens above Settings over a preview; Escape closes the palette, then Settings, then X the file");
  await page.setViewportSize({ width: 390, height: 844 });

  await page.getByRole("button", { name: "notes", exact: true }).click();
  const notes = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await notes.getByText("File preview history regression", { exact: true }).waitFor();
  await page.reload();
  await notes.getByText("File preview history regression", { exact: true }).waitFor();
  await page.goBack();
  await notes.waitFor({ state: "hidden" });
  await videoLink.waitFor();
  await videoLink.click();
  await preview.waitFor();
  await preview.getByRole("button", { name: "Close file", exact: true }).click();
  await preview.waitFor({ state: "hidden" });
  await page.goBack();
  assert.equal(page.url(), `${origin}/api/health`, "no ghost modal entry or back trap after explicit close");
  assert.deepEqual(errors, []);
  console.log("PASS text preview survives reload; closed viewers leave normal Back navigation intact");
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.getByRole("button", { name: "file URI notes", exact: true }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat file URI label opens file content through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "folder", exact: true }).tap();
  await page.locator(".file-viewer .dir-browser").waitFor();
  await page.locator(".file-viewer .dir-browser").getByRole("button", { name: /notes.txt/ }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat folder URI opens directory browser through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: new URL(`file://${join(root, "notes.txt")}`).href, exact: true }).tap();
  await page.locator(".file-viewer-text").waitFor();
  assert.match(await page.locator(".file-viewer-text").innerText(), /File preview history regression/);
  console.log("PASS Chat plain file URI opens content through touch");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // Markdown: Show source (a toggle: off is the Preview), Raw, Download, Copy; no Wrap (a setting)
  const guide = page.getByRole("dialog", { name: "guide.md", exact: true });
  await page.getByRole("button", { name: "guide", exact: true }).click();
  await guide.getByRole("heading", { name: "Guide", exact: true }).waitFor();
  await guide.locator(".hl-keyword", { hasText: "const" }).waitFor();
  assert.equal(await guide.getByRole("button", { name: "Show source", exact: true }).getAttribute("aria-pressed"), "false");
  // a new tab is an in-app view in an installed app on a phone, where saving is not always offered
  const download = guide.getByRole("link", { name: "Download", exact: true });
  assert.equal(await download.getAttribute("download"), "guide.md", "the file can be saved from the viewer");
  assert.match(await download.getAttribute("href") ?? "", /\/api\/fs\/file\?.*download=1/);
  assert.equal(await guide.getByRole("button", { name: "Wrap long lines", exact: true }).count(), 0, "Wrap is for code, not the rendered Markdown");
  console.log("PASS Markdown opens as a Preview with a highlighted code block");
  // the preview reads as the chat does: its font size and family, and at most its lane's width
  const textStyle = (selector: string) => page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    const heading = element.querySelector(".markdown-h1");
    return { fontSize: style.fontSize, fontFamily: style.fontFamily, headingSize: heading === null ? null : getComputedStyle(heading).fontSize };
  });
  const chatText = await textStyle(".chat-transcript .chat-turn-agent .markdown");
  const previewText = await textStyle(".file-viewer-markdown");
  // --fs-chat (15px), the size of prose read at length, at the chat's scale, 17 / 14
  assert.ok(Math.abs(Number.parseFloat(chatText.fontSize) - 15 * 17 / 14) < 0.05, `the chat font size is applied in the chat: ${chatText.fontSize}`);
  assert.match(chatText.fontFamily, /^Georgia,/);
  assert.equal(previewText.fontSize, chatText.fontSize, "the preview's text has the chat's font size");
  assert.equal(previewText.fontFamily, chatText.fontFamily, "the preview's text has the chat's font");
  // --fs-xl (18px) at the chat's scale, 17 / 14
  assert.ok(Math.abs(Number.parseFloat(previewText.headingSize ?? "") - 18 * 17 / 14) < 0.05, `its headings scale with it: ${previewText.headingSize}`);
  assert.equal(await page.locator(".file-viewer-markdown").evaluate((element) => getComputedStyle(element).maxWidth), "820px", "Default is the chat's Default lane");
  // on a wide screen the Default lane follows the pane (71.43% of it, up to 60rem): the preview
  // follows with it, as wide as the chat beside it, not the 820px floor
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForFunction(() => {
    const preview = document.querySelector(".file-viewer-markdown");
    const chat = document.querySelector(".chat-transcript");
    return preview !== null && chat !== null && getComputedStyle(preview).maxWidth === `${chat.getBoundingClientRect().width}px`;
  });
  assert.equal(await page.locator(".file-viewer-markdown").evaluate((element) => getComputedStyle(element).maxWidth), "960px", "Default is as wide as the chat's lane");
  // the lane is the opening pane's, written on the viewer: one length on the document would be
  // shared, and overwritten, by two panes side by side
  assert.deepEqual(await page.evaluate(() => ({
    root: document.documentElement.style.getPropertyValue("--chat-w"),
    viewer: document.querySelector<HTMLElement>(".file-viewer")?.style.getPropertyValue("--chat-w") !== "",
  })), { root: "", viewer: true }, "the viewer carries the lane, not the document");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.match(await guide.locator(".file-viewer-markdown pre, .file-viewer-markdown .hl-code").first().evaluate((element) => getComputedStyle(element).fontFamily), /monospace/, "its code stays monospace");
  console.log("PASS A Markdown preview takes the chat's font size, font and width");
  await guide.getByRole("button", { name: "Show source", exact: true }).click();
  await guide.locator(".file-viewer-text .hl-line").first().waitFor();
  assert.equal(await guide.locator(".file-viewer-text .hl-line").count(), 7);
  assert.match(await guide.locator(".file-viewer-text").innerText(), /# Guide/);
  console.log("PASS Code shows the Markdown source, one numbered line each");
  const raw = guide.getByRole("link", { name: "Raw", exact: true });
  assert.equal(await raw.getAttribute("target"), "_blank");
  assert.match(await raw.getAttribute("href") ?? "", /\/api\/fs\/file/);
  await guide.getByRole("button", { name: "Copy file", exact: true }).waitFor();
  console.log("PASS Raw opens the file in a new tab; Copy is offered");
  assert.equal(await guide.getByRole("button", { name: "Wrap long lines", exact: true }).count(), 0, "wrapping is a setting, not a header action");
  assert.equal(await guide.locator(".file-viewer-text[data-wrap]").count(), 0, "lines do not wrap by default");
  await guide.getByRole("button", { name: "Show source", exact: true }).click();
  // When both clipboard paths refuse, Copy selects the source: from a Preview it switches to Code first.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no clipboard")) }, configurable: true });
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
  });
  await guide.getByRole("button", { name: "Copy file", exact: true }).click();
  await guide.locator(".file-viewer-text .hl-line").first().waitFor();
  assert.equal(await guide.getByRole("button", { name: "Show source", exact: true }).getAttribute("aria-pressed"), "true");
  const sourceText = await guide.locator(".file-viewer-text").innerText();
  assert.match(sourceText, /See \[notes\]\(\.\.\/notes\.txt\)\./);
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), sourceText, "the selection is exactly the Markdown source");
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await guide.getByRole("button", { name: "Copy file", exact: true }).click();
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), sourceText, "from Code, Copy selects the source in place");
  console.log("PASS When both clipboard paths refuse, Copy selects the Markdown source (switching a Preview to Code)");
  await guide.getByRole("button", { name: "Show source", exact: true }).click();
  await guide.getByRole("button", { name: "notes", exact: true }).click();
  const linked = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await linked.waitFor();
  assert.doesNotMatch(await linked.locator(".file-viewer-meta").getAttribute("title") ?? "", /\/docs\//);
  console.log("PASS A link in a Markdown preview opens the file it names");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // a text file past the load limit: shown in part, so it cannot be copied whole
  await page.getByRole("button", { name: "big", exact: true }).click();
  const big = page.getByRole("dialog", { name: "big.txt", exact: true });
  // the note is the header's size, where it is seen before the text: "256 KB of …"
  const cut = big.locator(".file-viewer-meta .file-viewer-notice");
  await cut.waitFor();
  assert.match(await cut.innerText(), /^256 KB of \d/);
  assert.match(await cut.getAttribute("title") ?? "", /^Showing the first 256 KB/);
  assert.equal(await big.getByRole("button", { name: "Copy file", exact: true }).count(), 0);
  assert.equal(await big.getByText("Too long to highlight").count(), 0, "plain text is never too long to highlight");
  console.log("PASS A text file past the load limit says so in its header and has no Copy");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // code past the load limit: its first 256 KB, highlighted (in the worker), and the header says it is cut
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}") as Record<string, unknown>;
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ ...settings, wrapCode: true }));
  });
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.getByRole("button", { name: "big code", exact: true }).click();
  const bigCode = page.getByRole("dialog", { name: "big.ts", exact: true });
  await bigCode.locator(".file-viewer-text .hl-keyword", { hasText: "export" }).first().waitFor();
  assert.match(await bigCode.locator(".file-viewer-meta .file-viewer-notice").getAttribute("title") ?? "", /^Showing the first 256 KB$/);
  assert.equal(await bigCode.getByRole("button", { name: "Copy file", exact: true }).count(), 0);
  console.log("PASS Code past the load limit shows its first 256 KB, highlighted");
  await bigCode.locator(".file-viewer-text[data-wrap]").waitFor();
  console.log("PASS Settings → Wrap long lines wraps the code");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // a quote nested 20 000 deep renders as a quote nested to the parser's limit, the rest its text
  await page.getByRole("button", { name: "deep quotes", exact: true }).click();
  const deep = page.getByRole("dialog", { name: "deep.md", exact: true });
  // one paragraph, in the innermost quote: the markers past the limit, then the text. At 390px the
  // quotes' padding and rails leave it no width, as the same quote does in the chat, so the step
  // checks that it is there and how deep, not that it can be read.
  const deepest = deep.locator(".file-viewer-markdown blockquote p", { hasText: "> deepest" });
  await deepest.waitFor({ state: "attached" });
  const quoteDepth = await deepest.evaluate((element) => {
    let depth = 0;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent.tagName === "BLOCKQUOTE") depth += 1;
    return depth;
  });
  // the parser nests 32 levels (MAX_QUOTE_DEPTH in src/lib/markdown.ts); the 33rd holds the rest as text
  assert.equal(quoteDepth, 33, "the quote nests to the parser's limit");
  assert.equal(await deep.getByRole("alert").count(), 0, "the preview renders, not its fallback");
  console.log("PASS A Markdown file of 20 000 nested quotes renders, and the app stays");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // an empty file opens empty, whole, with Copy: not as an error
  await page.getByRole("button", { name: "empty", exact: true }).click();
  const empty = page.getByRole("dialog", { name: "empty.txt", exact: true });
  await empty.getByRole("button", { name: "Copy file", exact: true }).waitFor();
  assert.equal(await empty.getByRole("alert").count(), 0);
  assert.equal(await empty.locator(".file-viewer-notice").count(), 0, "an empty file is not cut short");
  console.log("PASS An empty file opens as an empty file, not as an error");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // nothing an agent writes can freeze the page: a long task of a second or more is a frozen tab
  const longTasks = async () => page.evaluate(() => (window as unknown as { longTasks?: number[] }).longTasks ?? []);
  await page.evaluate(() => {
    const record = window as unknown as { longTasks: number[] };
    record.longTasks = [];
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) record.longTasks.push(entry.duration); }).observe({ type: "longtask" });
  });
  // a chat code block the highlighter gives up on stays plain and says so
  await page.locator(".markdown-code .hl-note", { hasText: "Too long to highlight" }).waitFor();
  assert.equal(await page.locator(".markdown-code").nth(1).locator("code span:not(.hl-line)").count(), 0, "the slow block is plain");
  await page.locator(".markdown-code").first().locator(".hl-keyword", { hasText: "const" }).waitFor();
  console.log("PASS A chat code block too slow to highlight stays plain, the others are colored");

  // a Markdown file the highlighter is slow on: its Preview shows, and its source stays plain with a
  // notice, while the page runs on
  await page.getByRole("button", { name: "slow preview", exact: true }).click();
  const slow = page.getByRole("dialog", { name: "slow.md", exact: true });
  await slow.locator(".file-viewer-markdown p").first().waitFor({ timeout: 15_000 });
  await slow.getByRole("button", { name: "Show source", exact: true }).click();
  const slowNote = slow.locator(".file-viewer-meta .file-viewer-notice");
  await page.waitForFunction(() => document.querySelector(".file-viewer-notice")?.getAttribute("title") === "Too long to highlight", undefined, { timeout: 15_000 });
  assert.equal(await slowNote.locator(".visually-hidden").innerText(), "Too long to highlight", "a screen reader still hears it");
  assert.equal(await slow.locator(".hl-note").count(), 0, "the note is not repeated under the code");
  await slow.locator(".file-viewer-text .hl-line").first().waitFor();
  assert.equal(await slow.locator(".file-viewer-text code span:not(.hl-line)").count(), 0, "the source is plain");
  const frozen = (await longTasks()).filter((duration) => duration >= 1_000);
  assert.deepEqual(frozen, [], "no task held the page for a second");
  console.log("PASS A Markdown file the highlighter is slow on previews, its source stays plain, and the page never freezes");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // a Markdown file past the load limit: its first 256 KB, previewed, and the header says it is cut
  await page.getByRole("button", { name: "long notes", exact: true }).click();
  const long = page.getByRole("dialog", { name: "long.md", exact: true });
  await long.locator(".file-viewer-markdown .markdown-h1").first().waitFor();
  assert.match(await long.locator(".file-viewer-meta .file-viewer-notice").getAttribute("title") ?? "", /^Showing the first 256 KB$/);
  await long.getByRole("button", { name: "Show source", exact: true }).waitFor();
  console.log("PASS A Markdown file past the load limit previews its first 256 KB and says it is cut");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // Settings → Highlight code, off: code is plain text, in the chat and the viewer
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}") as Record<string, unknown>;
    localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ ...settings, highlightCode: false }));
  });
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(".markdown-code .hl-code").first().waitFor();
  assert.equal(await page.locator(".markdown-code .hl-keyword, .markdown-code .hl-number").count(), 0, "chat code is plain");
  assert.equal(await page.locator(".markdown-code .hl-note").count(), 0, "plain by choice is not too long");
  await page.getByRole("button", { name: "guide", exact: true }).click();
  const plainGuide = page.getByRole("dialog", { name: "guide.md", exact: true });
  await plainGuide.getByRole("heading", { name: "Guide", exact: true }).waitFor();
  await plainGuide.getByRole("button", { name: "Show source", exact: true }).click();
  await plainGuide.locator(".file-viewer-text .hl-line").first().waitFor();
  assert.equal(await plainGuide.locator(".hl-keyword, .hl-function").count(), 0, "the viewer's code is plain");
  assert.equal(await plainGuide.locator(".file-viewer-notice").count(), 0, "and no notice says it is too long");
  console.log("PASS Settings → Highlight code off shows code plain, in the chat and the viewer");
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.locator(".file-viewer").waitFor({ state: "hidden" });

  // the file found, then its body refused (the file gone since, a remote PC dropped): the error's
  // JSON must never show as the file's text
  await page.route("**/api/fs/file?**", (route) => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "machine_unavailable", message: "The PC connection was interrupted" } }) }), { times: 1 });
  await page.getByRole("button", { name: "notes", exact: true }).click();
  const refused = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await refused.getByRole("alert").waitFor();
  assert.equal(await refused.getByRole("alert").innerText(), "The file could not be opened.");
  assert.equal(await refused.getByText("machine_unavailable").count(), 0);
  assert.equal(await refused.locator(".file-viewer-text").count(), 0);
  console.log("PASS A file whose body is refused shows an error, not the error's JSON");
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
