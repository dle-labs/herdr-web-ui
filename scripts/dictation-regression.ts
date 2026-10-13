/** Production same-origin CSP + backend HTTPS relay + Chromium MediaRecorder, never a vendor service.
 * Run: bun run check run --build bun scripts/dictation-regression.ts
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
import { VoiceService } from "../server/voice.ts";
import { openSettingsPage } from "./settings-page.ts";
import { sanitizeSettings } from "../src/lib/settings.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-dictation-browser-")));
const model = "test/installed-english";
const transcript = "spoken words";
const requests: Array<{ path: string; method: string; origin: string | null; authorization: string | null; cookie: string | null; referer: string | null; fields?: Record<string, string>; fileSize?: number; fileType?: string; fileName?: string }> = [];
let appOrigin = "";
let hold = false;
let speechResult: "ok" | "empty" | "error" = "ok";
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
  assert.equal(await surface.locator("textarea").isVisible(), true, "dictation leaves the draft visible and editable");
  assert.equal(await surface.locator(".voice-pill").getAttribute("aria-hidden"), "false", "open pill is accessible");
  assert.equal(await surface.locator(".voice-pill").getAttribute("hidden"), null, "pill uses mounted upstream transitions, not hidden attributes");
  assert.ok(await surface.locator(".voice-pill").evaluate((node) => {
    const surface = node.closest(".composer, .terminal-input, .comment-draft-input")!;
    const draft = surface.querySelector("textarea")!.getBoundingClientRect();
    const bounds = surface.getBoundingClientRect();
    const pill = node.getBoundingClientRect();
    return pill.bottom <= draft.top + 1 && pill.width < bounds.width
      && pill.left >= -0.5 && pill.right <= innerWidth + 0.5;
  }), "compact pill floats above the visible draft without spanning the input");
}
async function assertCompactWaveform(surface: Locator): Promise<{ count: number; width: number; gap: number; available: number }> {
  const layout = await surface.locator(".voice-pill").evaluate((node) => {
    const bars = node.querySelector<HTMLElement>(".voice-bars")!;
    const children = [...bars.querySelectorAll<HTMLElement>("[data-voice-bar]")];
    const bounds = node.getBoundingClientRect();
    const wave = bars.getBoundingClientRect();
    const row = [...node.querySelectorAll<HTMLElement>(".voice-pill-label, .voice-timer, .voice-pill-button")].map((item) => item.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0);
    return {
      singleRow: row.every((rect) => Math.abs(rect.top + rect.height / 2 - wave.top - wave.height / 2) < 1),
      fits: [wave, ...row].every((rect) => rect.left >= bounds.left - 0.5 && rect.right <= bounds.right + 0.5),
      noOverflow: node.scrollWidth <= node.clientWidth && bars.scrollWidth <= bars.clientWidth,
      stableBars: children.every((bar) => parseFloat(getComputedStyle(bar).width) === 3 && parseFloat(getComputedStyle(bar).height) === 20),
      count: children.length, width: parseFloat(getComputedStyle(children[0]!).width),
      gap: parseFloat(getComputedStyle(bars).columnGap), available: wave.width,
    };
  });
  for (const key of ["singleRow", "fits", "noOverflow", "stableBars"] as const) assert.equal(layout[key], true, `compact waveform geometry: ${key}`);
  assert.equal(layout.count, 7, "upstream pill has seven bars, not adaptive history bars");
  assert.ok(layout.available < 60, "waveform stays compact");
  return { count: layout.count, width: layout.width, gap: layout.gap, available: layout.available };
}
async function start(page: Page, surface: Locator, keyboard = false): Promise<void> {
  await surface.locator(".voice-mic").waitFor();
  assert.equal(await surface.locator(".voice-mic").count(), 1, "one replacement microphone per surface");
  await page.evaluate(() => { (window as any).__dictationBytes = 0; });
  const button = surface.locator('.voice-mic[aria-label="Dictate (hold)"]');
  if (keyboard) { await button.focus(); await page.keyboard.press("Enter"); }
  else {
    // A manual quick tap must wait for modal exit/owner layout without waiting between down and up.
    await button.click({ trial: true });
    const bounds = (await button.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    // Release before awaiting capture: waiting here turns a tap into a held Finish gesture.
    await page.mouse.up();
  }
  try { await surface.locator('.voice-mic-wrap[data-state="recording"]').waitFor(); }
  catch (error) {
    console.error("Dictation start failure:", { posts: posts().length, surface: await surface.innerText(), state: await surface.locator(".voice-mic-wrap").getAttribute("data-state"), locks: await page.evaluate(() => navigator.locks.query()) });
    throw error;
  }
  // Wait for actual encoded audio, not a timing guess or a mocked MediaRecorder.
  await page.waitForFunction(() => (window as any).__dictationBytes > 0);
  assert.equal(await surface.locator('.voice-pill [role="status"]').getAttribute("aria-live"), "polite");
  await assertInlineComposerStatus(surface);
  await assertCompactWaveform(surface);
}
async function finish(page: Page, surface: Locator, keyboard = false): Promise<void> {
  const before = posts().length;
  const button = surface.locator('.voice-mic[aria-label="Insert dictation"]');
  if (keyboard) { await button.focus(); await page.keyboard.press("Space"); }
  else await button.click();
  try { await until("one multipart upload", () => posts().length === before + 1); }
  catch (error) {
    console.error("Dictation finish failure:", { before, after: posts().length, state: await surface.locator(".voice-mic-wrap").getAttribute("data-state"), surface: await surface.innerText() });
    throw error;
  }
}
async function appearance(page: Page, palette: string, theme: string, density: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Appearance");
  await page.getByLabel("Colors", { exact: true }).selectOption(palette);
  await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true }).click();
  await page.getByRole("group", { name: "Density", exact: true }).getByRole("button", { name: density === "compact" ? "Compact" : "Comfortable", exact: true }).click();
  await page.waitForFunction(({ palette, theme, density }) => {
    const root = document.documentElement;
    return root.dataset.palette === palette && root.dataset.theme === theme && root.dataset.density === density;
  }, { palette, theme, density });
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!));
  assert.deepEqual([stored.palette, stored.theme, stored.density], [palette, theme, density], "appearance changes use the real preference controls");
  await closeSettings(page);
}
async function assertPillColors(surface: Locator): Promise<void> {
  const colors = await surface.locator(".voice-pill").evaluate((node) => {
    const probe = document.createElement("span");
    node.append(probe);
    const token = (name: string): string => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
    const style = getComputedStyle(node);
    const result = {
      background: style.backgroundColor, backgrounds: [token("--bg-elevated"), token("--bg-panel")],
      foreground: style.color, foregrounds: [token("--text-strong"), token("--text-dim")],
      border: style.borderTopColor, borders: [token("--border"), token("--accent")],
      bar: node.querySelector("[data-voice-bar]") ? getComputedStyle(node.querySelector("[data-voice-bar]")!).backgroundColor : null,
      accent: token("--accent"),
    };
    probe.remove();
    return result;
  });
  assert.ok(colors.backgrounds.includes(colors.background), "pill background follows palette surfaces");
  assert.ok(colors.foregrounds.includes(colors.foreground), "pill text follows palette contrast tokens");
  assert.ok(colors.borders.includes(colors.border), "pill border follows palette tokens");
  if (colors.bar !== null) assert.equal(colors.bar, colors.accent, "bars follow the palette accent");
}
async function assertTranscribingLoader(surface: Locator, reduced = false): Promise<void> {
  const pill = surface.locator('.voice-pill[data-state="transcribing"]');
  await pill.waitFor();
  await assertInlineComposerStatus(surface);
  assert.equal(await pill.getAttribute("aria-hidden"), "false", "active loading is exposed to assistive technology");
  assert.equal(await pill.locator("[data-voice-bar]").count(), 7, "loading retains the compact waveform geometry");
  await until("transcribing bars faded out", async () => await pill.locator(".voice-bars").evaluate((node) => getComputedStyle(node).opacity) === "0");
  assert.equal(await pill.locator(".voice-bars").evaluate((node) => getComputedStyle(node).opacity), "0", "loading hides live bars rather than recording history");
  assert.equal(await pill.locator(".voice-done").isDisabled(), true, "Insert is disabled during transcription");
  const loader = pill.locator("svg.voice-loading");
  assert.equal(await loader.count(), 1, "transcription has one LoaderCircle");
  assert.equal(await loader.isVisible(), true, "loading remains visible even with reduced motion");
  const animation = await loader.evaluate((node) => {
    const style = getComputedStyle(node);
    return { name: style.animationName, timing: style.animationTimingFunction, duration: style.animationDuration };
  });
  if (reduced) assert.ok(animation.name === "none" || animation.duration.split(",").every((value) => parseFloat(value) <= 0.01), "reduced-motion stops spinner movement");
  else {
    assert.notEqual(animation.name, "none", "transcribing loader animates");
    assert.match(animation.timing, /^steps\(/, "loader uses the shared stepped spinner style");
  }
}
async function finishAndSendPreference(page: Page, enabled: boolean): Promise<void> {
  await settings(page);
  const toggle = page.getByRole("switch", { name: "Finish and send", exact: true });
  if (await toggle.getAttribute("aria-checked") !== String(enabled)) await toggle.click();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).voiceFinishAndSend), enabled);
  await closeSettings(page);
}
async function withFinishAndSend(page: Page, work: () => Promise<void>): Promise<void> {
  await finishAndSendPreference(page, true);
  try { await work(); } finally { await finishAndSendPreference(page, false); }
}
async function release(page: Page): Promise<void> {
  const before = completed;
  assert.equal(pending.length, 1, "exactly one held inference");
  pending.shift()!();
  await until("speech response released", () => completed > before);
  await frames(page);
}

try {
  // Synthetic mono PCM sine, generated at runtime; no private/user recording is stored in Git.
  // Chrome's default fake tone can fall below backend VAD's speech threshold.
  const sampleRate = 48_000;
  const samples = sampleRate * 20;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) wav.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 0.25 * 32767), 44 + index * 2);
  writeFileSync(join(root, "microphone.wav"), wav);
  // A disposable key, not a checked-in certificate or a dependency on the private speech host.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore", timeout: 15_000 });
  speech = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: readFileSync(join(root, "key.pem")), cert: readFileSync(join(root, "cert.pem")) }, async fetch(request) {
    const path = new URL(request.url).pathname;
    const item: (typeof requests)[number] = { path, method: request.method, origin: request.headers.get("origin"), authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie"), referer: request.headers.get("referer") };
    const headers = {}; // Deliberately no CORS: only the backend can reach this service.
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
      if (speechResult === "error") return new Response("fixture failure", { status: 500 });
      return Response.json({ text: speechResult === "empty" ? "" : transcript }, { headers });
    }
    return new Response("unexpected speech request", { status: 404, headers });
  } });
  const speechOrigin = `https://127.0.0.1:${speech.port}`;
  const baseUrl = `${speechOrigin}/v1`;
  const owned = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-dictation", focus: false });
  workspace = owned.workspace.workspace_id;
  const pane = owned.root_pane.pane_id;
  writeFileSync(join(root, "dictation.txt"), "A fictional file line for a draft comment.\nSecond line.\n");
  const dictationFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, speechOrigin, "the injected CA applies only to the disposable fixture");
    return Bun.fetch(input, { ...init, tls: { ca: readFileSync(join(root, "cert.pem")) } });
  };
  const openAiCalls: string[] = [];
  let failOpenAI = false;
  const voice = new VoiceService({ stateDir: join(root, "state"), env: {}, fetch: (async (input, init) => {
    const url = String(input); openAiCalls.push(url);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-openai-key");
    if (failOpenAI) return Response.json({ error: { message: "fixture provider failure" } }, { status: 500 });
    return url.endsWith("/audio/transcriptions") ? Response.json({ text: "automatic OpenAI transcript" })
      : Response.json({ choices: [{ message: { content: "automatic OpenAI transcript" } }] });
  }) as typeof fetch });
  server = createServer({ hostname: "127.0.0.1", port: 0, token: "dictation-browser-test-token", stateDir: join(root, "state"), dictationBaseUrl: baseUrl, dictationFetch, voice, usage: new UsageService(undefined, []) });
  appOrigin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${join(root, "microphone.wav")}`] });

  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 720 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile, permissions: ["microphone"], locale: "en-US" });
    try {
      const initialRequests = requests.length;
      const sent: unknown[] = [];
      const legacy: string[] = [];
      const crossOriginSpeech: string[] = [];
      const auth = await context.request.post(`${appOrigin}/api/auth`, { data: { token: "dictation-browser-test-token" } });
      assert.equal(auth.ok(), true, "browser is authenticated to WebUI");
      const errors: string[] = [];
      await context.addInitScript(({ pane, baseUrl, model }) => {
        if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", alertsOn: false, voiceInput: "on", voiceProvider: "speaches", voiceFinishAndSend: false, terminalInputMode: "line", dictation: { baseUrl, model, activated: true } }));
        localStorage.setItem(`herdr-web-ui:view:${pane}`, "chat");
        const Recorder = window.MediaRecorder;
        window.MediaRecorder = class extends Recorder {
          start(timeslice?: number) {
            if ((window as any).__delayDictationStart) (window as any).__startDictation = () => super.start(timeslice);
            else super.start(timeslice);
          }
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
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/voice")) legacy.push(request.url());
        if (/^https?:$/.test(url.protocol) && url.origin !== appOrigin) crossOriginSpeech.push(request.url());
      });
      let disconnect: (() => void) | undefined;
      // Only transcript and outgoing PTY input are fixtures. CSP, policy, media capture and speech HTTP are real.
      await page.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: { source: "claude-transcript", history_id: "dictation-fixture", turns: [{ role: "assistant", ts: "2026-01-01T00:00:00Z", end_ts: "2026-01-01T00:00:01Z", parts: [{ kind: "text", text: `A fictional reply for dictation comments.\n\n[dictation.txt](${join(root, "dictation.txt")})` }] }] } }));
      await page.routeWebSocket(/^wss?:\/\/[^/]+\/ws(?:\?|$)/, (socket) => {
        const upstream = socket.connectToServer();
        disconnect = () => { socket.close({ code: 1012, reason: "fixture reconnect" }); upstream.close(); };
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
      assert.equal(csp.match(/(?:^|;)\s*connect-src\s+([^;]+)/)?.[1]?.trim(), "'self'", "speech access never expands production connect-src");
      assert.ok(!csp.includes(speechOrigin), "internal speech topology is absent from browser CSP");
      assert.ok(!/connect-src[^;]*(?:\shttps:|\swss:)(?:\s|;)/.test(csp), "no wildcard scheme permission");
      await page.locator(".conn-live").waitFor();
      const composer = page.locator(".composer");
      // Recording and transcription keep the draft in the accessibility tree.
      const message = composer.locator(".composer-text");
      await message.waitFor();
      await composer.locator(".voice-mic").waitFor();
      assert.equal(await composer.locator(".voice-mic").isDisabled(), true, "unconfigured dictation stays visible with a setup reason on both layouts");
      await settings(page);
      await page.getByRole("group", { name: "Microphone button", exact: true }).getByRole("button", { name: "Auto", exact: true }).click();
      await closeSettings(page);
      await composer.locator(".voice-mic").waitFor();
      assert.equal(await composer.locator(".voice-mic").isDisabled(), true, "explicit Speaches keeps Auto visible before setup, including phones");
      await settings(page);
      await page.getByRole("group", { name: "Microphone button", exact: true }).getByRole("button", { name: "Off", exact: true }).click();
      await closeSettings(page);
      assert.equal(await composer.locator(".voice-mic").count(), 0, "Off still hides explicitly selected Speaches");
      await settings(page);
      await page.getByRole("group", { name: "Microphone button", exact: true }).getByRole("button", { name: "On", exact: true }).click();
      assert.equal(await page.getByRole("group", { name: "Transcription mode", exact: true }).count(), 0, "recording-only provider has no mode selector");
      assert.equal(await page.getByRole("button", { name: "Live preview", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Refresh models", exact: true }).isDisabled(), true);
      assert.equal(await page.locator('.settings-dialog input[placeholder="sk-..."]').count(), 0, "self-hosted provider hides the OpenAI key editor");
      assert.equal(await page.locator("#dictation-api-key").count(), 1, "optional backend API key is available");
      assert.equal(await page.locator("#dictation-base-url").isDisabled(), true, "administrator-configured backend URL is read-only");
      await page.getByText("HERDR_WEB_DICTATION_BASE_URL overrides the speech server URL. Change or unset it on the WebUI host, then restart WebUI.", { exact: true }).waitFor();
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
      const applied = await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).dictation);
      assert.deepEqual(applied, { version: 2, model, activated: true, mode: "recording" }, "legacy URL/activation migrate only through explicit Apply");
      if (process.env.UI_EVIDENCE_DIR && !mobile) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "dictation-recording-settings.png") });
      }
      await page.locator("#dictation-model").fill("test/second-model");
      assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).dictation)).model, model, "editing a model does not change applied configuration");
      await page.getByRole("button", { name: "Discard edits", exact: true }).click();
      await page.getByRole("group", { name: "Microphone button", exact: true }).getByRole("button", { name: "Auto", exact: true }).click();
      await closeSettings(page);
      assert.equal(await composer.locator(".voice-mic").isDisabled(), false, "configured Speaches Auto is usable on desktop and phone");
      const beforeAutoCapture = posts().length;
      await composer.locator(".voice-mic").click();
      await composer.locator('.voice-mic-wrap[data-state="recording"]').waitFor();
      await page.keyboard.press("Escape");
      await composer.locator('.voice-mic-wrap[data-state="idle"]').waitFor();
      assert.equal(posts().length, beforeAutoCapture, "cancelling the Auto mobile take uploads nothing");
      await settings(page);
      await page.getByRole("group", { name: "Microphone button", exact: true }).getByRole("button", { name: "On", exact: true }).click();
      await closeSettings(page);

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
        await composer.locator('.voice-mic[aria-label="Dictate (hold)"]').click();
        await composer.getByText("Another input or tab is using dictation", { exact: true }).waitFor();
      }
      await lockPage.evaluate(() => (window as any).__releaseDictationLock());
      await lockPage.close();

      // Delay actual recorder startup after permission, without mocking the capture stream.
      await message.fill("waiting draft");
      await page.evaluate(() => { (window as any).__delayDictationStart = true; });
      await composer.locator(".voice-mic").click();
      await composer.getByText("Starting microphone…", { exact: true }).waitFor();
      await assertInlineComposerStatus(composer);
      assert.equal(await message.inputValue(), "waiting draft", "the visible draft is retained");
      assert.equal(await composer.locator(".voice-bars, .voice-meter, .voice-timer").count(), 0, "no recording indicators before the recorder starts");
      assert.equal(await composer.locator(".voice-mic").getAttribute("aria-pressed"), "true", "startup keeps the upstream active microphone, labelled Cancel dictation");
      assert.equal(await composer.locator(".voice-mic").getAttribute("aria-label"), "Cancel dictation");
      assert.equal(await composer.locator(".voice-done").isDisabled(), true, "startup cannot finish before recording");
      if (process.env.UI_EVIDENCE_DIR) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `dictation-starting-${mobile ? "phone" : "desktop"}.png`) });
      }
      await page.waitForFunction(() => typeof (window as any).__startDictation === "function");
      await page.evaluate(() => { (window as any).__delayDictationStart = false; (window as any).__startDictation(); });
      await composer.locator('.voice-mic-wrap[data-state="recording"]').waitFor();
      await page.waitForFunction(() => (window as any).__dictationBytes > 0);
      await finish(page, composer);
      await until("startup take inserted", async () => await message.inputValue() === "waiting draft spoken words");
      assert.equal(await message.isVisible(), true, "the retained field remains visible after transcription");

      await message.fill("prefix suffix");
      await caret(message, 7);
      await start(page, composer, true);
      const geometries: Array<{ count: number; width: number; gap: number; available: number }> = [];
      for (const width of mobile ? [320, 390] : [768, 1440, 1920]) {
        await page.setViewportSize({ width, height: mobile ? 720 : 900 });
        await frames(page);
        geometries.push(await assertCompactWaveform(composer));
        if (process.env.UI_EVIDENCE_DIR) {
          mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `dictation-waveform-${width}.png`) });
        }
      }
      for (const geometry of geometries) {
        assert.ok(Math.abs(geometry.width - geometries[0]!.width) < 0.5, "bar width stays stable across viewport sizes");
        assert.ok(Math.abs(geometry.gap - geometries[0]!.gap) < 0.5, "bar gap stays stable across viewport sizes");
        assert.equal(geometry.count, 7, "viewport changes never grow the waveform");
        assert.ok(Math.abs(geometry.available - geometries[0]!.available) < 0.5, "waveform width stays compact across viewports");
      }
      await page.setViewportSize({ width: mobile ? 390 : 1280, height: mobile ? 720 : 900 });
      await frames(page);
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

      // All chrome palettes, both themes and densities exercise only this disposable speech fixture.
      async function themeCoverage(): Promise<void> {
        if (mobile) return;
        const original = sanitizeSettings(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!)));
        const savedDraft = await message.inputValue();
        const beforeThemes = sent.length;
        for (const palette of ["amber", "report", "charcoal", "catppuccin", "lilac", "forest"]) {
          for (const theme of ["dark", "light"]) for (const density of ["compact", "comfortable"]) {
            await appearance(page, palette, theme, density);
            await message.fill("theme fixture");
            await caret(message, 13);
            await start(page, composer);
            await assertPillColors(composer);
            await page.emulateMedia({ reducedMotion: "reduce" });
            assert.equal(await message.isVisible(), true, "reduced-motion recording keeps the draft");
            assert.equal(await composer.locator(".voice-bars").isVisible(), false, "reduced-motion replaces animated recording bars");
            assert.equal(await composer.locator(".voice-meter").isVisible(), true, "reduced-motion provides a static input meter");
            await page.emulateMedia({ reducedMotion: "no-preference" });
            hold = true;
            await finish(page, composer);
            await assertTranscribingLoader(composer);
            await assertPillColors(composer);
            await page.emulateMedia({ reducedMotion: "reduce" });
            await assertTranscribingLoader(composer, true);
            await page.emulateMedia({ reducedMotion: "no-preference" });
            await release(page);
            hold = false;
            await until("theme fixture inserted", async () => await message.inputValue() === "theme fixture spoken words");
          }
        }
        await appearance(page, original.palette, original.theme === "light" ? "light" : "dark", original.density);
        await message.fill(savedDraft);
        assert.equal(sent.length, beforeThemes, "theme and loading checks never send");
        console.log("PASS compact recording and stepped loading: six palettes × two themes × two densities, reduced motion");
      }

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
      await themeCoverage();

      // Both recording-time edits and caret-only movement must recover, not overwrite.
      for (const change of ["text", "caret"]) {
        await message.fill("keep this draft");
        await caret(message, 4);
        await start(page, composer);
        // An edit to the visible draft still forces recovery.
        if (change === "text") await message.evaluate((node: HTMLTextAreaElement) => {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, "new visible draft");
          node.dispatchEvent(new Event("input", { bubbles: true }));
        });
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
      await assertTranscribingLoader(composer);
      assert.equal(await message.inputValue(), "visible only", "transcription retains the visible draft");
      assert.equal(await composer.locator(".voice-bars").evaluate((node) => getComputedStyle(node).opacity), "0", "transcribing does not indicate live recording");
      if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `dictation-inline-transcribing-${mobile ? "phone" : "desktop"}.png`) });
      await composer.getByRole("button", { name: "Cancel dictation", exact: true }).click();
      await release(page);
      assert.equal(await message.inputValue(), "visible only", "late cancelled result cannot insert");
      await start(page, composer);
      await finish(page, composer);
      assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true, "Send cannot submit while transcription owns the visible draft");
      await composer.getByRole("button", { name: "Cancel dictation", exact: true }).click();
      await message.waitFor({ state: "visible" });
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

      async function defaultSendDisabled(surface: Locator, field: Locator): Promise<void> {
        await field.fill("review first");
        const before = sent.length;
        await start(page, surface);
        assert.equal(await surface.locator(".composer-send, .terminal-input-send").isDisabled(), true, "default recording Send is disabled");
        await finish(page, surface);
        await until("default take inserted without Send", async () => await field.inputValue() === "review first spoken words");
        assert.equal(sent.length, before, "default Finish only creates a draft");
      }
      await defaultSendDisabled(composer, message);

      // Both gestures finish on release only after a held press; quick taps keep recording.
      for (const gesture of ["pointer", "shortcut"]) {
        await message.fill("held draft");
        await caret(message, 10);
        const before = posts().length;
        if (gesture === "pointer") {
          const bounds = (await composer.locator(".voice-mic").boundingBox())!;
          await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
          await page.mouse.down();
        } else {
          await page.keyboard.down("ControlOrMeta");
          await page.keyboard.down("Shift");
          await page.keyboard.down("Space");
        }
        const pressedAt = Date.now();
        await composer.locator('.voice-mic-wrap[data-state="recording"]').waitFor();
        await page.waitForFunction(() => (window as any).__dictationBytes > 0);
        await until("held gesture threshold", () => Date.now() - pressedAt >= 300);
        assert.equal(posts().length, before, "holding never uploads before release");
        if (gesture === "pointer") await page.mouse.up();
        else {
          await page.keyboard.up("Space");
          await page.keyboard.up("Shift");
          await page.keyboard.up("ControlOrMeta");
        }
        await until("held release finishes exactly once", () => posts().length === before + 1);
        await until("held draft insertion", async () => await message.inputValue() === "held draft spoken words");
      }
      await message.fill("shortcut tap");
      await caret(message, 12);
      await page.keyboard.press("ControlOrMeta+Shift+Space");
      await composer.locator('.voice-mic-wrap[data-state="recording"]').waitFor();
      await page.waitForFunction(() => (window as any).__dictationBytes > 0);
      const beforeTapFinish = posts().length;
      await page.keyboard.press("ControlOrMeta+Shift+Space");
      await until("second shortcut tap finishes", () => posts().length === beforeTapFinish + 1);
      await until("shortcut tap draft insertion", async () => await message.inputValue() === "shortcut tap spoken words");

      // IME owns candidate keys, but plain Escape discards and plain Enter finishes, never sends.
      for (const enabled of [false, true]) {
        await finishAndSendPreference(page, enabled);
        await message.fill("keyboard draft");
        await caret(message, 14);
        const before = sent.length;
        await start(page, composer);
        const beforeCancel = posts().length;
        await message.evaluate((node) => {
          for (const key of ["Enter", "Escape"]) for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
            const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...ime });
            node.dispatchEvent(event);
            if (event.defaultPrevented) throw new Error("IME candidate key was consumed by dictation");
          }
        });
        assert.equal(await composer.locator('.voice-mic-wrap[data-state="recording"]').count(), 1, "IME Enter/Escape leave capture active");
        assert.equal(posts().length, beforeCancel, "IME keys never finish capture");
        await message.press("Escape");
        await composer.locator('.voice-mic-wrap[data-state="idle"]').waitFor();
        assert.equal(posts().length, beforeCancel, "Escape discards without upload");
        assert.equal(await message.inputValue(), "keyboard draft");
        // Start outside the composer: Locator.press("Enter") would focus it and hide the regression.
        await page.getByRole("button", { name: "Comment on reply", exact: true }).focus();
        assert.equal(await message.evaluate((node) => document.activeElement === node), false);
        await page.evaluate(() => { (window as any).__dictationBytes = 0; });
        await page.keyboard.press("ControlOrMeta+Shift+Space");
        await composer.locator('.voice-mic-wrap[data-state="recording"]').waitFor();
        await page.waitForFunction(() => (window as any).__dictationBytes > 0);
        await page.keyboard.press("Enter");
        assert.equal(await message.evaluate((node) => document.activeElement === node), true, "keyboard finish immediately focuses the chat draft");
        await until("Enter only finishes", async () => await message.inputValue() === "keyboard draft spoken words");
        assert.equal(sent.length, before, `Enter never sends with Finish and send ${enabled}`);
        assert.equal(await message.evaluate((node) => document.activeElement === node), true, "inserted draft keeps keyboard focus");
        await page.keyboard.press("Enter");
        await until("second Enter sends the reviewed draft", async () => sent.length === before + 1 && await message.inputValue() === "");
        assert.equal((sent.at(-1) as { text: string }).text, "keyboard draft spoken words");
        await frames(page);
        assert.equal(sent.length, before + 1, "second Enter sends exactly once");
      }
      await finishAndSendPreference(page, false);

      // Delayed insertion must neither undo a deliberate focus change nor raise the pointer user's keyboard.
      for (const gesture of ["keyboard", "pointer"]) {
        await message.fill("focus draft");
        await caret(message, 11);
        const outside = page.getByRole("button", { name: "Comment on reply", exact: true });
        await outside.focus();
        const before = sent.length;
        hold = true;
        await start(page, composer);
        if (gesture === "keyboard") {
          await page.keyboard.press("Enter");
          assert.equal(await message.evaluate((node) => document.activeElement === node), true);
          await outside.focus();
        } else {
          await finish(page, composer);
          assert.equal(await message.evaluate((node) => document.activeElement === node), false, "pointer finish does not focus the chat draft");
        }
        await until("held focus-test inference", () => pending.length === 1);
        await release(page);
        hold = false;
        await until("delayed draft insertion", async () => await message.inputValue() === "focus draft spoken words");
        assert.equal(await message.evaluate((node) => document.activeElement === node), false, "transcription arrival never steals focus");
        if (gesture === "keyboard") assert.equal(await outside.evaluate((node) => document.activeElement === node), true, "deliberate focus change survives insertion");
        assert.equal(sent.length, before, "delayed insertion never sends");
      }
      console.log(`PASS ${mobile ? "phone" : "desktop"}: keyboard finish focus, second Enter sends once, delayed/pointer insertion preserves focus`);

      // Opt-in Send owns exactly one continuation, with the latest committed text (including an empty initial draft).
      async function directSend(surface: Locator, field: Locator): Promise<void> {
        for (const initial of ["", "prefix"]) {
          await field.fill(initial);
          await caret(field, initial.length);
          await start(page, surface);
          const before = sent.length;
          const send = surface.locator(".composer-send, .terminal-input-send");
          assert.equal(await send.isDisabled(), false, "recording Send is enabled even for an empty draft");
          // Synchronous repeated clicks exercise the intent claim before a React rerender.
          await send.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
          await until("direct dictation Send acknowledged", async () => sent.length === before + 1 && await field.inputValue() === "");
          assert.equal((sent.at(-1) as { text: string }).text, initial ? `${initial} ${transcript}` : transcript, "Send sees the committed final draft, not its stale closure");
          await frames(page);
          assert.equal(sent.length, before + 1, "a take sends exactly once");
        }
      }
      async function rejectedSend(surface: Locator, field: Locator): Promise<void> {
        for (const reason of ["cancel", "escape", "edit", "caret", "ime", "empty", "error", "offline", "disconnect", "pagehide", "settings"]) {
          const initial = reason === "empty" || reason === "error" ? "" : "retained draft";
          await field.fill(initial);
          await caret(field, initial.length);
          hold = true;
          speechResult = reason === "empty" || reason === "error" ? reason : "ok";
          await start(page, surface);
          const before = sent.length;
          await surface.locator(".composer-send, .terminal-input-send").click();
          await until("held direct Send inference", () => pending.length === 1);
          assert.equal(await surface.locator(".composer-send, .terminal-input-send").isDisabled(), true, "transcribing cannot create another Send intent");
          if (reason === "cancel") await surface.getByRole("button", { name: "Cancel dictation", exact: true }).click();
          if (reason === "escape") {
            await surface.getByRole("button", { name: "Cancel dictation", exact: true }).focus();
            await page.keyboard.press("Escape");
          }
          if (reason === "disconnect") {
            disconnect!();
            await page.locator(".conn-live").waitFor({ state: "detached" });
            await page.locator(".conn-live").waitFor();
          }
          if (reason === "edit") await field.evaluate((node: HTMLTextAreaElement) => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(node, "edited draft");
            node.dispatchEvent(new Event("input", { bubbles: true }));
          });
          if (reason === "caret") await caret(field, 0);
          if (reason === "ime") await field.dispatchEvent("compositionstart", { data: "" });
          if (reason === "offline" || reason === "pagehide") await page.evaluate((name) => window.dispatchEvent(new Event(name)), reason);
          if (reason === "settings") {
            await settings(page);
            const modelField = page.locator("#dictation-model");
            await modelField.fill(await modelField.inputValue() === model ? "test/second-model" : model);
            await page.getByRole("button", { name: "Apply", exact: true }).click();
            await closeSettings(page);
          }
          await release(page);
          hold = false;
          speechResult = "ok";
          await surface.locator('.voice-mic-wrap[data-state="idle"]').waitFor();
          if (reason === "ime") await field.dispatchEvent("compositionend", { data: "" });
          const recovery = surface.getByRole("button", { name: "Insert at cursor", exact: true });
          if (await recovery.count()) {
            await caret(field, 0);
            await recovery.click();
            await frames(page);
          }
          assert.equal(sent.length, before, `${reason} and subsequent draft recovery never send (not even bare Enter)`);
        }
      }
      await withFinishAndSend(page, async () => {
        await directSend(composer, message);
        await rejectedSend(composer, message);
      });

      await finishAndSendPreference(page, true);
      const beforeOverflow = sent.length;
      await message.fill("x".repeat(Number(await message.getAttribute("maxlength")) - 5));
      await start(page, composer);
      await composer.locator(".composer-send").click();
      await composer.getByRole("button", { name: "Insert at cursor", exact: true }).waitFor();
      assert.equal(sent.length, beforeOverflow, "the final dictation cannot bypass the outgoing size limit");
      await composer.getByRole("button", { name: "Discard", exact: true }).click();
      await message.fill("");
      await finishAndSendPreference(page, false);

      // Dictation must not force a second input surface in direct terminal mode.
      await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await openSettingsPage(page, "Terminal");
      await page.locator("#terminal-input-mode").selectOption("direct");
      await closeSettings(page);
      // Terminal line is also a draft: speech must never emit terminal input or Enter.
      await page.locator('.view-switch button[title^="Live terminal"]').click();
      const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
      assert.equal(await line.count(), 0, "direct terminal typing shows no extra dictation input");
      await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await openSettingsPage(page, "Terminal");
      await page.locator("#terminal-input-mode").selectOption("line");
      await closeSettings(page);
      await line.fill("echo ");
      await caret(line, 5);
      const terminal = page.locator(".terminal-input");
      const beforeTerminal = sent.length;
      await start(page, terminal);
      // This default shared control also serves comment forms on the integration
      // branch. Exercise narrow form widths without the composer's CSS or props.
      const originalStyle = await terminal.getAttribute("style");
      const sharedGeometries: Array<{ count: number; width: number; gap: number; available: number }> = [];
      for (const width of mobile ? [240, 320] : [240, 320, 600]) {
        await terminal.evaluate((element, width) => { element.style.width = `${width}px`; }, width);
        await frames(page);
        const geometry = await assertCompactWaveform(terminal);
        await assertInlineComposerStatus(terminal);
        sharedGeometries.push(geometry);
        assert.equal(geometry.count, 7, "shared upstream waveform is compact without a composer-only opt-in");
      }
      assert.equal(sharedGeometries.at(-1)!.available, sharedGeometries[0]!.available, "shared waveform never grows with the form");
      await terminal.evaluate((element, style) => {
        if (style === null) element.removeAttribute("style"); else element.setAttribute("style", style);
      }, originalStyle);
      await frames(page);
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
      await defaultSendDisabled(terminal, line);
      await withFinishAndSend(page, async () => {
        await directSend(terminal, line);
        await rejectedSend(terminal, line);
      });
      await page.locator('.view-switch button[title^="Chat"]').click();
      await message.waitFor();

      // Reply and file comments reuse the chat card's mic and compact pill, but only add drafts.
      const beforeComments = sent.length;
      await message.fill("existing draft");
      await page.getByRole("button", { name: "Comment on reply", exact: true }).click();
      const comment = page.getByRole("group", { name: "Comment draft", exact: true });
      const commentText = comment.getByRole("textbox", { name: "Comment draft", exact: true });
      await commentText.fill("reply comment");
      await caret(commentText, 13);
      await start(page, comment);
      assert.equal(await comment.getByRole("button", { name: "Add to message", exact: true }).isDisabled(), true, "a recording cannot add a comment or send");
      await commentText.press("Enter");
      await until("comment dictation inserted", async () => await commentText.inputValue() === "reply comment spoken words");
      await comment.getByRole("button", { name: "Undo last dictation", exact: true }).click();
      assert.equal(await commentText.inputValue(), "reply comment", "comment dictation shares chat's one-step undo");
      await start(page, comment);
      await commentText.fill("edited comment");
      await finish(page, comment);
      await comment.getByRole("button", { name: "Insert at cursor", exact: true }).waitFor();
      assert.equal(await comment.getByRole("button", { name: "Add to message", exact: true }).isDisabled(), true, "edited comments require explicit recovery before adding");
      await caret(commentText, 14);
      await comment.getByRole("button", { name: "Insert at cursor", exact: true }).click();
      await until("comment recovery inserted", async () => await commentText.inputValue() === "edited comment spoken words");
      await comment.getByRole("button", { name: "Add to message", exact: true }).click();
      await until("reply comment added to existing draft", async () => (await message.inputValue()).startsWith("existing draft\n\nReply:"));
      assert.ok((await message.inputValue()).includes("A fictional reply for dictation comments."));
      assert.ok((await message.inputValue()).endsWith("edited comment spoken words"));
      assert.equal(sent.length, beforeComments, "adding reply dictation never sends");

      await page.getByRole("button", { name: "Comment on reply", exact: true }).click();
      await commentText.fill("cancelled comment");
      const beforeCommentCancel = posts().length;
      await start(page, comment);
      await commentText.press("Escape");
      await comment.locator('.voice-mic-wrap[data-state="idle"]').waitFor();
      assert.equal(await commentText.inputValue(), "cancelled comment");
      assert.equal(posts().length, beforeCommentCancel, "Escape cancels speech without uploading or closing the comment editor");
      await commentText.focus();
      await page.keyboard.press("ControlOrMeta+Shift+Space");
      await comment.locator('.voice-mic-wrap[data-state="recording"]').waitFor();
      assert.equal(await composer.locator('.voice-mic-wrap[data-state="idle"]').count(), 1, "the comment owns its shortcut instead of the chat draft behind it");
      disconnect!();
      await comment.locator('.voice-mic-wrap[data-state="idle"]').waitFor();
      await until("comment connection restored", async () => !await comment.locator(".voice-mic").isDisabled());
      assert.equal(await commentText.inputValue(), "cancelled comment");
      assert.equal(posts().length, beforeCommentCancel, "disconnect cancels comment capture without automatic retry on reconnect");
      await commentText.press("Escape");
      await comment.waitFor({ state: "hidden" });

      await page.locator(".chat-turn-agent .markdown-file").first().click();
      const viewer = page.getByRole("dialog", { name: "dictation.txt", exact: true });
      await viewer.locator(".file-viewer-body").getByText("A fictional file line for a draft comment.", { exact: false }).first().waitFor();
      await viewer.locator(".file-viewer-body").evaluate((body) => {
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (node.textContent?.includes("A fictional file line")) {
            const range = document.createRange(); range.selectNodeContents(node);
            const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); return;
          }
        }
        throw new Error("Fixture file text was not found");
      });
      await viewer.getByRole("button", { name: "Comment on file", exact: true }).click();
      const fileComment = viewer.getByRole("group", { name: "Comment draft", exact: true });
      const fileCommentText = fileComment.getByRole("textbox", { name: "Comment draft", exact: true });
      await fileCommentText.fill("file comment");
      await caret(fileCommentText, 12);
      await start(page, fileComment);
      await finish(page, fileComment);
      await until("file comment dictation inserted", async () => await fileCommentText.inputValue() === "file comment spoken words");
      await fileComment.getByRole("button", { name: "Add to message", exact: true }).click();
      assert.equal(sent.length, beforeComments, "adding file dictation never sends");
      await viewer.getByRole("button", { name: "Comment on file", exact: true }).click();
      await fileCommentText.fill("unchanged comment");
      const draftBeforeClosing = await message.inputValue();
      hold = true;
      await start(page, fileComment);
      await finish(page, fileComment);
      await fileComment.locator('.voice-mic-wrap[data-state="transcribing"]').waitFor();
      await fileComment.getByRole("button", { name: "Cancel", exact: true }).click();
      await release(page);
      hold = false;
      assert.equal(await message.inputValue(), draftBeforeClosing, "closing a comment discards a late transcription");
      await viewer.getByRole("button", { name: "Close file", exact: true }).click();
      const commentDraft = await message.inputValue();
      assert.ok(commentDraft.includes(`File: ${join(root, "dictation.txt")}`));
      assert.ok(commentDraft.includes("> A fictional file line"), "file comments snapshot the selected source text");
      assert.ok(commentDraft.endsWith("file comment spoken words"));
      assert.equal(sent.length, beforeComments, "all comment capture, recovery and adding remain draft-only");
      console.log(`PASS ${mobile ? "phone" : "desktop"}: reply/file comment STT, chat-box styling, recovery, undo and zero sends`);

      await settings(page);
      await page.getByRole("button", { name: "Off", exact: true }).click();
      await closeSettings(page);
      assert.equal(await composer.locator(".voice-mic").count(), 0, "Off remains explicit and hides capture");
      await page.reload();
      await page.locator(".conn-live").waitFor();
      assert.equal(await composer.locator(".voice-mic").count(), 0, "Off survives reload");
      assert.deepEqual(legacy, [], "self-hosted provider never requests /api/voice");
      assert.deepEqual(errors, []);
      assert.deepEqual(crossOriginSpeech, [], "browser makes zero direct speech-service requests");
      console.log(`PASS ${mobile ? "phone" : "desktop"}: backend HTTPS dictation, same-origin CSP, explicit settings, draft recovery, cancellation, IME and terminal`);
    } finally { while (pending.length) pending.shift()!(); hold = false; await context.close(); }
  }
  // Automatic selection preserves keyless browser recognition, prefers a supported
  // configured OpenAI route, and never retries a failed take with browser recognition.
  const autoContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"], locale: "en-US" });
  try {
    assert.equal((await autoContext.request.post(`${appOrigin}/api/auth`, { data: { token: "dictation-browser-test-token" } })).ok(), true);
    await autoContext.addInitScript(({ pane }) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceInput: "on", voicePolishChat: false }));
      localStorage.setItem(`herdr-web-ui:view:${pane}`, "chat");
      (window as any).__recognitionStarts = 0;
      class Recognition {
        lang = ""; continuous = false; interimResults = false;
        onaudiostart: (() => void) | null = null;
        onresult: ((event: any) => void) | null = null;
        onend: (() => void) | null = null;
        onerror: ((event: any) => void) | null = null;
        start() { (window as any).__recognitionStarts++; this.onaudiostart?.(); }
        stop() { this.onresult?.({ results: { length: 1, 0: { isFinal: true, 0: { transcript: "automatic browser transcript" } } } }); this.onend?.(); }
        abort() {}
      }
      (window as any).SpeechRecognition = Recognition;
      (window as any).webkitSpeechRecognition = Recognition;
      const Recorder = window.MediaRecorder;
      window.MediaRecorder = class extends Recorder {
        constructor(stream: MediaStream, options?: MediaRecorderOptions) {
          super(stream, options); (window as any).__dictationBytes = 0;
          this.addEventListener("dataavailable", (event) => { (window as any).__dictationBytes += event.data.size; });
        }
      };
    }, { pane });
    // Browser recognition must remain usable when the unrelated Speaches policy cannot load.
    await autoContext.route("**/api/dictation/config", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "not_configured", message: "Fixture policy failure" } }) }));
    const page = await autoContext.newPage(); page.setDefaultTimeout(15_000);
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${appOrigin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const composer = page.locator(".composer"), message = composer.locator("textarea");
    await until("Auto keyless browser route", async () => !await composer.locator(".voice-mic").isDisabled());
    await message.fill("");
    await composer.locator(".voice-mic").click();
    await composer.locator('.voice-mic-wrap[data-state="recording"]').waitFor();
    await message.press("Enter");
    await until("automatic browser transcript", async () => await message.inputValue() === "automatic browser transcript");
    assert.equal(await page.evaluate(() => (window as any).__recognitionStarts), 1);
    assert.equal(openAiCalls.length, 0, "Auto without a key never calls OpenAI");
    await autoContext.unroute("**/api/dictation/config");
    assert.equal((await autoContext.request.put(`${appOrigin}/api/voice/config`, { headers: { origin: appOrigin }, data: { api_key: "fixture-openai-key" } })).status(), 200);
    await page.reload(); await page.locator(".conn-live").waitFor();
    await until("Auto configured OpenAI route", async () => !await composer.locator(".voice-mic").isDisabled());
    await message.fill("");
    await start(page, composer);
    await composer.locator(".voice-done").click();
    await until("automatic OpenAI transcript", async () => await message.inputValue() === "automatic OpenAI transcript");
    assert.equal(await page.evaluate(() => (window as any).__recognitionStarts), 0, "configured Auto does not start browser recognition");
    assert.equal(openAiCalls.length, 1);
    failOpenAI = true;
    await message.fill("unchanged draft");
    await start(page, composer);
    await composer.locator(".voice-done").click();
    await composer.locator('.voice-mic-wrap[data-state="idle"]').waitFor();
    await until("Auto failure reported", async () => (await composer.innerText()).includes("Transcription failed"));
    assert.equal(await message.inputValue(), "unchanged draft");
    assert.equal(await page.evaluate(() => (window as any).__recognitionStarts), 0, "failed OpenAI take never falls back to browser recognition");
    assert.equal(openAiCalls.length, 2); assert.deepEqual(errors, []);
    console.log("PASS Auto selects browser without a key even when policy loading fails, configured OpenAI when supported, and no error fallback");
  } finally { failOpenAI = false; await autoContext.close(); }
  // Missing administrator configuration stays disabled even with current activated browser settings.
  const disabled = createServer({ hostname: "127.0.0.1", port: 0, token: "dictation-disabled-test-token", stateDir: join(root, "disabled-state"), dictationBaseUrl: "", usage: new UsageService(undefined, []) });
  const disabledContext = await browser.newContext({ locale: "en-US" });
  try {
    const origin = `http://127.0.0.1:${disabled.port}`;
    assert.equal((await disabledContext.request.post(`${origin}/api/auth`, { data: { token: "dictation-disabled-test-token" } })).ok(), true);
    await disabledContext.addInitScript(({ model }) => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceInput: "on", voiceProvider: "speaches", dictation: { version: 2, model, activated: true, mode: "recording" } })), { model });
    const page = await disabledContext.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    const beforeDisabled = requests.length;
    await settings(page);
    await page.getByText("Managed by the WebUI backend", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Refresh models", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Check", exact: true }).count(), 0, "one explicit discovery action, no duplicate Check");
    assert.equal(await page.locator("#dictation-base-url").isDisabled(), true, "explicit backend option locks the URL");
    assert.equal(requests.length, beforeDisabled, "missing backend URL never contacts a speech service");
  } finally { await disabledContext.close(); disabled.stop(); }
  // User-configured backend: saving is private, persistent and requires fresh Apply consent.
  const configurable = createServer({ hostname: "127.0.0.1", port: 0, token: "dictation-settings-test-token", stateDir: join(root, "configurable-state"), dictationFetch, usage: new UsageService(undefined, []) });
  const configContext = await browser.newContext({ locale: "en-US" });
  try {
    const origin = `http://127.0.0.1:${configurable.port}`;
    assert.equal((await configContext.request.post(`${origin}/api/auth`, { data: { token: "dictation-settings-test-token" } })).ok(), true);
    await configContext.addInitScript(({ model }) => { if (!localStorage.getItem("herdr-web-ui:settings")) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceProvider: "speaches", dictation: { version: 2, model, activated: true, mode: "live" } })); }, { model });
    const page = await configContext.newPage();
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(".conn-live").waitFor();
    await settings(page);
    const field = page.locator("#dictation-base-url");
    await until("editable backend URL", () => field.isEnabled());
    const migrated = sanitizeSettings(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!))).dictation;
    assert.equal(migrated.mode, "recording", "legacy live configuration becomes recording-only");
    assert.equal(migrated.activated, false, "legacy live configuration requires fresh Apply");
    assert.equal(await page.getByRole("button", { name: "Live preview", exact: true }).count(), 0);
    const beforeSave = requests.length;
    // Simulate a backend restart adding an override after editable metadata reached the page.
    // Only the config rejection is fulfilled; speech traffic remains the real HTTPS fixture.
    await page.route("**/api/dictation/config", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await route.fulfill({ status: 409, json: { error: { code: "config_locked", message: "Dictation configuration is set by the environment" } } });
    });
    await field.fill(baseUrl);
    await page.locator("#dictation-api-key").fill("rejected-fixture-secret");
    await page.getByRole("button", { name: "Save speech server", exact: true }).click();
    const lockAlert = page.getByRole("alert").filter({ hasText: "The environment overrides dictation settings." });
    await lockAlert.waitFor();
    assert.equal(await lockAlert.innerText(), "The environment overrides dictation settings. Change or unset HERDR_WEB_DICTATION_BASE_URL and/or HERDR_WEB_DICTATION_API_KEY on the WebUI host, then restart WebUI.");
    assert.equal(await page.locator("#dictation-api-key").inputValue(), "", "rejected save still clears the secret");
    assert.ok(!(await page.locator(".settings-dialog").innerText()).includes("rejected-fixture-secret"));
    assert.equal(requests.length, beforeSave, "environment lock never contacts Speaches");
    await page.unroute("**/api/dictation/config");
    await field.fill("ftp://invalid.example/v1");
    await page.getByRole("button", { name: "Save speech server", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Could not save the speech backend configuration" }).waitFor();
    assert.equal((await configContext.request.get(`${origin}/api/dictation/config`)).ok(), true);
    await field.fill(baseUrl);
    await page.getByRole("button", { name: "Save speech server", exact: true }).click();
    await until("backend URL saved", () => page.getByRole("button", { name: "Save speech server", exact: true }).isDisabled());
    assert.equal(requests.length, beforeSave, "saving URL never contacts Speaches");
    assert.equal(await page.getByRole("button", { name: "Refresh models", exact: true }).isDisabled(), true, "save requires fresh Apply consent");
    await page.locator("#dictation-api-key").fill("dictation-fixture-key");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    assert.equal(await page.locator("#dictation-api-key").inputValue(), "", "key clears immediately on save");
    await until("key saved", async () => (await (await configContext.request.get(`${origin}/api/dictation/config`)).json()).api_key_configured === true);
    assert.ok(!(await (await configContext.request.get(`${origin}/api/dictation/config`)).text()).includes("dictation-fixture-key"), "config never echoes the key");
    await page.locator("#dictation-recognition-language").selectOption("ja");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await until("saved backend available without reload", () => page.getByRole("button", { name: "Refresh models", exact: true }).isEnabled());
    await page.getByRole("button", { name: "Refresh models", exact: true }).click();
    await page.locator(".dictation-settings-status").filter({ hasText: "Service reachable. Applied model listed as installed; inference not verified." }).waitFor();
    assert.equal(requests.at(-1)?.authorization, "Bearer dictation-fixture-key", "backend discovery uses only the saved key");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await field.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "dictation-backend-settings.png") });
    }
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await settings(page);
    await until("saved URL restored on reload", async () => await field.inputValue() === baseUrl);
    assert.equal(await page.locator("#dictation-recognition-language").inputValue(), "ja", "recognition language survives reload");
    assert.equal(await page.locator("#dictation-api-key").inputValue(), "", "saved key is never loaded into the input");
    await page.getByRole("button", { name: "Remove key", exact: true }).click();
    await until("key removed", async () => (await (await configContext.request.get(`${origin}/api/dictation/config`)).json()).api_key_configured === false);
    await field.fill("");
    await page.getByRole("button", { name: "Save speech server", exact: true }).click();
    await until("backend disabled", async () => (await (await configContext.request.get(`${origin}/api/dictation/config`)).json()).enabled === false);
    await until("disabled policy reaches Settings", () => page.getByRole("button", { name: "Apply", exact: true }).isDisabled());
  } finally { await configContext.close(); configurable.stop(); }
  for (const request of requests.filter((item) => item.path.endsWith("audio/transcriptions") || item.path.endsWith("models"))) {
    assert.ok(request.authorization === null || request.authorization === "Bearer dictation-fixture-key", "upstream receives no unrelated credentials");
    assert.equal(request.cookie, null);
    assert.equal(request.referer, null, "discovery and audio both suppress Referer");
    assert.equal(request.origin, null, "backend does not forward browser Origin");
    assert.ok(request.method === "GET" || request.method === "POST");
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
