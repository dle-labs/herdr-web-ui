/**
 * The repository diff viewer (Files → Changes → RepoDiffViewer) in the built app, against real git
 * repositories answered by the server's own repo-diff module: the changed files of the working
 * tree, the index and two commits with their statuses; a 10 000-line diff as a bounded window of
 * rows, unified and split, at the top, the middle and the end; the layout setting kept across a
 * reload and declined on a phone; the context folded and shown again with the line numbers kept;
 * native selection and a real copy that keep blank lines and leave the gutters out; binary,
 * too-large, conflicted, deleted, untracked and renamed files and their notes; a folder that is no
 * repository and a commit that does not exist; the file itself opened on the owning PC; Escape,
 * Back and Close with the focus returned; a remote PC's routes; the rows in the app's palette; and
 * the static demo's fixture.
 *
 * The browser is Playwright's headless shell, whose clipboard is its own: a real Cmd+C here never
 * touches the clipboard of the PC running the check.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { build as viteBuild } from "vite";
import { repoDiffResponse } from "../server/repo-diff.ts";
import { paneFileSearch } from "../server/files.ts";
import { listDirectories } from "../server/directories.ts";
import { VOICE_DEFAULTS } from "../shared/voice.ts";
import { serveStatic } from "../server/static.ts";
import { buildDemoApp } from "./demo-build.ts";
import { runMoreItem } from "./header-more.ts";

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

declare global { interface Window { reviewQA: { frames: Array<{ type: string; agent_only?: boolean; text?: string; delivery?: string }>; hold: boolean; refuse: boolean; releases: Array<() => void> } } }

const BIG_LINES = 10_000;
/** Rewritten whole, its patch passes the server's 1 MiB cap; the 10 000-line diff stays under it. */
const LARGE_LINES = 8_000;
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-repo-diff-")));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
/** Numbered TypeScript lines, a blank one every tenth; `changed` rewrites every fourth line's comment. */
function numbered(lines: number, changed: boolean): string {
  const out: string[] = [];
  for (let line = 1; line <= lines; line++) {
    if (line % 10 === 0) out.push("");
    else out.push(`export const line_${String(line).padStart(5, "0")} = ${line}; // ${changed && line % 4 === 0 ? "changed" : "numbered"} line ${line}`);
  }
  return `${out.join("\n")}\n`;
}
const MONEY_OLD = ["export type Cents = number;", "", "export function toCents(amount: number): Cents {", "  return amount * 100;", "}", "", "export function fromCents(cents: Cents): number {", "  return cents / 100;", "}", "", "export function add(a: Cents, b: Cents): Cents {", "  return a + b;", "}", "", "export function format(cents: Cents): string {", "  return (cents / 100).toFixed(2);", "}", ""].join("\n");
const MONEY_NEW = MONEY_OLD
  .replace("  return amount * 100;", "  const scaled = Math.abs(amount) * 100;\n  return Math.sign(amount) * Math.round(scaled);")
  .replace("  return (cents / 100).toFixed(2);", "  return `$${(cents / 100).toFixed(2)}`;");

