/** Production CSP + real cross-origin HTTPS/CORS + Chromium MediaRecorder, never a vendor service.
 * Build first, then: bun run check run bun scripts/dictation-regression.ts
 * Only the owned test pane is attached. Speech requests are NOT Playwright-fulfilled.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { openSettingsPage } from "./settings-page.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-dictation-browser-")));
const model = "test/installed-english";
const transcript = "spoken words";
const requests: Array<{ path: string; method: string; origin: string | null; authorization: string | null; cookie: string | null; referer: string | null; fields?: Record<string, string>; fileSize?: number; fileType?: string; fileName?: string }> = [];
let appOrigin = "";
let cors = true;
let hold = false;
const pending: Array<() => void> = [];
let completed = 0;
let server: ReturnType<typeof createServer> | undefined;
let speech: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let workspace: string | undefined;

async function until(label: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await Bun.sleep(25);
  }
}
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
  let n = 8;
  const tick = () => { if (--n === 0) resolve(); else requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}));
const posts = () => requests.filter((request) => request.method === "POST");
const popover = (page: Page) => page.locator(".comment-popover");
const settings = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Dictation");
};
const closeSettings = (page: Page) => page.getByRole("button", { name: "Close settings", exact: true }).click();
async function caret(field: Locator, at: number): Promise<void> {
  await field.focus();
  await field.evaluate((node: HTMLTextAreaElement, position) => {
    node.setSelectionRange(position, position);
    node.dispatchEvent(new Event("select", { bubbles: true }));
  }, at);
}
async function assertInlineComposerStatus(surface: Locator): Promise<void> {
  if (!await surface.evaluate((node) => node.classList.contains("composer"))) return;
  assert.equal(await surface.locator(":scope > .voice-pill").count(), 0, "no separate dictation box outside the input card");
  assert.ok(await surface.locator(".composer-draft > .voice-pill").evaluate((node) => {
    const field = node.closest(".composer-draft")!;
    const card = node.closest(".composer-surface")!;
    const status = node.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    const style = getComputedStyle(node);
    return field.contains(card.querySelector("textarea"))
      && status.left >= bounds.left && status.right <= bounds.right
      && status.top >= bounds.top && status.bottom <= bounds.bottom
      && style.borderTopWidth === "0px" && style.borderRadius === "0px";
  }), "dictation status shares the editable message area without a separate border");
  assert.equal(await surface.locator("textarea").getAttribute("placeholder"), "", "recording/transcribing takes the placeholder's place");
}
async function start(page: Page, surface: Locator, keyboard = false): Promise<void> {
  await surface.locator(".voice-mic").waitFor();
  assert.equal(await surface.locator(".voice-mic").count(), 1, "one replacement microphone per surface");
  await page.evaluate(() => { (window as any).__dictationBytes = 0; });
  const button = surface.getByRole("button", { name: "Start dictation", exact: true });
  if (keyboard) { await button.focus(); await page.keyboard.press("Enter"); }
  else {
    await button.scrollIntoViewIfNeeded();
    const bounds = (await button.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    try {
      await surface.locator('.voice-mic-wrap[data-state="recording"]').waitFor();
      assert.equal(await surface.locator('.voice-mic-wrap[data-state="recording"]').count(), 1, "capture starts before pointer release");
    } finally { await page.mouse.up(); }
  }
  try { await surface.locator('.voice-mic-wrap[data-state="recording"]').waitFor(); }
  catch (error) {
    console.error("Dictation start failure:", { posts: posts().length, surface: await surface.innerText(), state: await surface.locator(".voice-mic-wrap").getAttribute("data-state"), locks: await page.evaluate(() => navigator.locks.query()) });
    throw error;
  }
  // Wait for actual encoded audio, not a timing guess or a mocked MediaRecorder.
  await page.waitForFunction(() => (window as any).__dictationBytes > 0);
  assert.equal(await surface.locator('.voice-pill [role="status"]').getAttribute("aria-live"), "polite");
  assert.ok(await surface.locator(".voice-pill").evaluate((node) => !["absolute", "fixed"].includes(getComputedStyle(node).position)), "status is in flow");
  await assertInlineComposerStatus(surface);
}
async function finish(page: Page, surface: Locator, keyboard = false): Promise<void> {
  const before = posts().length;
  const button = surface.getByRole("button", { name: "Finish dictation", exact: true });
  if (keyboard) { await button.focus(); await page.keyboard.press("Space"); }
  else await button.click();
  try { await until("one multipart upload", () => posts().length === before + 1); }
  catch (error) {
    console.error("Dictation finish failure:", { before, after: posts().length, state: await surface.locator(".voice-mic-wrap").getAttribute("data-state"), surface: await surface.innerText() });
    throw error;
  }
}
async function release(page: Page): Promise<void> {
  const before = completed;
  assert.equal(pending.length, 1, "exactly one held inference");
  pending.shift()!();
  await until("speech response released", () => completed > before);
  await frames(page);
}
async function stores(page: Page): Promise<Array<{ comment: string }>> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("herdr-web-ui:block-comments:"))
    .flatMap((key) => JSON.parse(localStorage.getItem(key)!).comments));
}

try {
  // A disposable key, not a checked-in certificate or a dependency on the private speech host.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore", timeout: 15_000 });
  speech = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: readFileSync(join(root, "key.pem")), cert: readFileSync(join(root, "cert.pem")) }, async fetch(request) {
    const path = new URL(request.url).pathname;
    const item: (typeof requests)[number] = { path, method: request.method, origin: request.headers.get("origin"), authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), referer: request.headers.get("referer") };
    const headers = cors && item.origin === appOrigin ? { "Access-Control-Allow-Origin": appOrigin, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "content-type", Vary: "Origin" } : {};
    if (request.method === "POST") {
      // Bun's File.type may infer video/webm from the filename; assert the browser's actual part header.
      const wire = new TextDecoder().decode((await request.clone().arrayBuffer()).slice(0, 4096));
      const wireType = wire.match(/filename="[^"]+"\r\nContent-Type:\s*([^\r\n]+)/i)?.[1];
      const form = await request.formData();
      const file = form.get("file");
      assert.ok(file instanceof File, "audio is a multipart File");
      item.fields = Object.fromEntries([...form].filter(([, value]) => typeof value === "string") as Array<[string, string]>);
      item.fileSize = file.size; item.fileType = wireType ?? file.type; item.fileName = file.name;
    }
    requests.push(item);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (path === "/v1/models" && request.method === "GET") return Response.json({ data: [{ id: model }, { id: "test/second-model" }] }, { headers });
    if (path === "/v1/audio/transcriptions" && request.method === "POST") {
      if (hold) await new Promise<void>((resolve) => pending.push(resolve));
      completed++;
      return Response.json({ text: transcript }, { headers });
    }
    return new Response("unexpected speech request", { status: 404, headers });
  } });
  const speechOrigin = `https://127.0.0.1:${speech.port}`;
  const baseUrl = `${speechOrigin}/v1`;
  const owned = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-dictation", focus: false });
  workspace = owned.workspace.workspace_id;
  const pane = owned.root_pane.pane_id;
  writeFileSync(join(root, "dictation.txt"), "A fictional file line for a draft comment.\nSecond line.\n");
  server = createServer({ hostname: "127.0.0.1", port: 0, token: "", stateDir: join(root, "state"), dictationOrigins: [speechOrigin], usage: new UsageService(undefined, []) });
  appOrigin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--ignore-certificate-errors"] });

  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 720 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, ignoreHTTPSErrors: true, permissions: ["microphone"], locale: "en-US" });
    try {
      const initialRequests = requests.length;
      const sent: unknown[] = [];
      const legacy: string[] = [];
      const errors: string[] = [];
      await context.addInitScript(({ pane, baseUrl, model }) => {
        if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertsOn: false, voiceInput: "auto", terminalInputMode: "line", dictation: { baseUrl, model, activated: false } }));
        localStorage.setItem(`herdr-web-ui:view:${pane}`, "chat");
        const Recorder = window.MediaRecorder;
        window.MediaRecorder = class extends Recorder {
          constructor(stream: MediaStream, options?: MediaRecorderOptions) {
            super(stream, options);
            // A cancelled recorder may still emit its final chunk while the next permission is pending.
            // Only this take's encoded bytes can authorize the test's Finish action.
            (window as any).__dictationRecorder = this;
            (window as any).__dictationBytes = 0;
            this.addEventListener("dataavailable", (event) => {
              if ((window as any).__dictationRecorder === this) (window as any).__dictationBytes += event.data.size;
            });
          }
        };
      }, { pane, baseUrl, model });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/voice")) legacy.push(request.url()); });
      // Only transcript and outgoing PTY input are fixtures. CSP, policy, media capture and speech HTTP are real.
      await page.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: { source: "claude-transcript", history_id: "dictation-fixture", turns: [{ role: "assistant", ts: "2026-01-01T00:00:00Z", end_ts: "2026-01-01T00:00:01Z", parts: [{ kind: "text", text: `A fictional reply for dictation comments.\n\n[dictation.txt](${join(root, "dictation.txt")})` }] }] } }));
      await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
        const upstream = socket.connectToServer();
        upstream.onMessage((raw) => socket.send(raw));
        socket.onMessage((raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.type === "input" || frame.type === "submit") {
            sent.push(frame);
            if (frame.type === "submit") socket.send(JSON.stringify({ type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok: true }));
          } else upstream.send(raw);
        });
      });
      const response = await page.goto(`${appOrigin}/?pane=${encodeURIComponent(pane)}`);
      const csp = response!.headers()["content-security-policy"]!;
      assert.ok(csp.includes(speechOrigin), "the production document allows the exact speech origin");
      assert.ok(!/connect-src[^;]*(?:\shttps:|\swss:)(?:\s|;)/.test(csp), "no wildcard scheme permission");
      await page.locator(".conn-live").waitFor();
      const composer = page.locator(".composer");
      const message = page.getByRole("textbox", { name: "Message", exact: true });
      await message.waitFor();
      await composer.locator(".voice-mic").waitFor();
      assert.equal(await composer.locator(".voice-mic").isDisabled(), true, "unconfigured dictation stays visible with a setup reason on both layouts");
      await settings(page);
      assert.equal(await page.getByRole("button", { name: "Refresh models", exact: true }).isDisabled(), true);
      assert.equal(await page.locator('.settings-dialog input[type="password"]').count(), 0, "no legacy API key editor");
      await page.locator("#dictation-base-url").fill(baseUrl);
      await page.locator("#dictation-model").fill(model);
      await frames(page);
      assert.equal(requests.length, initialRequests, "loading or editing presets never contacts the speech host");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await frames(page);
      assert.equal(requests.length, initialRequests, "Apply activates locally, without discovery or inference");
      await page.getByRole("button", { name: "Refresh models", exact: true }).click();
      await page.locator("#dictation-model-list").waitFor();
      assert.equal(requests.length, initialRequests + 1);
      assert.equal(requests.at(-1)!.method, "GET");
      await page.locator("#dictation-base-url").fill("https://unapproved.invalid/v1");
      assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true, "policy rejects an unapproved settings destination");
      await page.locator("#dictation-base-url").fill(`${baseUrl}/other`);
      assert.equal(await page.getByRole("button", { name: "Refresh models", exact: true }).isDisabled(), true, "unsaved URL cannot be probed");
      await page.getByRole("button", { name: "Discard edits", exact: true }).click();
      await closeSettings(page);

      // CORS is enforced by the browser even though CSP approves this origin.
      cors = false;
      assert.equal(await page.evaluate(async (url) => { try { await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" }); return false; } catch { return true; } }, `${baseUrl}/models`), true);
      cors = true;
      // Same server, different hostname: the exact-origin CSP must block BEFORE network access.
      const beforeBlocked = requests.length;
      const blocked = speechOrigin.replace("127.0.0.1", "localhost");
      assert.equal(await page.evaluate(async (url) => { try { await fetch(url); return false; } catch { return true; } }, `${blocked}/v1/models`), true);
      assert.equal(requests.length, beforeBlocked, "unapproved origin is blocked, not route-fulfilled");

      // An actual same-origin second tab excludes capture; repeating Busy must retain its explanation.
      const lockPage = await context.newPage();
      await lockPage.goto(`${appOrigin}/api/health`);
      await lockPage.evaluate(() => new Promise<void>((ready) => {
        void navigator.locks.request("herdr-dictation", () => new Promise<void>((release) => {
          (window as any).__releaseDictationLock = release;
          ready();
        }));
      }));
      await page.bringToFront();
      for (let attempt = 0; attempt < 2; attempt++) {
        await composer.getByRole("button", { name: "Start dictation", exact: true }).click();
        await composer.getByText("Another input or tab is using dictation", { exact: true }).waitFor();
      }
      await lockPage.evaluate(() => (window as any).__releaseDictationLock());
      await lockPage.close();

      await message.fill("prefix suffix");
      await caret(message, 7);
      await start(page, composer, true);
      if (process.env.UI_EVIDENCE_DIR) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `dictation-inline-recording-${mobile ? "phone" : "desktop"}.png`) });
      }
      await finish(page, composer, true);
      await until("captured-caret insertion", async () => await message.inputValue() === "prefix spoken words suffix");
      assert.equal(sent.length, 0, "dictation never sends");
      const upload = posts().at(-1)!;
      assert.deepEqual(upload.fields, { model, language: "en", response_format: "json" });
      assert.ok(upload.fileSize! > 0);
      assert.match(upload.fileType!, /^audio\/(webm|mp4|ogg)/);
      assert.match(upload.fileName!, /\.(webm|mp4|m4a|ogg)$/);

      // Undo takes, not the whole draft, including repeated text and insertion at the caret.
      await caret(message, (await message.inputValue()).length);
      await start(page, composer);
      await finish(page, composer);
      await until("second take inserted", async () => await message.inputValue() === "prefix spoken words suffix spoken words");
      if (process.env.UI_EVIDENCE_DIR) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `dictation-undo-${mobile ? "phone" : "desktop"}.png`) });
      }
      await composer.getByRole("button", { name: "Undo last dictation", exact: true }).click();
      assert.equal(await message.inputValue(), "prefix spoken words suffix");
      await composer.getByRole("button", { name: "Undo last dictation", exact: true }).focus();
      await page.keyboard.press("Enter");
      assert.equal(await message.inputValue(), "prefix suffix");
      assert.equal(await composer.getByRole("button", { name: "Undo last dictation", exact: true }).count(), 0);

      // Both recording-time edits and caret-only movement must recover, not overwrite.
      for (const change of ["text", "caret"]) {
        await message.fill("keep this draft");
        await caret(message, 4);
        await start(page, composer);
        if (change === "text") await message.fill("new visible draft");
        await caret(message, 0);
        await finish(page, composer);
        const insert = composer.getByRole("button", { name: "Insert at cursor", exact: true });
        await insert.waitFor();
        const before = await message.inputValue();
        await insert.focus();
        await page.keyboard.press("Enter");
        await until("keyboard recovery respects saved cursor", async () => await message.inputValue() === `${transcript} ${before}`);
      }
      hold = true;
      await message.fill("visible only");
      await start(page, composer);
      await finish(page, composer);
      await composer.locator('.voice-pill[data-state="transcribing"]').waitFor();
      await assertInlineComposerStatus(composer);
      assert.equal(await message.inputValue(), "visible only", "transcription leaves the editable draft visible");
      if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `dictation-inline-transcribing-${mobile ? "phone" : "desktop"}.png`) });
      await composer.getByRole("button", { name: "Cancel dictation", exact: true }).click();
      await release(page);
      assert.equal(await message.inputValue(), "visible only", "late cancelled result cannot insert");
      await start(page, composer);
      await finish(page, composer);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await until("explicit Send clears draft", async () => await message.inputValue() === "");
      await release(page);
      assert.equal(await message.inputValue(), "", "late result never repopulates a sent draft");

      await message.fill("composition draft");
      await start(page, composer);
      await finish(page, composer);
      await message.dispatchEvent("compositionstart", { data: "" });
      await release(page);
      await composer.getByRole("button", { name: "Discard", exact: true }).waitFor();
      await composer.getByRole("button", { name: "Discard", exact: true }).focus();
      await page.keyboard.press("Space");
      await message.dispatchEvent("compositionend", { data: "" });
      assert.equal(await message.inputValue(), "composition draft", "discarded IME result does not flush later");

      await start(page, composer);
      await settings(page);
      await page.keyboard.press("Escape");
      await page.locator(".settings-dialog").waitFor({ state: "detached" });
      assert.equal(await composer.locator('.voice-mic-wrap[data-state="recording"]').count(), 1, "nested Settings Escape does not cancel the lower take");
      await finish(page, composer);
      await settings(page);
      await page.locator("#dictation-model").fill("test/second-model");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await closeSettings(page);
      await release(page);
      assert.equal(await message.inputValue(), "composition draft", "Apply invalidates an old model's pending response");
      hold = false;

      // Reply comments: new, saved, Escape from footer, keyboard Save while inference is pending.
      const reply = page.locator(".chat-view p.is-commentable", { hasText: "A fictional reply" });
      await reply.click();
      let field = popover(page).getByRole("textbox", { name: "Comment", exact: true });
      await field.fill("comment draft");
      await start(page, popover(page));
      // IME owns both Escape and committing Enter, including WebKit's 229 event.
      await field.dispatchEvent("compositionstart", { data: "" });
      await field.dispatchEvent("keydown", { key: "Escape", isComposing: true });
      await field.dispatchEvent("keydown", { key: "Escape", keyCode: 229 });
      await field.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
      await field.dispatchEvent("keydown", { key: "Enter", ctrlKey: true, keyCode: 229 });
      assert.equal(await popover(page).count(), 1);
      assert.equal(await popover(page).locator('.voice-mic-wrap[data-state="recording"]').count(), 1);
      await field.dispatchEvent("compositionend", { data: "" });
      // A native modal has no aria-modal attribute: its Escape still cannot dismiss the lower comment.
      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.id = "dictation-native-modal-test";
        dialog.innerHTML = '<input aria-label="Nested dialog input">';
        document.body.append(dialog);
        dialog.showModal();
      });
      await page.getByRole("textbox", { name: "Nested dialog input" }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await popover(page).locator('.voice-mic-wrap[data-state="recording"]').count(), 1);
      await page.evaluate(() => document.getElementById("dictation-native-modal-test")?.remove());
      if (process.env.UI_EVIDENCE_DIR) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `dictation-comment-${mobile ? "phone" : "desktop"}.png`) });
      }
      await popover(page).getByRole("button", { name: "Cancel dictation", exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await popover(page).count(), 1, "first Escape cancels recording, not the comment");
      assert.equal(await field.inputValue(), "comment draft");
      await start(page, popover(page));
      await finish(page, popover(page));
      await until("comment dictation", async () => (await field.inputValue()).includes(transcript));
      await start(page, popover(page));
      await caret(field, 0);
      await finish(page, popover(page));
      const commentRecovery = popover(page).getByRole("button", { name: "Insert at cursor", exact: true });
      await commentRecovery.waitFor();
      await commentRecovery.focus();
      await page.keyboard.press("ControlOrMeta+Shift+Space");
      assert.equal(await composer.locator('.voice-mic-wrap[data-state="idle"]').count(), 1, "recovering comment shortcut never starts the composer behind it");
      assert.equal(await popover(page).locator('.voice-mic-wrap[data-state="idle"]').count(), 1);
      await popover(page).getByRole("button", { name: "Discard", exact: true }).click();
      assert.equal((await stores(page)).length, 0, "dictation does not Save comments");
      await field.focus();
      await page.keyboard.press("Control+Enter");
      await popover(page).waitFor({ state: "detached" });
      const saved = `${(await stores(page))[0]!.comment} edited`;
      await page.locator(".chat-view .comment-pin:not(.is-pending)").first().click();
      field = popover(page).getByRole("textbox", { name: "Comment", exact: true });
      await field.fill(saved);
      hold = true;
      await start(page, popover(page));
      await finish(page, popover(page));
      await field.focus();
      await page.keyboard.press("Control+Enter");
      await popover(page).waitFor({ state: "detached" });
      await release(page);
      assert.equal((await stores(page))[0]!.comment, saved, "saved-comment keyboard Save invalidates pending inference");
      hold = false;

      // File comment uses the same draft-only controls, with no 2,000-character truncation.
      await page.getByRole("button", { name: "dictation.txt", exact: true }).click();
      const viewer = page.getByRole("dialog", { name: "dictation.txt", exact: true });
      await viewer.locator('.hl-line[data-source-line="1"]').click();
      field = popover(page).getByRole("textbox", { name: "Comment", exact: true });
      await field.fill("long comment ".repeat(180));
      // Reduced visual space models a keyboard-open layout; this is not a real phone keyboard test.
      if (mobile) { await page.setViewportSize({ width: 390, height: 500 }); await frames(page); }
      await start(page, popover(page));
      if (mobile) {
        const clipped = await popover(page).locator(".voice-pill").evaluate((node) => {
          const parent = node.closest(".comment-popover")!.getBoundingClientRect();
          return [node, ...node.querySelectorAll("button, [role='status']")].some((item) => {
            const box = item.getBoundingClientRect();
            return box.width > 0 && (box.left < Math.max(0, parent.left) - 1 || box.right > Math.min(innerWidth, parent.right) + 1);
          });
        });
        assert.equal(clipped, false, "status and Cancel fit the narrow keyboard-sized comment sheet");
      }
      await finish(page, popover(page));
      await until("long file comment insertion", async () => (await field.inputValue()).includes(transcript));
      if (mobile) await page.setViewportSize({ width: 390, height: 720 });
      assert.ok((await field.inputValue()).length > 2000);
      await field.focus();
      await page.keyboard.press("Control+Enter");
      await popover(page).waitFor({ state: "detached" });
      const beforeClose = await stores(page);
      await viewer.locator(".comment-pin:not(.is-pending)").first().click();
      hold = true;
      await start(page, popover(page));
      await finish(page, popover(page));
      await popover(page).getByRole("button", { name: "Cancel dictation", exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await popover(page).count(), 1);
      await page.keyboard.press("Escape");
      await popover(page).waitFor({ state: "detached" });
      await release(page);
      assert.deepEqual(await stores(page), beforeClose, "saved file comment close expires the old owner's result");
      hold = false;
      await viewer.getByRole("button", { name: "Close file", exact: true }).click();

      // A reply from history not currently loaded has no pin: Composer owns a separate saved-comment dialog.
      const editorSeed = await context.newPage();
      await editorSeed.goto(`${appOrigin}/api/health`);
      await editorSeed.evaluate(() => {
        const key = Object.keys(localStorage).find((name) => name.startsWith("herdr-web-ui:block-comments:"))!;
        const data = JSON.parse(localStorage.getItem(key)!);
        data.comments.find((comment: { kind?: string }) => comment.kind !== "file").anchor = "history-not-loaded:0:0";
        localStorage.setItem(key, JSON.stringify(data));
      });
      await editorSeed.close();
      await page.bringToFront();
      await until("the old reply pin to leave", async () => await page.locator(".chat-view .comment-pin:not(.is-pending)").count() === 0);
      await composer.locator(".composer-comments-walk").click();
      await popover(page).waitFor();
      field = popover(page).getByRole("textbox", { name: "Comment", exact: true });
      await field.fill("visible saved-dialog edit");
      hold = true;
      await start(page, popover(page));
      await finish(page, popover(page));
      await popover(page).getByRole("button", { name: "Save comment", exact: true }).click();
      await popover(page).waitFor({ state: "detached" });
      await release(page);
      assert.ok((await stores(page)).some((entry) => entry.comment === "visible saved-dialog edit"), "Composer saved-comment Save keeps only the visible edit");
      hold = false;

      // Direct grid typing must not hide the separate dictation draft, even on desktop.
      await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await openSettingsPage(page, "Terminal");
      await page.locator("#terminal-input-mode").selectOption("direct");
      await closeSettings(page);
      // Terminal line is also a draft: speech must never emit terminal input or Enter.
      await page.locator('.view-switch button[title^="Live terminal"]').click();
      const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
      await line.fill("echo ");
      await caret(line, 5);
      const terminal = page.locator(".terminal-input");
      const beforeTerminal = sent.length;
      await start(page, terminal);
      await finish(page, terminal);
      await until("terminal draft insertion", async () => await line.inputValue() === "echo spoken words");
      assert.equal(sent.length, beforeTerminal);
      for (const event of ["pagehide", "offline"]) {
        const beforeInterrupted = posts().length;
        await start(page, terminal);
        await page.evaluate((name) => window.dispatchEvent(new Event(name)), event);
        await terminal.locator('.voice-mic-wrap[data-state="idle"]').waitFor();
        await frames(page);
        assert.equal(posts().length, beforeInterrupted, `${event} cancels without an automatic upload`);
        assert.equal(await line.inputValue(), "echo spoken words");
      }
      assert.deepEqual(legacy, [], "replacement client never requests /api/voice");
      assert.deepEqual(errors, []);
      console.log(`PASS ${mobile ? "phone" : "desktop"}: direct HTTPS dictation, CORS/CSP, explicit settings, draft recovery, cancellation, IME, comments and terminal`);
    } finally { while (pending.length) pending.shift()!(); hold = false; cors = true; await context.close(); }
  }
  for (const request of requests.filter((item) => item.path.endsWith("audio/transcriptions") || item.path.endsWith("models"))) {
    assert.equal(request.authorization, null);
    assert.equal(request.cookie, null);
    assert.equal(request.referer, null, "discovery and audio both suppress Referer");
    assert.equal(request.origin, appOrigin);
    assert.ok(request.method === "GET" || request.method === "POST" || request.method === "OPTIONS");
  }
  assert.ok(requests.every((request) => request.method !== "POST" || request.path === "/v1/audio/transcriptions"), "no model downloads or hidden inference checks");
} finally {
  while (pending.length) pending.shift()!();
  await browser?.close();
  server?.stop();
  speech?.stop(true);
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
