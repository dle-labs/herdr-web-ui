/** Fictional native Grok records -> real server -> existing React chat and output cache. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

if (process.platform !== "linux") { console.log("SKIP Grok process binding is Linux-only"); process.exit(0); }
const root = mkdtempSync(join(tmpdir(), "herdr-grok-browser-"));
const session = "00000000-0000-4000-8000-000000000021";
const dir = join(root, "sessions", "fiction", session);
mkdirSync(dir, { recursive: true });
const path = join(dir, "updates.jsonl");
const events = join(dir, "events.jsonl");
writeFileSync(events, "");
const event = (update: object, extension = false) => JSON.stringify({ timestamp: 1700000000, method: extension ? "_x.ai/session/update" : "session/update", params: { sessionId: session, update } }) + "\n";
const user = (text: string) => event({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { promptIndex: 0, modelId: "fictional-model" } });
const output = (text: string) => event({ sessionUpdate: "tool_call_update", toolCallId: "fictional-call", content: [{ type: "content", content: { type: "text", text } }], status: "completed" });
writeFileSync(path, user("Show a fictional Grok conversation.") + event({ sessionUpdate: "tool_call", toolCallId: "fictional-call", _meta: { "x.ai/tool": { name: "read_file" } }, title: "Read fictional file", rawInput: { path: "fiction.txt" } }) + output("FIRST ".repeat(900) + "FIRST_END") + event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fictional Grok answer." } }));
const executable = join(root, "grok");
copyFileSync("/bin/sleep", join(root, "grok-1.0.50-linux-x86_64")); symlinkSync("grok-1.0.50-linux-x86_64", executable); chmodSync(executable, 0o755);
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-grok-browser" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${executable} 600 3<${events}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent === "grok") break;
    if (Date.now() > deadline) throw new Error("fictional Grok process did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent_session", { pane_id: pane, source: "herdr:grok", agent: "grok", agent_session_id: session, session_start_source: "new", seq: 1 });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), grokHome: root, tailscaleOwner: null });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => localStorage.setItem(`herdr-web-ui:view:${id}`, "chat"), pane);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const log = page.getByRole("log", { name: `conversation of ${pane}` });
  await log.getByText("Fictional Grok answer.", { exact: true }).waitFor();
  const head = log.locator(".work-block-head");
  if (await head.getAttribute("aria-expanded") !== "true") await head.click();
  await log.locator(".work-row-head").click();
  await log.locator(".chat-tool-more").click();
  await log.getByText(/FIRST_END/).waitFor();
  appendFileSync(path, output("UPDATED ".repeat(900) + "UPDATED_END"));
  await log.locator(".chat-tool-more").waitFor();
  assert.equal(await log.getByText(/FIRST_END/).count(), 0, "a changed ref must clear React's retained whole output");
  await log.locator(".chat-tool-more").click();
  await log.getByText(/UPDATED_END/).waitFor();
  appendFileSync(path, output("short replacement"));
  await log.getByText("short replacement", { exact: true }).waitFor();
  assert.equal(await log.locator(".chat-tool-more").count(), 0);
  assert.equal(await log.getByText(/UPDATED_END/).count(), 0);
  appendFileSync(path, event({ sessionUpdate: "rewind_marker", target_prompt_index: 0 }, true) + user("Replacement after rewind."));
  await log.getByText("Replacement after rewind.", { exact: true }).waitFor();
  assert.equal(await log.getByText("Fictional Grok answer.", { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS Grok native chat, expanded-output refresh, shrink and rewind in the real browser");
} finally {
  // Attempt every cleanup even if an earlier one fails. A cleanup error never replaces
  // the original failure; it is reported and fails a run that otherwise passed.
  const cleanupErrors: unknown[] = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  try { server?.stop(); } catch (error) { cleanupErrors.push(error); }
  try { if (workspace) await workspaceClose(workspace); } catch (error) { cleanupErrors.push(error); }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    console.error(new AggregateError(cleanupErrors, "Grok chat browser QA cleanup failed"));
    process.exitCode = 1;
  }
}