/** Two real repositories and a plain folder, as the panes of the fixture would sit in them. */
function fixtures(): { main: string; detached: string; plain: string } {
  const main = join(root, "repo");
  mkdirSync(join(main, "src"), { recursive: true });
  mkdirSync(join(main, "docs"));
  mkdirSync(join(main, "assets"));
  mkdirSync(join(main, "notes", "dir with space"), { recursive: true });
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "src/big.ts"), numbered(BIG_LINES, false));
  writeFileSync(join(main, "src/money.ts"), MONEY_OLD.replace("export function add", "export function sum"));
  writeFileSync(join(main, "src/gone.ts"), "export const gone = true;\n\nexport const twice = 2;\n");
  writeFileSync(join(main, "src/staged.ts"), "export const staged = 1;\n");
  writeFileSync(join(main, "src/large.txt"), `${"x".repeat(80)}\n`.repeat(LARGE_LINES));
  writeFileSync(join(main, "docs/old-name.md"), "# Notes\n\nthe first paragraph\n\nthe second paragraph\n");
  writeFileSync(join(main, "assets/pic.bin"), new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]));
  writeFileSync(join(main, "notes/dir with space/ünï 文件.txt"), "eins\nzwei\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "first");
  writeFileSync(join(main, "src/money.ts"), MONEY_OLD);
  writeFileSync(join(main, "CHANGELOG.md"), "# Changelog\n\n- money: add\n");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "second");
  // staged: a rename with an edit, and an edit that is edited again below
  git(main, "mv", "docs/old-name.md", "docs/new-name.md");
  writeFileSync(join(main, "docs/new-name.md"), "# Notes\n\nthe first paragraph, revised\n\nthe second paragraph\n");
  writeFileSync(join(main, "src/staged.ts"), "export const staged = 2;\n");
  git(main, "add", "docs/new-name.md", "src/staged.ts");
  // unstaged
  writeFileSync(join(main, "src/big.ts"), numbered(BIG_LINES, true));
  writeFileSync(join(main, "src/money.ts"), MONEY_NEW);
  writeFileSync(join(main, "src/staged.ts"), "export const staged = 3;\n");
  writeFileSync(join(main, "src/large.txt"), `${"y".repeat(80)}\n`.repeat(LARGE_LINES));
  writeFileSync(join(main, "docs/new-name.md"), "# Notes\n\nthe first paragraph, revised\n\nthe second paragraph, too\n");
  writeFileSync(join(main, "assets/pic.bin"), new Uint8Array([137, 80, 78, 71, 0, 9, 8, 7, 6]));
  writeFileSync(join(main, "notes/dir with space/ünï 文件.txt"), "eins\ndrei\n");
  writeFileSync(join(main, "src/new.ts"), "export const fresh = 1;\n\nexport const minted = 2;\n");
  rmSync(join(main, "src/gone.ts"));

  const detached = join(root, "conflict");
  mkdirSync(join(detached, "src"), { recursive: true });
  git(detached, "init", "-q", "-b", "main");
  writeFileSync(join(detached, "src/conflict.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(detached, "add", ".");
  git(detached, "commit", "-q", "-m", "base");
  git(detached, "checkout", "-q", "-b", "feature");
  writeFileSync(join(detached, "src/conflict.ts"), "export const a = 1;\nexport const b = 20;\n");
  git(detached, "commit", "-q", "-am", "feature");
  git(detached, "checkout", "-q", "--detach", "main");
  writeFileSync(join(detached, "src/conflict.ts"), "export const a = 1;\nexport const b = 200;\n");
  git(detached, "commit", "-q", "-am", "main side");
  const merge = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", detached, "merge", "feature"], { stdout: "pipe", stderr: "pipe" });
  assert.notEqual(merge.exitCode, 0, "the merge conflicts");

  const plain = join(root, "plain");
  mkdirSync(plain);
  return { main, detached, plain };
}

const repos = fixtures();
const panes = new Map([["pane-main", repos.main], ["pane-conflict", repos.detached], ["pane-plain", repos.plain]]);
const requests: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let demoServer: ReturnType<typeof Bun.serve> | undefined;

/** The route the real server gives these paths, on a stand-in that maps a pane to its folder. */
async function api(request: Request, url: URL): Promise<Response | null> {
  if (url.pathname === "/api/voice") return Response.json({ configured: false, source: null, ...VOICE_DEFAULTS });
  const diff = /^\/api\/(?:machines\/([^/]+)\/)?workspace\/diff\/(files|file|commits)$/.exec(url.pathname);
  if (diff) {
    requests.push(url.pathname);
    const paneId = url.searchParams.get("pane_id");
    const cwd = (paneId !== null ? panes.get(paneId) : undefined) ?? url.searchParams.get("directory");
    if (!cwd) return Response.json({ error: { code: "pane_not_found", message: "no such pane" } }, { status: 404 });
    return repoDiffResponse(diff[2] === "files" ? "files" : diff[2] === "commits" ? "commits" : "file", cwd, url.searchParams);
  }
  if (/^\/api\/(?:machines\/[^/]+\/)?pane\/files$/.test(url.pathname)) {
    const cwd = panes.get(url.searchParams.get("pane_id") ?? "");
    return cwd ? Response.json(await paneFileSearch(cwd, url.searchParams.get("q") ?? "")) : Response.json({ error: { code: "pane_not_found", message: "no such pane" } }, { status: 404 });
  }
  const fs = /^\/api\/(?:machines\/([^/]+)\/)?fs\/(stat|file)$/.exec(url.pathname);
  if (fs) {
    requests.push(url.pathname);
    const path = url.searchParams.get("path") ?? "";
    let size: number;
    try { size = statSync(path).size; } catch { return Response.json({ error: { code: "not_found", message: "No readable file at this path." } }, { status: 404 }); }
    if (fs[2] === "stat") return Response.json({ path, name: path.split("/").pop(), kind: "text", size, mime: "text/plain", modified: "2026-01-01T00:00:00Z" });
    const body = readFileSync(path);
    const range = /^bytes=0-(\d+)$/.exec(request.headers.get("range") ?? "");
    if (range && Number(range[1]) < body.byteLength - 1) {
      const end = Number(range[1]);
      return new Response(body.subarray(0, end + 1), { status: 206, headers: { "content-range": `bytes 0-${end}/${body.byteLength}`, "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (/^\/api\/(?:machines\/[^/]+\/)?workspace\/directories$/.test(url.pathname)) {
    const path = url.searchParams.get("path") || repos.main;
    return Response.json(listDirectories(path, true, true));
  }
  return null;
}

/** The diff's rows in its shadow DOM, a self-contained reader serialized into each `evaluate`. */
const diffRows = () => Array.from(document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? []);

async function openFiles(page: Page, paneId: string, machine = "local"): Promise<void> {
  await page.evaluate(([paneId, machine, directory]) => window.repoDiffQA.openFiles(machine, paneId, directory), [paneId, machine, panes.get(paneId) ?? "/nowhere"] as const);
  await page.getByRole("dialog", { name: "Files", exact: true }).waitFor();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
}
async function closeFiles(page: Page): Promise<void> {
  await page.evaluate(() => window.repoDiffQA.closeFiles());
  await page.getByRole("dialog", { name: "Files", exact: true }).waitFor({ state: "detached" });
}
/** The Changes list once it has answered for `scope`: its rows as `mark path counts`. */
async function changeRows(page: Page, scope = "workspace"): Promise<string[]> {
  const list = page.locator(`.repo-changes:not([aria-busy='true']) .repo-changes-list[data-scope='${scope}']`);
  await list.waitFor();
  return list.locator(".repo-change").evaluateAll((rows) => rows.map((row) => `${row.querySelector(".repo-change-mark")?.textContent} ${row.querySelector(".repo-change-path")?.textContent} ${row.querySelector(".repo-change-counts")?.textContent ?? ""}`.trim()));
}
async function openChange(page: Page, path: string): Promise<void> {
  await page.locator(".repo-change").filter({ has: page.locator(".repo-change-path", { hasText: path }) }).first().click();
  await page.locator(".repo-diff-viewer").waitFor();
}
async function closeDiff(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close diff", exact: true }).click();
  await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
}
/** Waits for the diff's rows; a wait that runs out says what the viewer shows instead. */
async function waitRows(page: Page): Promise<void> {
  try {
    await page.waitForFunction(() => (document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
  } catch (error) {
    const seen = await page.evaluate(() => {
      const body = document.querySelector(".repo-diff-body");
      const container = document.querySelector("diffs-container");
      return { body: body?.textContent?.slice(0, 300), html: body?.innerHTML.slice(0, 600), containers: document.querySelectorAll("diffs-container").length, shadow: container?.shadowRoot?.innerHTML.slice(0, 600) };
    });
    throw new Error(`the diff's rows never mounted: ${JSON.stringify(seen)}`, { cause: error });
  }
}
interface Mounted { rows: number; first: number; last: number; inView: number; nodes: number; style: string | null }
async function mounted(page: Page): Promise<Mounted> {
  return page.evaluate(([rowsSource]) => {
    const rows = (new Function(`return (${rowsSource})()`) as () => HTMLElement[])();
    const view = document.querySelector<HTMLElement>(".repo-diff-scroll")!.getBoundingClientRect();
    const lines = rows.map((row) => Number(row.dataset["line"] ?? row.dataset["altLine"])).filter((line) => Number.isFinite(line));
    const inView = rows.filter((row) => { const rect = row.getBoundingClientRect(); return rect.bottom > view.top && rect.top < view.bottom; }).length;
    const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
    return { rows: rows.length, first: Math.min(...lines), last: Math.max(...lines), inView, nodes: shadow.querySelectorAll("*").length, style: shadow.querySelector("pre")?.getAttribute("data-diff-type") ?? null };
  }, [diffRows.toString()] as const);
}
async function scrollDiff(page: Page, where: "top" | "middle" | "end"): Promise<void> {
  await page.evaluate((where) => {
    const scroll = document.querySelector<HTMLElement>(".repo-diff-scroll")!;
    scroll.scrollTop = where === "end" ? scroll.scrollHeight : where === "middle" ? Math.floor(scroll.scrollHeight / 2) : 0;
  }, where);
}
/** Waits for a row at or past `line` to mount after a scroll; a wait that runs out reports the scroll root and the rows. */
async function rowReached(page: Page, line: number, step: string): Promise<void> {
  try {
    await page.waitForFunction((line) => [...(document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]") ?? [])].some((row) => Number(row.dataset["line"] ?? row.dataset["altLine"]) >= line), line);
  } catch (error) {
    const seen = await page.evaluate(([rowsSource]) => {
      const rows = (new Function(`return (${rowsSource})()`) as () => HTMLElement[])();
      const lines = rows.map((row) => Number(row.dataset["line"] ?? row.dataset["altLine"]));
      const scroll = document.querySelector<HTMLElement>(".repo-diff-scroll");
      return { rows: rows.length, first: Math.min(...lines), last: Math.max(...lines), scrollTop: scroll?.scrollTop, scrollHeight: scroll?.scrollHeight, clientHeight: scroll?.clientHeight, overflow: scroll && getComputedStyle(scroll).overflowY };
    }, [diffRows.toString()] as const);
    throw new Error(`${step}: no row at or past ${line} mounted: ${JSON.stringify(seen)}`, { cause: error });
  }
}
/** The viewer's note once it has settled: never the "Opening…" it shows while the patch is read. */
async function note(page: Page): Promise<string> {
  const text = page.locator(".repo-diff-body .repo-diff-note").filter({ hasNotText: "Opening…" });
  await text.waitFor();
  return (await text.textContent()) ?? "";
}
async function shot(page: Page, name: string): Promise<void> {
  if (evidence) await page.screenshot({ path: join(evidence, `repo-diff-${name}.png`) });
}
/** The text the rows `from`..`to` (indexes into the unified rows) hold, selected natively. */
async function selectRows(page: Page, from: number, to: number): Promise<string> {
  return page.evaluate(([from, to, rowsSource]) => {
    const rows = (new Function(`return (${rowsSource})()`) as () => HTMLElement[])();
    const range = document.createRange();
    range.setStart(rows[from]!, 0);
    range.setEnd(rows[to]!, rows[to]!.childNodes.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }, [from, to, diffRows.toString()] as const);
}
async function copied(page: Page): Promise<string> {
  await page.keyboard.press("ControlOrMeta+c");
  return page.evaluate(() => navigator.clipboard.readText());
}
/** What the unified rows of a patch's first hunk say, in order, as the viewer draws them: deletions before additions within a change. */
function hunkRowTexts(patch: string, count: number): string[] {
  const body = patch.slice(patch.indexOf("\n@@"));
  const lines = body.split("\n").slice(1).filter((line) => !line.startsWith("@@") && !line.startsWith("\\"));
  return lines.slice(0, count).map((line) => line.slice(1));
}

try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/repo-diff-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const policy = (await serveStatic("/")).headers.get("content-security-policy");
  assert.ok(policy, "build the app before its enforcing CSP regression");
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const answer = await api(request, url);
    if (answer) return answer;
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": policy } });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  const moneyPatch = await (await repoDiffResponse("file", repos.main, new URLSearchParams({ scope: "workspace", path: "src/money.ts" }))).json() as { patch: string };
  assert.ok(moneyPatch.patch.includes("@@"), "the fixture's money.ts has a patch");
  // the headless shell, not the full browser of CHROME_PATH: its clipboard is in memory, so the real copy below is owned here
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  assert.match(browser.version(), /^\d+\./, "a browser launched");

  for (const [width, theme] of [[1440, "dark"], [1440, "light"], [390, "dark"], [390, "light"]] as const) {
    const label = `${width}px ${theme}`;
    const phone = width === 390;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: theme });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.addInitScript((theme) => {
      // once: a reload keeps what the page saved since (the diff layout)
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme }));
      const record = window as unknown as { longTasks: number[] };
      record.longTasks = [];
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) record.longTasks.push(entry.duration); }).observe({ type: "longtask" });
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // the refusals asked for on purpose (a missing commit, a folder outside git) are logged by the browser as failed loads
      if (/Failed to load resource/.test(message.text()) && /\/workspace\/diff\//.test(message.location().url ?? "") && /status of (?:404|409)/.test(message.text())) return;
      errors.push(`console: ${message.text()}`);
    });
    await page.goto(origin);

    // the working tree's changes, each with its status, counts and the repository they are in
    await openFiles(page, "pane-main");
    const rows = await changeRows(page);
    assert.deepEqual(rows, [
      "M assets/pic.bin Binary",
      "M docs/new-name.md +1−1",
      "M notes/dir with space/ünï 文件.txt +1−1",
      "M src/big.ts +2,000−2,000",
      "D src/gone.ts +0−3",
      "M src/large.txt +8,000−8,000",
      "M src/money.ts +3−2",
      "? src/new.ts",
      "M src/staged.ts +1−1",
    ], `${label}: the working tree's changed files`);
    assert.equal(await page.locator(".repo-changes-branch").textContent(), "main", `${label}: the branch`);
    assert.equal(await page.locator(".repo-changes-root").textContent(), repos.main, `${label}: the repository root`);
    await shot(page, `list-${width}-${theme}`);

    // a 10 000-line diff: a window of rows at the top, the middle and the end, with old and new numbers
    const before = await page.evaluate(() => history.length);
    await openChange(page, "src/big.ts");
    // a phone's Files sheet holds an entry of its own, which the diff takes over (lib/sheetHistory.ts): one Back closes the diff
    assert.equal(await page.evaluate(() => history.length), phone ? before : before + 1, `${label}: the diff is a history entry`);
    await page.getByRole("dialog", { name: "Changes to big.ts", exact: true }).waitFor();
    await waitRows(page);
    const top = await mounted(page);
    assert.ok(top.rows > 0 && top.rows < 600, `${label}: bounded rows at the top: ${JSON.stringify(top)}`);
    assert.equal(top.first, 1, `${label}: the first row is line 1`);
    assert.equal(top.style, "single", `${label}: unified by default`);
    assert.ok(top.inView > 0, `${label}: rows in view at the top`);
    const numbers = await page.evaluate(() => {
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      const context = shadow.querySelector<HTMLElement>("[data-line][data-line-type='context'][data-alt-line]");
      const deletion = shadow.querySelector<HTMLElement>("[data-line][data-line-type='change-deletion']");
      const addition = shadow.querySelector<HTMLElement>("[data-line][data-line-type='change-addition']");
      const types: Record<string, number> = {};
      for (const row of shadow.querySelectorAll<HTMLElement>("[data-line]")) types[row.dataset["lineType"] ?? "?"] = (types[row.dataset["lineType"] ?? "?"] ?? 0) + 1;
      return { context: context && [context.dataset["line"], context.dataset["altLine"]], deletion: deletion?.dataset["line"] ?? deletion?.dataset["altLine"] ?? null, addition: addition?.dataset["line"] ?? addition?.dataset["altLine"] ?? null, types };
    });
    assert.deepEqual(numbers.context, ["1", "1"], `${label}: a context row carries its old and new numbers: ${JSON.stringify(numbers)}`);
    assert.ok(numbers.deletion === "4" && numbers.addition === "4", `${label}: the first change is line 4 on both sides: ${JSON.stringify(numbers)}`);
    const meta = await page.locator(".repo-diff-meta").first().textContent();
    assert.ok(meta?.includes("Modified") && meta.includes("+2,000") && meta.includes("−2,000") && meta.includes("Unstaged"), `${label}: the header's status, counts and comparison: ${meta}`);
    await shot(page, `top-${width}-${theme}`);
    await scrollDiff(page, "middle");
    await rowReached(page, Math.floor(BIG_LINES / 2) - 1000, `${label} middle`);
    const middle = await mounted(page);
    assert.ok(middle.rows > 0 && middle.rows < 600 && middle.inView > 0 && middle.first > 1000, `${label}: bounded rows in the middle: ${JSON.stringify(middle)}`);
    // the last line is blank and past the last hunk's context: the diff's last row is the line before it
    await scrollDiff(page, "end");
    await rowReached(page, BIG_LINES - 1, `${label} end`);
    const end = await mounted(page);
    assert.ok(end.rows > 0 && end.rows < 600 && end.inView > 0, `${label}: bounded rows at the end: ${JSON.stringify(end)}`);
    assert.equal(end.last, BIG_LINES - 1, `${label}: the last row is the last hunk's last context line: ${JSON.stringify(end)}`);
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth, dialog: document.querySelector(".repo-diff-viewer")!.getBoundingClientRect().width }));
    assert.ok(widths.page <= widths.viewport && widths.dialog <= widths.viewport, `${label}: nothing wider than the screen: ${JSON.stringify(widths)}`);
    await shot(page, `end-${width}-${theme}`);
    // the rows take the app's tokens, inside the shadow root
    const colors = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const resolve = (property: string, token: string) => { probe.style.setProperty(property, `var(${token})`); const value = getComputedStyle(probe).getPropertyValue(property); probe.style.removeProperty(property); return value; };
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      const row = shadow.querySelector<HTMLElement>("[data-line][data-line-type='context']")!;
      const result = { text: resolve("color", "--text"), row: getComputedStyle(row).color, bg: resolve("background-color", "--bg"), pre: getComputedStyle(shadow.querySelector("pre")!).backgroundColor, host: getComputedStyle(document.querySelector(".repo-diff diffs-container")!).backgroundColor };
      probe.remove();
      return result;
    });
    assert.equal(colors.row, colors.text, `${label}: the rows read in the app's text color: ${JSON.stringify(colors)}`);
    assert.ok([colors.bg, "rgba(0, 0, 0, 0)"].includes(colors.pre) && [colors.bg, "rgba(0, 0, 0, 0)"].includes(colors.host), `${label}: no code background of the package's own: ${JSON.stringify(colors)}`);
    // the package paints its gutter bars with the base colors verbatim and mixes the row tints from them
    const tints = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const resolve = (token: string) => { probe.style.backgroundColor = `var(${token})`; return getComputedStyle(probe).backgroundColor; };
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      const number = (type: string) => getComputedStyle(shadow.querySelector(`[data-column-number][data-line-type='${type}']`)!).color;
      const row = (type: string) => getComputedStyle(shadow.querySelector(`[data-line][data-line-type='${type}']`)!).backgroundColor;
      const result = { inserted: resolve("--syntax-inserted"), deleted: resolve("--syntax-deleted"), additionNumber: number("change-addition"), deletionNumber: number("change-deletion"), additionRow: row("change-addition"), deletionRow: row("change-deletion"), contextRow: row("context") };
      probe.remove();
      return result;
    });
    assert.equal(tints.additionNumber, tints.inserted, `${label}: an added row's number is the inserted token: ${JSON.stringify(tints)}`);
    assert.equal(tints.deletionNumber, tints.deleted, `${label}: a removed row's number is the deleted token: ${JSON.stringify(tints)}`);
    assert.ok(tints.additionRow !== tints.contextRow && tints.deletionRow !== tints.contextRow && tints.additionRow !== tints.deletionRow, `${label}: added and removed rows are each tinted: ${JSON.stringify(tints)}`);
    assert.ok((await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks)).every((task) => task < 1_000), `${label}: no long task of a second`);
    assert.deepEqual(errors, [], `${label}: no errors while opening the big diff`);
    console.log(`PASS ${label}: a 10 000-line diff as a bounded window of rows at the top, the middle and the end (rows ${top.rows}/${middle.rows}/${end.rows}), in the app's palette`);

    // unified or split: a setting kept across a reload; a phone draws one column and says why
    await scrollDiff(page, "top");
    const split = page.getByRole("button", { name: "Split", exact: true });
    if (phone) {
      assert.equal(await split.isDisabled(), true, `${label}: Split is declined on a phone`);
      await page.evaluate(() => window.repoDiffQA.settings({ diffStyle: "split" }));
      await page.locator(".repo-diff-notice").filter({ hasText: "Split view needs a wider screen; showing one column." }).waitFor();
      assert.equal((await mounted(page)).style, "single", `${label}: still one column with the setting on split`);
      await shot(page, `split-declined-${width}-${theme}`);
      await page.evaluate(() => window.repoDiffQA.settings({ diffStyle: "unified" }));
      await page.locator(".repo-diff-notice").filter({ hasText: "Split view needs a wider screen" }).waitFor({ state: "detached" });
      await closeDiff(page);
    } else {
      await split.click();
      await page.locator(".repo-diff[data-style='split']").waitFor();
      await page.waitForFunction(() => document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector("pre")?.getAttribute("data-diff-type") === "split");
      const splitRows = await mounted(page);
      assert.ok(splitRows.rows > 0 && splitRows.rows < 600 && splitRows.inView > 0, `${label}: bounded split rows: ${JSON.stringify(splitRows)}`);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).diffStyle), "split", `${label}: the layout is a saved setting`);
      await shot(page, `split-${width}-${theme}`);
      await page.reload();
      await page.getByRole("dialog", { name: "Changes to big.ts", exact: true }).waitFor();
      await waitRows(page);
      assert.equal((await mounted(page)).style, "split", `${label}: a reload keeps the diff open, split`);
      await page.getByRole("button", { name: "Unified", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector("pre")?.getAttribute("data-diff-type") === "single");
      // the reload lost the Files list beneath: Close steps back off the diff's entry, and the list is opened again
      await closeDiff(page);
      await openFiles(page, "pane-main");
      await changeRows(page);
    }
    console.log(`PASS ${label}: ${phone ? "a phone declines Split and says so" : "Split is kept across a reload, and Unified restored"}`);

    // the context folded to a line around each change, the numbers kept, and shown whole again
    await openChange(page, "src/money.ts");
    await waitRows(page);
    const whole = await page.evaluate(() => {
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      return { rows: shadow.querySelectorAll("[data-line]").length, separators: shadow.querySelectorAll("[data-separator='line-info']").length, secondChange: shadow.querySelectorAll<HTMLElement>("[data-line][data-line-type='change-addition']")[2]?.dataset["line"] };
    });
    await page.getByRole("button", { name: "Fold context", exact: true }).click();
    await page.locator(".repo-diff[data-folded]").waitFor();
    // the package re-renders its rows after the fold, not with it
    await page.waitForFunction((count) => { const rows = document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0; return rows > 0 && rows !== count; }, whole.rows);
    const folded = await page.evaluate(() => {
      const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!;
      return { rows: shadow.querySelectorAll("[data-line]").length, separators: shadow.querySelectorAll("[data-separator='line-info']").length, secondChange: shadow.querySelectorAll<HTMLElement>("[data-line][data-line-type='change-addition']")[2]?.dataset["line"], folded: [...shadow.querySelectorAll("[data-unmodified-lines]")].map((node) => node.textContent) };
    });
    assert.ok(folded.rows < whole.rows, `${label}: fewer rows folded: ${JSON.stringify({ whole, folded })}`);
    assert.ok(folded.separators >= whole.separators, `${label}: the folded lines are counted in separators: ${JSON.stringify({ whole, folded })}`);
    assert.equal(folded.secondChange, whole.secondChange, `${label}: the second hunk keeps its line numbers: ${JSON.stringify({ whole, folded })}`);
    assert.ok(folded.folded.some((text) => /\d+ unmodified lines/.test(text ?? "")), `${label}: a separator says how many lines are folded: ${JSON.stringify(folded.folded)}`);
    await shot(page, `folded-${width}-${theme}`);
    await page.getByRole("button", { name: "Fold context", exact: true }).click();
    await page.locator(".repo-diff:not([data-folded])").waitFor();
    await page.waitForFunction((count) => (document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) === count, whole.rows);
    assert.equal(await page.evaluate(() => document.querySelector(".repo-diff diffs-container")!.shadowRoot!.querySelectorAll("[data-line]").length), whole.rows, `${label}: shown whole again`);
    console.log(`PASS ${label}: the context folds to a line around each change and unfolds, numbers kept`);

    // native selection and a real copy: the rows' text alone, blank lines kept, no gutter numbers
    if (!phone) {
      // the worker's colors redraw the rows, plain until then, and a redraw drops a selection made on the plain ones
      await page.locator(".repo-diff[data-colored]").waitFor();
      await page.waitForFunction(() => (document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line] span[style*='--herdr-code-token']").length ?? 0) > 0);
      const expected = hunkRowTexts(moneyPatch.patch, 7);
      assert.ok(expected.includes(""), "the selected rows span a blank line");
      const selected = await selectRows(page, 0, 6);
      assert.equal(selected, expected.join("\n"), `${label}: the selection is the rows' text with its blank line`);
      assert.equal(await copied(page), expected.join("\n"), `${label}: the real copy is the same text`);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      console.log(`PASS ${label}: native selection and a real copy keep blank lines and leave the gutters out`);
    }

    // the file itself opens on the owning PC, above the diff; Escape closes one surface at a time
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    const file = page.getByRole("dialog", { name: "money.ts", exact: true });
    await file.waitFor();
    assert.ok(requests.some((path) => path === "/api/fs/stat"), `${label}: the file is read through the file routes`);
    await file.locator(".file-viewer-text .hl-line").first().waitFor();
    await page.keyboard.press("Escape");
    await file.waitFor({ state: "detached" });
    await page.locator(".repo-diff-viewer").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
    await page.getByRole("dialog", { name: "Files", exact: true }).waitFor();
    console.log(`PASS ${label}: Open file shows the file above the diff; Escape closes the file, then the diff, and the list stays`);

    // Back and Close return the focus to the row that opened the diff
    const row = page.locator(".repo-change").filter({ has: page.locator(".repo-change-path", { hasText: "src/money.ts" }) }).first();
    await row.focus();
    await page.keyboard.press("Enter");
    await page.locator(".repo-diff-viewer").waitFor();
    await page.evaluate(() => window.history.back());
    await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".repo-change-path")?.textContent), "src/money.ts", `${label}: Back returns the focus to the row`);
    await row.click();
    await page.locator(".repo-diff-viewer").waitFor();
    await closeDiff(page);
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".repo-change-path")?.textContent), "src/money.ts", `${label}: Close returns the focus to the row`);
    console.log(`PASS ${label}: Back and Close each close the diff alone and return the focus to its row`);

    // the kinds a diff cannot draw, and the kinds it draws from one side
    await openChange(page, "assets/pic.bin");
    assert.equal(await note(page), "This is a binary file; there are no lines to compare.", `${label}: a binary file says so`);
    assert.ok((await page.locator(".repo-diff-meta").first().textContent())?.includes("Binary"), `${label}: and is marked binary`);
    await shot(page, `binary-${width}-${theme}`);
    await closeDiff(page);
    await openChange(page, "src/large.txt");
    assert.equal(await note(page), "This change is larger than 1 MB and is not shown here.", `${label}: a change past the cap says so with the cap`);
    assert.equal(await page.getByRole("button", { name: "Copy patch", exact: true }).count(), 0, `${label}: nothing to copy of it`);
    await closeDiff(page);
    await openChange(page, "src/new.ts");
    await waitRows(page);
    const untracked = await page.evaluate(() => { const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!; return { additions: shadow.querySelectorAll("[data-line][data-line-type='change-addition']").length, deletions: shadow.querySelectorAll("[data-line][data-line-type='change-deletion']").length, context: shadow.querySelectorAll("[data-line][data-line-type='context']").length }; });
    assert.deepEqual(untracked, { additions: 3, deletions: 0, context: 0 }, `${label}: an untracked file is all additions: ${JSON.stringify(untracked)}`);
    assert.ok((await page.locator(".repo-diff-meta").first().textContent())?.includes("Untracked"), `${label}: and marked untracked`);
    await closeDiff(page);
    await openChange(page, "src/gone.ts");
    await waitRows(page);
    const deleted = await page.evaluate(() => { const shadow = document.querySelector(".repo-diff diffs-container")!.shadowRoot!; return { additions: shadow.querySelectorAll("[data-line][data-line-type='change-addition']").length, deletions: shadow.querySelectorAll("[data-line][data-line-type='change-deletion']").length }; });
    assert.deepEqual(deleted, { additions: 0, deletions: 3 }, `${label}: a deleted file is all deletions: ${JSON.stringify(deleted)}`);
    assert.equal(await page.getByRole("button", { name: "Open file", exact: true }).isDisabled(), true, `${label}: a deleted file cannot be opened`);
    await closeDiff(page);
    await openChange(page, "notes/dir with space/ünï 文件.txt");
    await waitRows(page);
    assert.equal(await page.getByRole("dialog", { name: "Changes to ünï 文件.txt", exact: true }).count(), 1, `${label}: a path with spaces and Unicode opens`);
    await closeDiff(page);
    console.log(`PASS ${label}: binary, too large, untracked, deleted and Unicode paths each show what they are`);

    // the index against HEAD: a rename with its old path; two commits by name; a commit that is not there
    await page.getByRole("button", { name: "Staged", exact: true }).click();
    const staged = await changeRows(page, "staged");
    assert.deepEqual(staged, ["R docs/old-name.md → docs/new-name.md +1−1", "M src/staged.ts +1−1"], `${label}: the staged changes: ${JSON.stringify(staged)}`);
    await openChange(page, "docs/new-name.md");
    await waitRows(page);
    const renamed = await page.locator(".repo-diff-meta").first().textContent();
    assert.ok(renamed?.includes("Renamed") && renamed.includes("Staged"), `${label}: a renamed file's header: ${renamed}`);
    assert.equal(await page.locator(".repo-diff-meta").first().getAttribute("title"), "Renamed from docs/old-name.md", `${label}: the old path is the tooltip`);
    await closeDiff(page);
    await page.getByRole("button", { name: "Commits", exact: true }).click();
    await page.getByLabel("From commit", { exact: true }).fill("HEAD~1");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const commits = await changeRows(page, "commit");
    assert.deepEqual(commits, ["A CHANGELOG.md +3−0", "M src/money.ts +1−1"], `${label}: the commits' changes: ${JSON.stringify(commits)}`);
    await openChange(page, "src/money.ts");
    await waitRows(page);
    assert.match((await page.locator(".repo-diff-compare").textContent()) ?? "", /^[0-9a-f]{7}\.\.[0-9a-f]{7}$/, `${label}: a commit comparison is named by its hashes`);
    await closeDiff(page);
    await page.getByLabel("From commit", { exact: true }).fill("nope");
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    await page.locator(".repo-changes-error").filter({ hasText: "No commit by that name." }).waitFor();
    await closeFiles(page);
    console.log(`PASS ${label}: staged renames, commit comparisons and a missing commit each read right`);

    // a conflicted file on a detached HEAD, and a folder that is no repository
    await openFiles(page, "pane-conflict");
    assert.deepEqual(await changeRows(page), ["U src/conflict.ts"], `${label}: a conflict is listed`);
    assert.equal(await page.locator(".repo-changes-branch").textContent(), "Detached HEAD", `${label}: a detached HEAD says so`);
    await openChange(page, "src/conflict.ts");
    assert.equal(await note(page), "This file has a merge conflict; resolve it in the terminal first.", `${label}: a conflict says so`);
    await closeDiff(page);
    await closeFiles(page);
    await openFiles(page, "pane-plain");
    await page.locator(".repo-changes-error").filter({ hasText: "This folder is not in a git repository." }).waitFor();
    await closeFiles(page);
    assert.deepEqual(errors, [], `${label}: no errors at the end`);
    console.log(`PASS ${label}: a conflict, a detached HEAD and a folder outside git are each explained`);
    await context.close();
  }

  // a remote PC's repository reads through its bridge, the file too
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(origin);
    requests.length = 0;
    await openFiles(page, "pane-main", "remote-fixture");
    await changeRows(page);
    await openChange(page, "src/money.ts");
    await waitRows(page);
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    await page.getByRole("dialog", { name: "money.ts", exact: true }).waitFor();
    assert.deepEqual(requests.filter((path) => path.includes("/workspace/diff/")), ["/api/machines/remote-fixture/workspace/diff/files", "/api/machines/remote-fixture/workspace/diff/file"], `remote diff requests: ${requests.join(", ")}`);
    assert.ok(requests.some((path) => path === "/api/machines/remote-fixture/fs/stat"), `remote file requests: ${requests.join(", ")}`);
    await context.close();
    console.log("PASS a remote PC's changes and files read through its bridge");
  }

  // Deliberately ignore fetch aborts: ownership generations, not cancellation alone, reject old answers.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      const fetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, String(input).includes("/pane/files?") ? { ...init, signal: undefined } : init)) as typeof window.fetch;
    });
    const page = await context.newPage(); page.setDefaultTimeout(20_000); await page.goto(origin);
    const integrated = (machine: string, pane: string) => page.evaluate(([machine, pane, directory]) => window.repoDiffQA.openIntegrated(machine, pane, directory), [machine, pane, panes.get(pane)!] as const);
    for (const boundary of ["query", "pane", "machine"] as const) {
      await integrated("local", "pane-main");
      await page.locator(".files-tree").waitFor();
      let ready!: () => void, release!: () => void;
      const captured = new Promise<void>((resolve) => { ready = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held = false;
      await page.route(/\/api\/pane\/files\?/, async (route) => {
        const url = new URL(route.request().url());
        if (held || url.searchParams.get("q") !== "money") { await route.continue(); return; }
        held = true; ready(); await released;
        await route.fulfill({ json: { root: "/wrong-owner", files: ["wrong-owner.txt"], repository: true, truncated: false, incomplete: [], limits: { max_entries: 5000, max_results: 100, max_depth: 6 } } });
      });
      await page.getByRole("button", { name: "Find files…", exact: true }).click();
      const query = page.locator(".files-find input"); await query.fill("money"); await captured;
      if (boundary !== "query") await integrated(boundary === "machine" ? "remote-fixture" : "local", boundary === "pane" ? "pane-conflict" : "pane-main");
      const wanted = boundary === "query" ? "staged" : boundary === "pane" ? "conflict" : "money";
      await query.fill(wanted);
      await page.getByRole("option", { name: `src/${wanted}.ts`, exact: true }).waitFor();
      release(); await page.unrouteAll({ behavior: "wait" });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await page.getByRole("option", { name: "wrong-owner.txt", exact: true }).count(), 0, `${boundary}: late inventory cannot replace the current owner/query`);
      await closeFiles(page);
    }
    await integrated("local", "pane-main");
    await page.getByRole("button", { name: "Find files…", exact: true }).click();
    await page.locator(".files-find input").fill("big.ts");
    await page.getByRole("option", { name: "src/big.ts", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".virtual-source diffs-container")?.shadowRoot?.querySelector("[data-column-number]"));
    await page.evaluate(() => {
      const gutter = document.querySelector(".virtual-source diffs-container")!.shadowRoot!.querySelector<HTMLElement>("[data-column-number]")!;
      gutter.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); gutter.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); gutter.click();
    });
    await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Large source annotation");
    await page.locator(".review-editor").getByRole("button", { name: "Save", exact: true }).click();
    const savedSource = await page.evaluate(() => localStorage.getItem("herdr-web-ui:review-notes")!);
    const originalLine = (JSON.parse(savedSource) as { target: { start: number } }[])[0]!.target.start;
    const bigPath = join(panes.get("pane-main")!, "src/big.ts"), originalSource = readFileSync(bigPath, "utf8");
    writeFileSync(bigPath, `// inserted header\n${originalSource}`);
    const relocatedPage = await context.newPage(); await relocatedPage.goto(origin);
    await relocatedPage.evaluate((directory) => window.repoDiffQA.openIntegrated("local", "pane-main", directory), panes.get("pane-main")!);
    await relocatedPage.getByRole("button", { name: "Find files…", exact: true }).click();
    await relocatedPage.locator(".files-find input").fill("big.ts");
    await relocatedPage.getByRole("option", { name: "src/big.ts", exact: true }).click();
    await relocatedPage.locator(".file-review-bar .review-marker").click();
    assert.ok((await relocatedPage.locator(".review-reference").textContent())?.includes(`lines ${originalLine + 1}`), "editor references follow the verified source relocation");
    await page.locator(".file-review-bar .review-marker").click();
    assert.ok((await page.locator(".review-reference").textContent())?.includes(`lines ${originalLine}`), "another tab retains coordinates for its own loaded snapshot");
    assert.equal(await page.evaluate(() => localStorage.getItem("herdr-web-ui:review-notes")), savedSource, "viewer relocation does not write back competing snapshots");
    await page.locator(".review-editor").getByRole("button", { name: "Close comments", exact: true }).click();
    await relocatedPage.close(); writeFileSync(bigPath, originalSource);
    await page.evaluate(() => {
      const key = "herdr-web-ui:review-notes", [note] = JSON.parse(localStorage.getItem(key)!);
      if (note.target.kind !== "source" || !note.target.evidence.includes("line_")) throw new Error("virtual source callback lost its source evidence");
      localStorage.setItem(key, JSON.stringify(Array.from({ length: 1000 }, (_, index) => ({ ...note, key: `many-${index}`, id: `many-version-${index}`, created: index, text: `Many note ${index}` }))));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    await page.waitForFunction(() => document.querySelectorAll(".file-review-bar .review-marker").length === 100);
    assert.ok(await page.locator(".virtual-source").evaluate((node) => (node.querySelector("diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) < 1000), "many comments do not expand the virtual source DOM");
    await page.locator(".file-review-bar .composer-review-notes button").click();
    assert.equal(await page.locator(".review-note-list li").count(), 100);
    await page.getByRole("button", { name: "Next comments", exact: true }).click();
    assert.ok((await page.locator(".review-note-list").textContent())?.includes("Many note 100"));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:review-notes")!).length), 1000, "marker/list bounds never delete saved comments");
    await context.close(); console.log("PASS stale query/pane/machine responses and bounded virtual-source annotations");
  }

  // the static demo answers the routes from its fixture: the list, a diff and no missing route
  {
    const app = join(root, "demo");
    await buildDemoApp(app);
    const index = join(app, "index.html");
    const recorder = `<script>(() => {
      const Demo = window.WebSocket;
      window.reviewQA = { frames: [], hold: false, refuse: false, releases: [] };
      const Recorded = function(url, protocols) {
        const socket = new Demo(url, protocols), send = socket.send.bind(socket);
        socket.send = (raw) => {
          const frame = JSON.parse(String(raw)); window.reviewQA.frames.push(frame);
          if (frame.type === 'submit' && window.reviewQA.hold) { window.reviewQA.releases.push(() => send(raw)); return; }
          if (frame.type === 'submit' && window.reviewQA.refuse) {
            queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'submit-result', id: frame.id, pane_id: frame.pane_id, ok: false, code: 'submit_failed', message: 'fixture refusal' }) }))); return;
          }
          send(raw);
        }; return socket;
      };
      for (const name of ['CONNECTING','OPEN','CLOSING','CLOSED']) Object.defineProperty(Recorded, name, { value: Demo[name] });
      window.WebSocket = Recorded;
    })();</script>`;
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n${recorder}\n<script type="module"`));
    demoServer = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      const prefix = "/herdr-web-ui/demo/app/";
      if (!path.startsWith(prefix) && !path.startsWith("/icons/")) return new Response("not found", { status: 404 });
      let file = decodeURIComponent(path.startsWith("/icons/") ? path.slice(1) : path.slice(prefix.length));
      if (!file || file.endsWith("/")) file += "index.html";
      const body = Bun.file(join(app, file));
      return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
    } });
    for (const width of [1280, 390] as const) {
      const phone = width === 390;
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 800 }, isMobile: phone, hasTouch: phone });
      await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", theme: "dark", autoSendQueued: false })));
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      const missing: string[] = [], errors: string[] = [];
      page.on("response", (response) => { if (response.status() === 404) missing.push(response.url()); });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${demoServer.port}/herdr-web-ui/demo/app/`);
      await page.locator(".header-more-button").waitFor();
      const ownedPane = page.locator('.agent-select[title*="Ship the retry flag"]').first();
      await ownedPane.waitFor({ state: "attached" }).catch(async (cause: unknown) => { throw new Error(`fictional pane was not listed: ${JSON.stringify(await page.locator('.pane-select,.agent-select').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title'))))}`, { cause }); });
      await ownedPane.evaluate((node: HTMLElement) => node.click());
      await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
      await runMoreItem(page, "Browse files");
      const files = page.locator(".files-dialog"); await files.waitFor();
      await page.locator(".files-tree").waitFor();
      assert.equal(await page.locator(".files-detail .file-viewer").count(), 0, "Files never opens an arbitrary file");
      await files.getByRole("button", { name: "Find files…", exact: true }).click();
      const picker = page.locator(".files-find"); await picker.waitFor();
      const query = picker.getByRole("searchbox");
      await query.fill("src/money.ts");
      await picker.getByRole("option", { name: "src/money.ts", exact: true }).waitFor();
      await query.dispatchEvent("keydown", { key: "Escape", isComposing: true, keyCode: 229 });
      assert.equal(await picker.count(), 1, "IME Escape keeps the picker");
      await query.fill("src");
      const moneyChoice = picker.getByRole("option", { name: "src/money.ts", exact: true });
      await moneyChoice.waitFor(); await moneyChoice.focus(); await moneyChoice.press("ArrowUp");
      assert.equal(await picker.locator('[aria-selected="true"]').evaluate((node) => node === document.activeElement), true, "arrows move a Tab-focused result, not just its highlight");
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter"); await picker.waitFor({ state: "detached" });
      await page.locator(".files-detail .hl-line[data-line='4']").waitFor();
      await page.evaluate(() => {
        const line = document.querySelector(".files-detail .hl-line[data-line='4']")!, range = document.createRange();
        range.selectNodeContents(line); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
        line.closest("pre")!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      });
      assert.equal(await page.locator(".review-editor").count(), 0, "selection alone never opens an editor or prevents copying");
      await files.getByRole("button", { name: "Comment on selected lines", exact: true }).click();
      const editor = page.locator(".review-editor"), comment = editor.getByRole("textbox", { name: "Comment", exact: true });
      await comment.fill("Review this source line");
      await files.getByRole("button", { name: "Find files…", exact: true }).click();
      assert.equal(await picker.count(), 0, "dirty editor blocks search");
      assert.equal(await comment.inputValue(), "Review this source line");
      assert.equal(await comment.evaluate((node) => document.activeElement === node), true, "blocked navigation focuses the draft");
      await comment.evaluate((node: HTMLTextAreaElement) => { node.dataset.stable = 'draft'; node.setSelectionRange(5, 5); });
      await page.setViewportSize({ width: phone ? 320 : 390, height: 844 });
      assert.equal(await comment.evaluate((node: HTMLTextAreaElement) => node.dataset.stable === 'draft' && node.selectionStart === 5 && document.activeElement === node), true, "resize preserves textarea identity, focus and caret");
      await page.setViewportSize({ width, height: phone ? 844 : 800 });
      await comment.dispatchEvent('compositionstart');
      assert.equal(await editor.getByRole("button", { name: "Save", exact: true }).isDisabled(), true, "composition is not saved or navigated away mid-candidate");
      await files.getByRole("button", { name: "Find files…", exact: true }).click(); assert.equal(await picker.count(), 0);
      await comment.dispatchEvent('compositionend');
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await files.locator(".review-marker").first().click();
      await comment.fill("");
      await files.getByRole("button", { name: "Refresh files and changes", exact: true }).click();
      assert.equal(await editor.count(), 1, "blank saved edit is dirty");
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      assert.equal(await files.locator(".review-marker").count(), 0, "saving a blank edit deletes the note");
      if (phone) await files.getByRole("button", { name: "Back to files", exact: true }).click();
      await files.getByRole("button", { name: "Compare", exact: true }).click();
      await changeRows(page, "all");
      const fileOnly = files.getByRole("checkbox", { name: "This file only", exact: true });
      await fileOnly.check();
      await files.getByRole("button", { name: "Unstaged", exact: true }).click();
      assert.deepEqual((await changeRows(page)).map((row) => row.split(" ")[1]), ["src/money.ts"], "mode changes retain the selected file scope");
      await files.getByRole("button", { name: "Choose a historical base", exact: true }).click();
      await picker.getByRole("searchbox").fill("money");
      await picker.getByRole("option").first().waitFor();
      await picker.getByRole("searchbox").press("ArrowDown"); await picker.getByRole("searchbox").press("Enter");
      await picker.waitFor({ state: "detached" });
      await files.getByRole("button", { name: "Reset to current changes", exact: true }).waitFor();
      assert.equal(await fileOnly.isChecked(), true);
      assert.deepEqual((await changeRows(page, "all")).map((row) => row.split(" ")[1]), ["src/money.ts"], "historical selection retains the selected file scope");
      await openChange(page, "src/money.ts"); await waitRows(page);
      const demoDiff = await mounted(page); assert.ok(demoDiff.rows >= 8 && demoDiff.rows < 40, `bounded demo rows: ${JSON.stringify(demoDiff)}`);
      assert.ok((await page.locator(".repo-diff-meta").textContent())?.includes("versus working tree"), "historical direction is explicit");
      // Public renderer gutter callbacks, not persistent shadow-DOM anchors.
      await page.evaluate(() => { const gutter = document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelector<HTMLElement>("[data-column-number][data-line-type='change-addition']"); gutter?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); gutter?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); gutter?.click(); });
      await comment.waitFor(); await comment.fill("Review this added diff line"); await editor.getByRole("button", { name: "Save", exact: true }).click();
      if (phone) await files.getByRole("button", { name: "Back to files", exact: true }).click();
      await files.getByRole("button", { name: "Reset to current changes", exact: true }).click();
      await changeRows(page, "all"); await openChange(page, "src/money.ts"); await waitRows(page);
      await files.getByRole("button", { name: "Outdated comment", exact: true }).waitFor();
      if (!phone) { await files.getByRole("button", { name: "Diff layout", exact: true }).click(); await page.waitForFunction(() => document.querySelector(".repo-diff")?.getAttribute("data-style") === "split"); }
      else { assert.equal(await files.getByRole("button", { name: "Diff layout", exact: true }).isDisabled(), true); await page.setViewportSize({ width: 320, height: 844 }); }
      const geometry = await files.evaluate((node) => ({ scroll: node.scrollWidth, width: node.clientWidth, header: node.querySelector(".files-header")!.scrollWidth }));
      assert.ok(geometry.scroll <= geometry.width && geometry.header <= geometry.width, `bounded Files header at ${phone ? 320 : width}px: ${JSON.stringify(geometry)}`);
      await files.getByRole("button", { name: "Close files", exact: true }).click(); await files.waitFor({ state: "detached" });
      await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
      await page.locator(".composer-review-notes").waitFor();
      await page.locator(".reply-review-controls button").filter({ hasText: "Comment" }).first().click();
      await comment.fill("Review this settled reply"); await editor.getByRole("button", { name: "Save", exact: true }).click();
      const composer = page.locator(".composer-text"), send = page.getByRole("button", { name: "Send message", exact: true });
      await composer.fill("Ordinary message after comments");
      await page.evaluate(() => { window.reviewQA.hold = true; });
      await send.click(); await page.waitForFunction(() => window.reviewQA.releases.length === 1);
      await page.locator(".composer-review-notes button").click();
      await page.locator(".review-note-open").filter({ hasText: "Review this settled reply" }).click();
      await comment.fill("Late edit survives acknowledgment"); await editor.getByRole("button", { name: "Save", exact: true }).click();
      await page.evaluate(() => { window.reviewQA.hold = false; window.reviewQA.releases.shift()!(); });
      await page.waitForFunction(() => { const notes = JSON.parse(localStorage.getItem('herdr-web-ui:review-notes') ?? '[]'); return notes.length === 1 && notes[0].text === 'Late edit survives acknowledgment'; });
      const sentFrame = await page.evaluate(() => window.reviewQA.frames.find((frame) => frame.type === "submit")!);
      assert.equal(sentFrame.agent_only, true, "comment text carries agent-only intent");
      assert.ok(sentFrame.text?.includes("Review this settled reply") && sentFrame.text.includes("Review this added diff line") && sentFrame.text.endsWith("Ordinary message after comments"), "all original captured notes precede prose, including outdated diff notes");
      assert.ok(sentFrame.text!.indexOf("Agent reply") < sentFrame.text!.indexOf("src/money.ts"), "reply notes precede file notes");
      await page.locator('.pane-frame.is-current .composer-status[data-status="working"]').waitFor();
      await composer.fill("Queue acceptance owns this complete payload"); await send.click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('herdr-web-ui:review-notes') ?? '[]').length === 0 && Object.keys(localStorage).filter((key) => key.startsWith('herdr-web-ui:pending:')).flatMap((key) => JSON.parse(localStorage.getItem(key)!).messages).some((message: { state: string; agent_only?: boolean; text: string }) => message.state === 'held' && message.agent_only && message.text.endsWith('Queue acceptance owns this complete payload')));
      const queuedFrame = await page.evaluate(() => window.reviewQA.frames.filter((frame) => frame.type === "submit").at(-1)!);
      assert.equal(queuedFrame.delivery, "hold", "accepted pending text owns all captured note versions");
      assert.ok(queuedFrame.text?.includes("Late edit survives acknowledgment"));
      await page.locator(".reply-review-controls button").filter({ hasText: "Comment" }).first().click();
      await comment.fill("Keep this failed comment"); await editor.getByRole("button", { name: "Save", exact: true }).click();
      await page.evaluate(() => { window.reviewQA.refuse = true; });
      await composer.fill("Keep this draft after refusal"); await send.click();
      await page.locator(".composer-note").filter({ hasText: "fixture refusal" }).waitFor();
      assert.equal(await composer.inputValue(), "Keep this draft after refusal", "failed delivery preserves the composer draft");
      const recovery = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("herdr-web-ui:pending:")).flatMap((key) => JSON.parse(localStorage.getItem(key)!).messages).find((message: { state: string; agent_only?: boolean }) => message.state === "uncertain" && message.agent_only));
      assert.ok(recovery.text.includes("Keep this failed comment") && recovery.text.endsWith("Keep this draft after refusal"), "uncertainty preserves the exact composed payload");
      await page.locator(".composer-review-notes button").click(); await page.locator(".review-note-open").click();
      await comment.fill("Dirty note must require destructive confirmation");
      await editor.getByRole("button", { name: "Turn off review comments?", exact: true }).click();
      await page.locator(".confirm-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await comment.inputValue(), "Dirty note must require destructive confirmation", "cancel preserves the dirty draft");
      const otherTab = await context.newPage();
      await otherTab.goto(`http://127.0.0.1:${demoServer.port}/herdr-web-ui/demo/app/`);
      await otherTab.locator('.agent-select[title*="Ship the retry flag"]').first().evaluate((node: HTMLElement) => node.click());
      await otherTab.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
      await otherTab.locator(".composer-review-notes button").click();
      await otherTab.locator(".review-note-open").click();
      await otherTab.getByRole("textbox", { name: "Comment", exact: true }).fill("Dirty in the other tab");
      await editor.getByRole("button", { name: "Turn off review comments?", exact: true }).click();
      await page.locator(".confirm-dialog").getByRole("button", { name: "Turn off and delete", exact: true }).click();
      await otherTab.locator(".review-editor").waitFor({ state: "detached" });
      assert.equal(await otherTab.locator(".reply-review-controls").count(), 0, "confirmed device-wide deletion disables other tabs and removes their dirty editor");
      await otherTab.close();
      await editor.waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:review-notes") ?? "[]").length), 0);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings")!).reviewComments), false);
      const keptPayloads = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("herdr-web-ui:pending:")).flatMap((key) => JSON.parse(localStorage.getItem(key)!).messages).map((message: { text: string }) => message.text));
      assert.ok(keptPayloads.some((text: string) => text.endsWith("Keep this draft after refusal")) && keptPayloads.some((text: string) => text.endsWith("Queue acceptance owns this complete payload")), "turning comments off never rewrites or cancels accepted or uncertain payloads");
      assert.deepEqual(errors, [], `no page errors: ${errors.join(", ")}`);
      assert.deepEqual(missing, [], `no missing demo routes: ${missing.join(", ")}`);
      await context.close(); console.log(`PASS integrated Files ${width}px: search/IME, source notes, dirty guard, historical diff notes, outdated snapshot, Back, layout and header`);
    }
  }
  console.log("repository diff: browser OK (list, bounded rows, unified/split, fold, copy, open file, Back/Close/focus, unavailable kinds, staged/commits/errors, remote, demo)");
} finally {
  await browser?.close(); server?.stop(true); demoServer?.stop(true); rmSync(root, { recursive: true, force: true });
}
