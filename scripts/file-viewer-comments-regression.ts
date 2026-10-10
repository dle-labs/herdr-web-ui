/**
 * Comments on files in the file viewer, with a real Codex transcript (its reply links `./src/sync.ts`
 * and `./docs/spec.md`) and an owned herdr pane: a text selection (drag, keyboard, touch, double or triple click) offers
 * Comment without opening an editor or interfering with focus and copying. Activating Comment, or clicking or tapping
 * a line, opens the editor in the code view (on a desktop and a phone) and the Markdown preview, named by the
 * source lines it came from; its pin's tip where it was clicked or the drag let go, else (a stored comment without a
 * point) after the end of its text (the text highlighted), and the popover beside the pin, to its
 * right (a bottom sheet on a phone), a saved comment opened straight into its field (its text highlighted meanwhile)
 * with Delete beside ↑; Escape, which
 * never closes the viewer while a popover is open; the viewer's header (its counter walking the file's comments,
 * unfolding a folded code block, an outdated one in a dialog); the chat's own comments, which share the pins, the
 * popover and the highlights with the viewer; and the composer's bar, whose walk goes on from the chat's comments into
 * the files' and whose send takes them all.
 *
 * One server, pane and browser per run. Each case starts from a fresh page with an empty comment
 * store, so a case runs alone: `FILE_COMMENTS_CASE=<name>[,<name>]` runs only those (unset: all).
 * Waits are bounded polls (`eventually`, `frames`), never fixed sleeps. Serves `dist/`: build first.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContextOptions, type Locator, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { TEXT_LOAD_LIMIT } from "../src/lib/textPreview.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

/** `src/sync.ts`: line 8 is the comparison a comment questions. */
const SYNC_LINES = [
  "import { load, store } from \"./store.ts\";",
  "",
  "export interface Note { id: string; revision: number; text: string }",
  "",
  "/** Writes a note unless a newer one is stored. */",
  "export async function sync(incoming: Note): Promise<Note> {",
  "  const stored = await load(incoming.id);",
  "  if (incoming.revision < stored.revision) {",
  "    return stored;",
  "  }",
  "  await store(incoming);",
  "  return incoming;",
  "}",
];

/**
 * `docs/spec.md`, for the preview's cases: a heading, a paragraph over two source lines, a table whose
 * rows are source lines 42–43, a list item with a continuation line, a fenced block on line 50, and a
 * long fenced block the preview folds (its lines 54–88, the head 54–73 drawn).
 */
const SPEC_LINES = [
  "# Sync spec",
  "",
  "A write carries the revision it was made on, and the server",
  "compares it with the revision it stores.",
  "",
  "## Revisions",
  "",
];
for (let n = 1; SPEC_LINES.length < 37; n++) SPEC_LINES.push(`Rule ${n} of the revisions keeps the notes in order.`, "");
SPEC_LINES.push(
  "## Answers",
  "",
  "| Case | Answer |",
  "| --- | --- |",
  "| Older revision | 409 Conflict with the stored note |",
  "| Newer revision | 200 with the merged note |",
  "",
  "- Retry on a conflict",
  "  with the stored revision.",
  "- Give up after three tries.",
  "",
  "```ts",
  "const retries = 3;",
  "```",
  "",
  "```text",
  ...Array.from({ length: 35 }, (_, n) => `log line ${n + 1} of the sync`),
  "```",
);
assert.ok(SPEC_LINES[41]!.startsWith("| Older revision") && SPEC_LINES[42]!.startsWith("| Newer revision"), "the table's rows are lines 42–43");
assert.equal(SPEC_LINES[49], "const retries = 3;", "the short block's line is line 50");
/** The long block's first line, the last its folded head draws, and a line folded away. */
const FOLD_FIRST = 54;
const FOLD_HEAD_LAST = FOLD_FIRST + 19;
const FOLDED_LINE = 80;
assert.equal(SPEC_LINES[FOLD_FIRST - 1], "log line 1 of the sync");
assert.equal(SPEC_LINES[FOLDED_LINE - 1], "log line 27 of the sync");

/** The reply's paragraph the chat case comments on. */
const REPLY = "The sync plan keeps every revision in order and never loses a write.";

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-file-comments-"));
const codexHome = join(root, "codex-home");
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc13";
mkdirSync(join(codexHome, "sessions"), { recursive: true });
const transcript = join(codexHome, "sessions", `rollout-2026-10-06T00-00-00-${thread}.jsonl`);
writeFileSync(transcript, [
  { type: "session_meta", payload: { id: thread, cwd: root } },
  { timestamp: "2026-10-06T10:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Show me the sync plan." }] } },
  { timestamp: "2026-10-06T10:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `${REPLY}\n\nOpen [sync.ts](./src/sync.ts) or [spec.md](./docs/spec.md) or [big.txt](./src/big.txt) or [long.txt](./src/long.txt) or [wide.ts](./src/wide.ts).` }] } },
].map((row) => JSON.stringify(row)).join("\n"));
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(thread, transcript, root, "Show me the sync plan.");
db.close();
const standIn = join(root, "codex");
writeFileSync(standIn, "#!/bin/sh\nsleep 600\n");
chmodSync(standIn, 0o755);
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "sync.ts"), `${SYNC_LINES.join("\n")}\n`);
mkdirSync(join(root, "docs"));
writeFileSync(join(root, "docs", "spec.md"), `${SPEC_LINES.join("\n")}\n`);
// `src/big.txt`, a little past the viewer's load limit, opens cut short
writeFileSync(join(root, "src", "big.txt"), "a line of plain text, 0123456789\n".repeat(Math.ceil((TEXT_LOAD_LIMIT + 1024) / 33)));
/** One line longer than the load limit: it opens cut inside its only line, which is then no whole line to comment on. */
writeFileSync(join(root, "src", "long.txt"), "one long line ".repeat(Math.ceil((TEXT_LOAD_LIMIT + 1024) / 14)));
/** `src/wide.ts`: line 2 ends well inside the code view, line 3 runs far past it, so the view (no wrapping) scrolls sideways. */
const WIDE_LINES = [
  "// one line here runs far past the view",
  "export const near = \"a line that ends inside the view\";",
  `export const far = "${"a long run of words ".repeat(30)}";`,
];
writeFileSync(join(root, "src", "wide.ts"), `${WIDE_LINES.join("\n")}\n`);

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const { defaultBrowserType: _webkit, ...iPhone } = devices["iPhone 13"]!;
const PHONE: BrowserContextOptions = { ...iPhone, hasTouch: true };

/** Polls `check` every 50 ms until it holds; throws at the deadline (no fixed sleeps). */
async function eventually(what: string, check: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Waits `count` animation frames (the page's own updates run once per frame): for something that must not happen. */
const frames = (page: Page, count = 6): Promise<void> => page.evaluate((n) => new Promise<void>((resolve) => {
  let left = n;
  const tick = (): void => {
    left -= 1;
    if (left <= 0) resolve();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}), count);

/** How many ranges the named CSS Custom Highlight holds: what is painted over the text of the comments. */
const highlighted = (page: Page, name = "block-comment"): Promise<number> => page.evaluate((highlight) => {
  const registry = (CSS as unknown as { highlights?: { get(key: string): { size: number } | undefined } }).highlights;
  return registry?.get(highlight)?.size ?? 0;
}, name);

/** The text the named CSS Custom Highlight paints, its ranges joined: beside its pin the popover quotes nothing, so what a
 * new comment is on is read here (`block-comment-pending`). */
const highlightText = (page: Page, name = "block-comment-pending"): Promise<string> => page.evaluate((highlight) => {
  const registry = (CSS as unknown as { highlights?: { get(key: string): Iterable<AbstractRange> | undefined } }).highlights;
  return [...(registry?.get(highlight) ?? [])].map((range) => range instanceof Range ? range.toString() : "").join(" ");
}, name);

/**
 * Selects text the way the keyboard (Shift+arrows) or a finger's long press leaves it: from the start of `from` in
 * `first` to the end of `to` in `last` (the element's own text; `last` may be `first`), made the page's selection,
 * then the event that ends the gesture: a finger's `pointerup` at the selection's end on a touch screen, else the
 * `keyup` of the Shift key. Both offer Comment without opening an editor.
 */
async function selectText(first: Locator, from: string, last: Locator, to: string): Promise<void> {
  await first.evaluate((start, { stop, text }) => {
    const own = (element: Element): { nodes: Text[]; all: string } => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let all = "";
      for (let next = walker.nextNode(); next; next = walker.nextNode()) {
        nodes.push(next as Text);
        all += (next as Text).data;
      }
      return { nodes, all };
    };
    const point = (found: { nodes: Text[] }, offset: number, atEnd: boolean): [Text, number] => {
      let seen = 0;
      for (const piece of found.nodes) {
        if (offset < seen + piece.length || (atEnd && offset === seen + piece.length)) return [piece, offset - seen];
        seen += piece.length;
      }
      throw new Error("no text node at the offset");
    };
    const head = own(start);
    const tail = own(stop as Element);
    const at = head.all.indexOf(text.from);
    if (at < 0) throw new Error(`"${text.from}" is not in ${JSON.stringify(head.all)}`);
    const on = tail.all.indexOf(text.to, stop === start ? at : 0);
    if (on < 0) throw new Error(`"${text.to}" is not in ${JSON.stringify(tail.all)}`);
    const range = document.createRange();
    range.setStart(...point(head, at, false));
    range.setEnd(...point(tail, on + text.to.length, true));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const line = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).at(-1) ?? range.getBoundingClientRect();
    if (matchMedia("(pointer: coarse)").matches) {
      (stop as Element).dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", clientX: line.right, clientY: line.top + line.height / 2 }));
    } else (stop as Element).dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
  }, { stop: await last.elementHandle(), text: { from, to } });
}

/** A point the pointer acted at, in client pixels, and the scroll of the viewer's body then: where it is on the text after a scroll. */
interface Pointed { x: number; y: number; scroll: number }
/** The viewer's body's `scrollTop` (`scope`: the viewer or its body). */
const bodyScroll = (scope: Locator): Promise<number> => scope.evaluate((node) => (node.matches(".file-viewer-body") ? node : node.querySelector(".file-viewer-body"))!.scrollTop);

/**
 * A mouse's drag from the start of `from` in `first` to the end of `to` in `last` (a press, moves and a release, one
 * click): checks that Comment preserves selection, copying and focus, then clicks it. Returns where it let go, with the
 * scroll of `viewer`'s body then (0 for the chat: `viewer` null).
 */
async function dragText(page: Page, viewer: Locator | null, first: Locator, from: string, last: Locator, to: string): Promise<Pointed> {
  await first.evaluate((node) => node.scrollIntoView({ block: "center" }));
  const edge = (element: Locator, word: string, end: boolean): Promise<{ x: number; y: number }> => element.evaluate((node, wanted) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let next = walker.nextNode(); next; next = walker.nextNode()) {
      const at = (next as Text).data.indexOf(wanted.word);
      if (at < 0) continue;
      const offset = wanted.end ? at + wanted.word.length - 1 : at;
      const range = document.createRange();
      range.setStart(next, offset);
      range.setEnd(next, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: wanted.end ? rect.right - 1 : rect.left + 1, y: rect.top + rect.height / 2 };
    }
    throw new Error(`"${wanted.word}" is not in the element`);
  }, { word, end });
  const start = await edge(first, from, false);
  const end = await edge(last, to, true);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
  const release = { ...end, scroll: viewer === null ? 0 : await bodyScroll(viewer) };
  await assertSelectionButton(page, "a dragged selection");
  await selectionButtonOf(page).click();
  return release;
}

/** No selection action after activation, dismissal, or on a disabled surface. */
const assertNoButton = async (page: Page, what: string): Promise<void> => {
  assert.equal(await page.locator(".comment-selection").count(), 0, `${what}: no Comment button`);
};

const selectionButtonOf = (page: Page): Locator => page.getByRole("button", { name: "Comment", exact: true }).and(page.locator(".comment-selection"));

/** Selection alone offers Comment while leaving focus, selected text and native copying intact. */
async function assertSelectionButton(page: Page, what: string): Promise<void> {
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  const focus = await page.evaluateHandle(() => document.activeElement);
  assert.ok(selected.trim(), `${what}: text stays selected`);
  await selectionButtonOf(page).waitFor({ state: "visible" });
  await frames(page);
  assert.equal(await popoverOf(page).count(), 0, `${what}: no editor before Comment`);
  assert.equal(await page.locator(".comment-pin.is-pending").count(), 0, `${what}: no provisional pin before Comment`);
  assert.equal(await page.evaluate(() => window.getSelection()?.toString()), selected, `${what}: selection preserved`);
  assert.ok(await page.evaluate((before) => document.activeElement === before && !document.activeElement?.matches(".comment-selection, .comment-popover textarea"), focus), `${what}: button does not steal focus`);
  const copied = await page.evaluate(() => {
    const selection = window.getSelection()!;
    const event = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    selection.anchorNode!.parentElement!.dispatchEvent(event);
    return { text: selection.toString(), prevented: event.defaultPrevented };
  });
  assert.deepEqual(copied, { text: selected, prevented: false }, `${what}: copying remains native`);
  await focus.dispose();
}

/** Clearing selection or Escape dismisses Comment without opening an editor or closing the viewer. */
async function dismissSelection(page: Page, escape = false): Promise<void> {
  if (escape) await page.keyboard.press("Escape");
  else await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.locator(".comment-selection").waitFor({ state: "detached" });
  assert.equal(await popoverOf(page).count(), 0, "dismissing Comment opens no editor");
  if (escape) await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

/** A plain click at `at` (client pixels): returns it with the body's scroll then. */
async function clickAt(page: Page, viewer: Locator, at: { x: number; y: number }): Promise<Pointed> {
  await page.mouse.click(at.x, at.y);
  return { ...at, scroll: await bodyScroll(viewer) };
}

/** How far a pin's tip may lie from the point it was made at: rounding, the fractions' four decimals. */
const TIP_SLACK_PX = 3;
/** `pin`'s tip (its square top left corner) lies within `TIP_SLACK_PX` of `at`, where that point is now that the body may have scrolled: polled. */
async function assertTipAt(viewer: Locator, pin: Locator, at: Pointed, what: string): Promise<void> {
  let seen: unknown = null;
  await eventually(`${what}: its pin's tip at (${at.x.toFixed(1)}, ${at.y.toFixed(1)})`, async () => {
    const box = await pin.boundingBox().catch(() => null);
    const y = at.y - ((await bodyScroll(viewer)) - at.scroll);
    seen = { box, want: { x: at.x, y } };
    return box !== null && Math.abs(box.x - at.x) <= TIP_SLACK_PX && Math.abs(box.y - y) <= TIP_SLACK_PX;
  }).catch((error: Error) => { throw new Error(`${error.message} (${JSON.stringify(seen)})`); });
}

/**
 * The popover beside its pin in `body` lies to the pin's right, 8px from it, its top level with the pin's top where
 * the body has room below for it; else shifted up just enough to end 8px above the body's visible bottom: polled.
 */
async function assertBesideRight(body: Locator, pin: Locator, what: string): Promise<void> {
  let seen: unknown = null;
  await eventually(`${what}: the popover right of its pin, top-aligned where there is room`, async () => {
    const pinBox = await pin.boundingBox().catch(() => null);
    const place = body.locator(".comment-popover-place");
    const box = await place.boundingBox().catch(() => null);
    const side = await place.getAttribute("data-side").catch(() => null);
    const bottom = await body.evaluate((node) => node.getBoundingClientRect().top + node.clientTop + node.clientHeight);
    seen = { pinBox, box, side, bottom };
    if (pinBox === null || box === null || side !== "right" || Math.abs(box.x - (pinBox.x + pinBox.width + 8)) > 1) return false;
    const room = bottom - 8 - pinBox.y >= box.height;
    return room ? Math.abs(box.y - pinBox.y) <= 1 : box.y < pinBox.y && Math.abs(box.y + box.height - (bottom - 8)) <= 1;
  }).catch((error: Error) => { throw new Error(`${error.message} (${JSON.stringify(seen)})`); });
}

/** The context and page of a case: the pane's chat, its reply drawn, with an empty comment store; `errors` collects the page's, `sent` the texts it submitted to the pane. */
interface Opened { page: Page; errors: string[]; sent: string[]; close: () => Promise<void> }

/**
 * A case: given the browser and the pane, it opens its own pages. `seed`: comments the pane's store
 * holds before the page first loads (as another session left them), else it starts empty.
 */
type Case = (open: (options: BrowserContextOptions, seed?: readonly object[]) => Promise<Opened>) => Promise<void>;

/** A stored comment on lines `first`–`last` of `file` (whose lines are `lines`), in `view`, as the viewer saves one on whole lines. */
function seededComment(id: string, file: string, label: string, view: "code" | "preview", lines: readonly string[], first: number, last: number, comment: string, created: number, quoteLines?: string[]): object {
  const source = lines.slice(first - 1, last);
  return { kind: "file", id, anchor: `file:${file}:${view}:${first}-${last}`, created, comment, path: file, label, view, lines: [first, last], source, quoteLines: quoteLines ?? source };
}

/** The viewer of `src/sync.ts`, opened from the reply's link (a tap on a touch screen), with its code drawn. */
async function openSync(page: Page, touch = false): Promise<Locator> {
  const link = page.getByRole("button", { name: "sync.ts", exact: true });
  if (touch) await link.tap();
  else await link.click();
  const viewer = page.getByRole("dialog", { name: "sync.ts", exact: true });
  await viewer.locator(`.file-viewer-text .hl-line[data-source-line="${SYNC_LINES.length}"]`).waitFor();
  return viewer;
}

/** The viewer of `docs/spec.md`, opened from the reply's link (a tap on a touch screen), with its preview drawn. */
async function openSpec(page: Page, touch = false): Promise<Locator> {
  const link = page.getByRole("button", { name: "spec.md", exact: true });
  if (touch) await link.tap();
  else await link.click();
  const viewer = page.getByRole("dialog", { name: "spec.md", exact: true });
  await viewer.locator(`.file-viewer-markdown .hl-line[data-source-line="${FOLD_HEAD_LAST}"]`).waitFor();
  return viewer;
}

/** The element of the preview in `viewer` that source line `n` starts (`data-source-line`). */
const previewLine = (viewer: Locator, n: number): Locator => viewer.locator(`.file-viewer-markdown [data-source-line="${n}"]`);

/** The file comments of the page's store, of every pane: what a send would quote, and whether each is on a selection (else on whole lines). */
const storedFileComments = (page: Page): Promise<{ lines: number[]; quoteLines: string[]; view: string; selected: boolean }[]> => page.evaluate(() => {
  const found: { lines: number[]; quoteLines: string[]; view: string; selected: boolean }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (!key.startsWith("herdr-web-ui:block-comments:")) continue;
    for (const comment of (JSON.parse(localStorage.getItem(key)!) as { comments: { kind?: string; lines: number[]; quoteLines: string[]; view: string; selection?: unknown }[] }).comments) {
      if (comment.kind === "file") found.push({ lines: comment.lines, quoteLines: comment.quoteLines, view: comment.view, selected: comment.selection !== undefined });
    }
  }
  return found;
});

/** Line `n` of the code in `viewer`. */
const lineOf = (viewer: Locator, n: number): Locator => viewer.locator(`.file-viewer-text .hl-line[data-source-line="${n}"]`);
/** The saved comments' pins in `scope` (a viewer, the chat), in reading order. */
const pinsIn = (scope: Locator): Locator => scope.locator(".comment-pin:not(.is-pending)");
/** The provisional pin of the comment being written in `scope`. */
const pendingPinIn = (scope: Locator): Locator => scope.locator(".comment-pin.is-pending");
/** The open comment's popover, wherever it is drawn. */
const popoverOf = (page: Page): Locator => page.locator(".comment-popover");
/** The popover beside its pin, inside `scope` (a viewer's body, the chat). */
const besidePinIn = (scope: Locator): Locator => scope.locator(".comment-popover");
/** The popover as a dialog of its own (the shared modal: a bottom sheet on a phone), portalled to the body. */
const dialogOf = (page: Page): Locator => page.locator(".modal-scrim > .modal.comment-popover");
const fieldOf = (page: Page): Locator => popoverOf(page).getByRole("textbox", { name: "Comment", exact: true });
/** Whether the focused element matches `selector`. */
const focusedMatches = (page: Page, selector: string): Promise<boolean> => page.evaluate((wanted) => document.activeElement?.matches(wanted) ?? false, selector);
/** Waits for an opened popover's field to take the focus (it does as the popover mounts): Escape is the popover's from there. */
const fieldFocused = (page: Page): Promise<void> => eventually("the popover's field to take the focus", () => focusedMatches(page, ".comment-popover textarea"));
/** A reference's text as read (`FileReferenceLabel`: the stem, then the extension and the lines). */
const referenceText = (reference: Locator): Promise<string | null> => reference.evaluate((node) => node.textContent);
/** The open popover's file reference, as read. */
const popoverReference = (page: Page): Promise<string | null> => referenceText(popoverOf(page).locator(".comment-file-reference"));

/** Writes `text` in the open popover's field and saves it with Ctrl+Enter; returns once the popover is gone. */
async function saveTyped(page: Page, text: string): Promise<void> {
  await fieldFocused(page);
  await fieldOf(page).fill(text);
  await page.keyboard.press("Control+Enter");
  await popoverOf(page).waitFor({ state: "detached" });
}

/** Closes an untouched popover by Escape (its field, or its box where the field did not take the focus, has it). */
async function escapePopover(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await popoverOf(page).waitFor({ state: "detached" });
}

/**
 * Where the pin matching `pin` in `scope` lies against the end of the element `line`'s own text (its last line on
 * screen): `dx` from that end to the pin's tip (its square top left corner), `dy` from the line's middle.
 */
const pinAgainstLine = (scope: Locator, pin: string, line: string): Promise<{ dx: number; dy: number } | null> => scope.evaluate((node, wanted) => {
  const found = node.querySelector(wanted.pin);
  const element = node.querySelector(wanted.line);
  if (found === null || element === null) return null;
  const range = document.createRange();
  range.selectNodeContents(element);
  const last = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).at(-1);
  if (last === undefined) return null;
  const box = found.getBoundingClientRect();
  return { dx: box.left - last.right, dy: box.top - (last.top + last.height / 2) };
}, { pin, line });
/** How far right of the end of its text a pin's tip may be: its gap (4px), and a little for rounding. */
const PIN_REACH_PX = 8;
/**
 * Polls until the pin matching `pin` in `scope`, one without a point (a selection's made with the keyboard, a triple
 * click or a finger, or a stored one from before points), has its tip within `PIN_REACH_PX` right of the end of
 * `line`'s text, at that line's middle.
 */
async function assertPinAtLineEnd(scope: Locator, pin: string, line: string, what: string): Promise<void> {
  let seen: { dx: number; dy: number } | null = null;
  await eventually(`${what}: the pin's tip within ${PIN_REACH_PX}px right of its line's end, at its middle`, async () => {
    seen = await pinAgainstLine(scope, pin, line);
    return seen !== null && seen.dx >= 0 && seen.dx <= PIN_REACH_PX && Math.abs(seen.dy) <= 2;
  }).catch((error: Error) => { throw new Error(`${error.message} (offset ${JSON.stringify(seen)})`); });
}

/** Whether the element matching `selector` is inside the viewer's body on screen (1px of slack). */
const inBody = (viewer: Locator, selector: string): Promise<boolean> => viewer.evaluate((node, wanted) => {
  const found = node.querySelector(wanted);
  const body = node.querySelector(".file-viewer-body");
  if (found === null || body === null) return false;
  const box = found.getBoundingClientRect();
  const outer = body.getBoundingClientRect();
  return box.height > 0 && box.top >= outer.top - 1 && box.bottom <= outer.bottom + 1;
}, selector);

/**
 * A point on the element `element` (a code line, a preview element), in client pixels, scrolled into the viewer's
 * middle first: on its text near the start, or (`atNumber`, a code line) in its number's gutter.
 */
const pointOn = (element: Locator, atNumber = false): Promise<{ x: number; y: number }> => element.evaluate((node, gutter) => {
  node.scrollIntoView({ block: "center" });
  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = [...range.getClientRects()].find((found) => found.width > 0 && found.height > 0)!;
  if (!gutter) return { x: rect.left + Math.min(rect.width, 40) / 2, y: rect.top + rect.height / 2 };
  const code = node.closest("code")!;
  const box = code.getBoundingClientRect();
  const start = box.left + code.clientLeft + parseFloat(getComputedStyle(code).paddingInlineStart);
  return { x: (box.left + start) / 2, y: rect.top + rect.height / 2 };
}, atNumber);

/** The composer's comments bar above the message box, and its text, which walks to them. */
const walkOf = (page: Page): Locator => page.locator(".composer-surface > .composer-comments-bar button.composer-comments-walk");

/** What the open popover's field holds (a saved comment opens in it), or null while none is open. */
const popoverText = async (page: Page): Promise<string | null> => {
  const field = fieldOf(page);
  return (await field.count()) === 1 ? field.inputValue() : null;
};
/** The open popover's Delete (a saved comment's, beside ↑), and its ✕ (a dialog's and a sheet's only). */
const deleteOf = (page: Page): Locator => popoverOf(page).getByRole("button", { name: "Delete comment", exact: true });
const closeOf = (page: Page): Locator => popoverOf(page).getByRole("button", { name: "Close", exact: true });
/** The text up on `surface` (a viewer's body, the chat): what the active and current highlights hold there, and whether it is in focus mode. */
const upIn = (surface: Locator): Promise<{ text: string; focus: boolean }> => surface.evaluate((node) => {
  const registry = (CSS as unknown as { highlights: { get(key: string): Iterable<Range> | undefined } }).highlights;
  const ranges = [...(registry.get("block-comment-active") ?? []), ...(registry.get("block-comment-current") ?? [])].filter((range) => node.contains(range.commonAncestorContainer));
  return { text: ranges.map((range) => range.toString()).join("\n"), focus: node.hasAttribute("data-comment-focus") };
});
/** Polls until the text up on `surface` includes `text`, the surface in focus mode. */
async function assertUp(surface: Locator, text: string, what: string): Promise<void> {
  let seen: unknown = null;
  await eventually(`${what}: its text up, in focus mode`, async () => {
    const up = await upIn(surface);
    seen = up;
    return up.text.includes(text) && up.focus;
  }).catch((error: Error) => { throw new Error(`${error.message} (${JSON.stringify(seen)})`); });
}
/** The computed value of `--accent-tint` as a background color, to compare a hovered line's with. */
const accentTint = (page: Page): Promise<string> => page.evaluate(() => {
  const probe = document.createElement("span");
  probe.style.background = "var(--accent-tint)";
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
});
/** The center of the first `word` in `element`'s text, in client pixels. */
const wordPoint = (element: Locator, word: string): Promise<{ x: number; y: number }> => element.evaluate((node, wanted) => {
  node.scrollIntoView({ block: "center" });
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const at = (next as Text).data.indexOf(wanted);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(next, at);
    range.setEnd(next, at + wanted.length);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  throw new Error(`"${wanted}" is not in the element`);
}, word);

const cases: Record<string, Case> = {
  /** The chat's comment flow: the pins, the popover and the highlights it shares with the viewer. */
  async chat(open) {
    const { page, errors, close } = await open(DESKTOP);
    const chat = page.locator(".chat-view");
    const paragraph = page.locator(".chat-view p.is-commentable", { hasText: REPLY });
    // a keyboard selection offers Comment; a mouse's drag over the same text is explicitly activated
    await selectText(paragraph, "every revision", paragraph, "in order");
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a keyboard selection opens nothing");
    await assertSelectionButton(page, "a keyboard selection in the chat");
    await dismissSelection(page);
    await dragText(page, null, paragraph, "every revision", paragraph, "in order");
    await besidePinIn(chat).waitFor();
    await pendingPinIn(chat).waitFor();
    await assertNoButton(page, "a drag in the chat");
    await saveTyped(page, "Say which order.");
    await eventually("its pin", async () => (await pinsIn(chat).count()) === 1);
    await eventually("the comment's text to be highlighted", async () => (await highlighted(page)) > 0);
    console.log("PASS chat: a keyboard selection offers Comment without an editor; Comment on a mouse's drag opens the popover beside a provisional pin; Ctrl+Enter saves it as a pin, highlighted");

    // its pin opens it straight into its field, its text up; Escape on the untouched field closes it
    await pinsIn(chat).click();
    await besidePinIn(chat).waitFor();
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "Say which order.", "the pin opens the field with the comment");
    await page.mouse.move(2, 2);
    await assertUp(chat, "every revision in order", "the chat's comment opened by its pin");
    await escapePopover(page);
    console.log("PASS chat: the pin opens the comment in its field, its text up; Escape on the untouched field closes it");

    const walk = walkOf(page);
    await walk.waitFor();
    assert.equal(await walk.getAttribute("aria-label"), "1 comment on the reply");
    await walk.click();
    await eventually("the walk to open the pin's popover", async () => (await popoverText(page)) === "Say which order.");
    assert.ok(await pinsIn(chat).evaluate((pin) => pin.classList.contains("is-current")), "the walk marks the pin");
    console.log("PASS chat: with one comment the composer bar shows, and its walk opens the pin's popover");

    await deleteOf(page).click();
    await eventually("the pin to go", async () => (await pinsIn(chat).count()) === 0);
    await walk.waitFor({ state: "detached" });
    await eventually("the highlight to go", async () => (await highlighted(page)) === 0);
    console.log("PASS chat: Delete beside ↑ removes the pin, its highlight and the bar");
    assert.deepEqual(errors, []);
    await close();
  },

  /** Desktop code: triple click, keyboard and drag selections offer Comment; activation, pins, copying and Escape. */
  async code(open) {
    const { page, errors, close } = await open(DESKTOP);
    const viewer = await openSync(page);
    const body = viewer.locator(".file-viewer-body");
    const filePath = await viewer.locator(".file-viewer-meta").getAttribute("title");
    assert.ok(filePath?.endsWith("/src/sync.ts"), `the viewer names the file's path: ${filePath}`);
    assert.equal(await viewer.locator(".file-viewer-body[data-comment-surface][data-comments]").count(), 1, "the body is a comment surface, comments on");

    // 1. triple click and keyboard selections offer Comment without an editor, preserving native copy.
    // No "+" in the gutter
    await lineOf(viewer, 8).hover();
    assert.equal(await viewer.locator(".file-comment-add").count(), 0, "no + beside the hovered line");
    await lineOf(viewer, 8).click({ clickCount: 3 });
    await frames(page, 10);
    assert.ok((await page.evaluate(() => window.getSelection()?.toString() ?? "")).includes(SYNC_LINES[7]!.trim()), "the triple click selects line 8");
    assert.equal(await popoverOf(page).count(), 0, "a triple click opens nothing");
    await assertSelectionButton(page, "a triple click on a code line");
    await dismissSelection(page);
    await selectText(lineOf(viewer, 8), "if", lineOf(viewer, 8), "{");
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a keyboard selection opens nothing");
    await assertSelectionButton(page, "a keyboard selection in the code");
    await dismissSelection(page, true);
    assert.ok(await viewer.isVisible(), "Escape dismisses Comment without closing the viewer");
    // a mouse's drag over line 8 offers Comment; the helper activates it
    const release8 = await dragText(page, viewer, lineOf(viewer, 8), "if", lineOf(viewer, 8), "{");
    await besidePinIn(body).waitFor();
    await pendingPinIn(body).waitFor();
    await assertNoButton(page, "a drag over a code line");
    assert.equal(await popoverReference(page), "sync.ts · Line 8");
    assert.equal(await popoverOf(page).locator(".comment-file-reference").getAttribute("title"), filePath);
    assert.equal(await popoverOf(page).locator(".comment-popover-quote").count(), 0, "beside its pin the popover quotes nothing");
    assert.equal((await highlightText(page)).replace(/\s+/g, " ").trim(), (SYNC_LINES[7]).replace(/\s+/g, " ").trim(), "the quote is line 8");
    assert.ok(await popoverOf(page).getByRole("button", { name: "Start dictation", exact: true }).isVisible(), "the desktop comment microphone is shown by default, even when unavailable");
    console.log("PASS code: no + beside a line; triple-click and keyboard selections offer Comment without an editor; activating a drag's Comment opens the popover beside a provisional pin, naming sync.ts · Line 8");

    // 2. saved: a pin where the drag let go, its text highlighted; no card
    await saveTyped(page, "Compare with <=.");
    await eventually("its pin", async () => (await pinsIn(body).count()) === 1);
    assert.equal(await viewer.locator(".file-viewer-text > code > :not(.hl-line)").count(), 0, "nothing but the lines in the code: no card between them");
    await assertTipAt(viewer, pinsIn(body), release8, "line 8's comment");
    await eventually("line 8 to be highlighted", async () => (await highlighted(page)) > 0);
    const before = await highlighted(page);
    console.log("PASS code: Ctrl+Enter saves it: a pin whose tip is where the drag let go on line 8, its text highlighted, no card");

    // 3. Comment on a drag over several lines opens the editor beside a provisional pin at the release point
    const release = await dragText(page, viewer, lineOf(viewer, 7), "await", lineOf(viewer, 9), "return");
    await besidePinIn(body).waitFor();
    await pendingPinIn(body).waitFor();
    await fieldFocused(page);
    await assertNoButton(page, "a drag over lines 7–9");
    assert.equal(await popoverReference(page), "sync.ts · Lines 7–9");
    await assertTipAt(viewer, pendingPinIn(body), release, "the provisional pin of a dragged selection");
    await assertBesideRight(body, pendingPinIn(body), "a dragged selection's new comment");
    await saveTyped(page, "Range note");
    await eventually("both pins", async () => (await pinsIn(body).count()) === 2);
    const rangePin = '.comment-pin[aria-label$=": Range note"]';
    await assertTipAt(viewer, body.locator(rangePin), release, "lines 7–9's comment");
    await eventually("the selection to be highlighted too", async () => (await highlighted(page)) > before);
    await body.locator(rangePin).click();
    await besidePinIn(body).waitFor();
    await fieldFocused(page);
    assert.equal(await popoverText(page), "Range note", "the pin opens the comment in its field");
    assert.equal(await popoverReference(page), "sync.ts · Lines 7–9", "a file comment keeps its reference line");
    assert.equal(await popoverOf(page).locator(".comment-popover-quote").count(), 0, "beside its pin it quotes nothing");
    assert.equal(await closeOf(page).count(), 0, "no ✕ beside its pin");
    assert.equal(await deleteOf(page).count(), 1, "its Delete is in view");
    await assertBesideRight(body, body.locator(rangePin), "the dragged selection's comment opened by its pin");
    // its text stays up while the field has the focus, the pointer off the pin; line 8's comment goes (focus mode)
    await page.mouse.move(2, 2);
    await assertUp(body, "return", "the comment on lines 7–9 opened by its pin");
    await escapePopover(page);
    console.log("PASS code: Comment on a mouse's drag over lines 7–9 opens the popover, right of a provisional pin whose tip is where it let go; saved, the pin stays there, highlighted; the pin opens it in its field, its text up");

    // 4. a copy over the commented lines is the browser's own: the code alone, nothing of the pins
    const copied = await lineOf(viewer, 6).evaluate((first) => {
      const last = first.closest("code")!.querySelector('.hl-line[data-source-line="10"]')!;
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.childNodes.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const event = new ClipboardEvent("copy", { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
      first.dispatchEvent(event);
      return { text: selection.toString(), prevented: event.defaultPrevented };
    });
    assert.equal(copied.prevented, false, "the viewer leaves the copy to the browser");
    assert.equal(copied.text, SYNC_LINES.slice(5, 10).join("\n"), "the selection is lines 6–10 exactly");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    console.log("PASS code: a selection over lines 6–10 and their pins is the five source lines exactly, copied by the browser");

    // 5. Escape: an untouched popover first, then the viewer; a popover with text typed keeps both
    // a click on line 3: a new comment on all of it
    await clickAt(page, viewer, await pointOn(lineOf(viewer, 3)));
    await fieldFocused(page);
    await escapePopover(page);
    assert.ok(await viewer.isVisible(), "the viewer stays while Escape closes the popover");
    const at3 = await pointOn(lineOf(viewer, 3));
    await page.mouse.click(at3.x, at3.y);
    await besidePinIn(body).waitFor();
    assert.equal(await popoverReference(page), "sync.ts · Line 3");
    await fieldFocused(page);
    await fieldOf(page).fill("Keep this");
    await page.keyboard.press("Escape");
    await frames(page);
    assert.ok(await viewer.isVisible(), "Escape with text typed leaves the viewer open");
    assert.equal(await popoverOf(page).count(), 1, "and the popover");
    assert.equal(await fieldOf(page).inputValue(), "Keep this", "and the text typed");
    console.log("PASS code: with text typed in a popover, Escape closes neither the popover nor the viewer, and the text stays");
    await fieldOf(page).fill("");
    await escapePopover(page);
    assert.ok(await viewer.isVisible(), "the viewer stays while Escape closes the emptied popover");
    await body.locator(rangePin).click();
    await besidePinIn(body).waitFor();
    await fieldFocused(page);
    await escapePopover(page);
    assert.ok(await viewer.isVisible(), "the viewer stays while Escape closes an unchanged saved comment");
    console.log("PASS code: Escape closes an emptied popover, or an unchanged saved comment, and the viewer stays");

    // a saved comment changed: Escape and a click outside keep it, the focus back in its field; unchanged again, a click
    // outside closes it
    await body.locator(rangePin).click();
    await fieldFocused(page);
    await page.keyboard.type(", checked");
    await page.keyboard.press("Escape");
    await frames(page);
    assert.equal(await popoverOf(page).count(), 1, "Escape keeps a changed comment");
    assert.ok(await viewer.isVisible(), "and the viewer");
    // the viewer's header line: outside the popover, and no line to comment on
    const outside = viewer.locator(".file-viewer-meta");
    await outside.click();
    await frames(page);
    assert.equal(await popoverOf(page).count(), 1, "a click outside keeps a changed comment");
    assert.ok(await focusedMatches(page, ".comment-popover textarea"), "and puts the focus back in its field");
    assert.equal(await popoverText(page), "Range note, checked");
    await assertUp(body, "return", "a changed comment kept open");
    await fieldOf(page).fill("Range note");
    await outside.click();
    await popoverOf(page).waitFor({ state: "detached" });
    assert.ok(await viewer.isVisible(), "the viewer stays");
    console.log("PASS code: a changed saved comment stays on Escape and a click outside, the focus back in its field; unchanged, a click outside closes it");

    // the focus elsewhere in the viewer (its Raw link) while a popover is open: Escape is the popover's first
    const raw = viewer.getByRole("link", { name: "Raw", exact: true });
    await body.locator(rangePin).click();
    await besidePinIn(body).waitFor();
    await fieldFocused(page);
    await raw.focus();
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    assert.ok(await viewer.isVisible(), "the viewer stays while Escape closes an unchanged saved comment, the focus elsewhere");
    // a click on line 3: a new comment on all of it
    await clickAt(page, viewer, await pointOn(lineOf(viewer, 3)));
    await fieldFocused(page);
    await fieldOf(page).fill("Keep this too");
    await raw.focus();
    await page.keyboard.press("Escape");
    await frames(page);
    assert.ok(await viewer.isVisible(), "Escape with text typed, the focus elsewhere, leaves the viewer open");
    assert.equal(await fieldOf(page).inputValue(), "Keep this too", "and the popover with its text");
    await fieldFocused(page);
    await fieldOf(page).fill("");
    await escapePopover(page);
    await raw.focus();
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    console.log("PASS code: with the focus elsewhere in the viewer, Escape closes an unchanged comment and keeps one with text typed (its field taking the focus back), the viewer staying; with no popover a further Escape closes the viewer");
    assert.deepEqual(errors, []);
    await close();
  },

  /** A click on a line of the code view comments on that line. */
  async "code-click"(open) {
    const { page, errors, close } = await open(DESKTOP);
    let viewer = await openSync(page);
    let body = viewer.locator(".file-viewer-body");
    // a pointer over a line tints it
    let at8 = await pointOn(lineOf(viewer, 8));
    await page.mouse.move(at8.x, at8.y);
    const tint = await accentTint(page);
    await eventually("the hovered line to take the accent's tint", async () => (await lineOf(viewer, 8).evaluate((line) => getComputedStyle(line).backgroundColor)) === tint);
    const clicked8 = await clickAt(page, viewer, at8);
    await besidePinIn(body).waitFor();
    await pendingPinIn(body).waitFor();
    assert.equal(await popoverReference(page), "sync.ts · Line 8");
    assert.equal(await popoverOf(page).locator(".comment-popover-quote").count(), 0, "beside its pin the popover quotes nothing");
    assert.equal((await highlightText(page)).replace(/\s+/g, " ").trim(), (SYNC_LINES[7]).replace(/\s+/g, " ").trim(), "the quote is line 8");
    await assertTipAt(viewer, pendingPinIn(body), clicked8, "the provisional pin of a clicked line");
    await assertBesideRight(body, pendingPinIn(body), "a clicked line's new comment");
    await saveTyped(page, "Click note");
    await eventually("its pin", async () => (await pinsIn(body).count()) === 1);
    await assertTipAt(viewer, pinsIn(body), clicked8, "the clicked line's comment");
    await eventually("line 8 to be marked commented", () => lineOf(viewer, 8).evaluate((line) => line.classList.contains("is-commented")));
    assert.deepEqual(await storedFileComments(page), [{ lines: [8, 8], quoteLines: [SYNC_LINES[7]], view: "code", selected: false }], "a comment on the whole line");
    console.log("PASS code-click: a pointer over line 8 tints it; a click opens a popover quoting it, right of a provisional pin whose tip is where it was clicked; saved, its pin stays there and the line is is-commented");

    // a click on the line again opens its comment to edit
    at8 = await wordPoint(lineOf(viewer, 8), "revision");
    await page.mouse.click(at8.x, at8.y);
    await besidePinIn(body).waitFor();
    await fieldFocused(page);
    assert.equal(await popoverText(page), "Click note", "in its field");
    await assertTipAt(viewer, pinsIn(body), clicked8, "a line clicked again elsewhere: its pin where it was first put");
    await assertUp(body, "revision", "a commented line clicked again");
    await escapePopover(page);
    console.log("PASS code-click: a click on a commented line opens its comment in its field, its text up");

    // with a popover open, a click outside it only closes it: a click on another line opens nothing there, the next click
    // does; a drag that starts with it opens its selection's comment
    const closedOnly = async (what: string): Promise<void> => {
      await popoverOf(page).waitFor({ state: "detached" });
      await frames(page, 10);
      assert.equal(await popoverOf(page).count(), 0, `${what}: no popover opens`);
      assert.equal(await pendingPinIn(body).count(), 0, `${what}: no provisional pin`);
    };
    await clickAt(page, viewer, await pointOn(lineOf(viewer, 5)));
    await fieldFocused(page);
    // at the line's start: left of the popover, which lies right of its pin
    const at11 = await pointOn(lineOf(viewer, 11));
    await page.mouse.click(at11.x, at11.y);
    await closedOnly("a click on another line with a new comment open");
    await page.mouse.click(at11.x, at11.y);
    await besidePinIn(body).waitFor();
    assert.equal(await popoverReference(page), "sync.ts · Line 11", "the next click opens a comment on the line");
    await pinsIn(body).click();
    await fieldFocused(page);
    assert.equal(await popoverText(page), "Click note", "a press on a pin switches straight to its comment");
    await page.mouse.click(at11.x, at11.y);
    await closedOnly("a click on another line with a saved comment open");
    await clickAt(page, viewer, await pointOn(lineOf(viewer, 5)));
    await fieldFocused(page);
    // a drag that starts while a popover is open closes it and offers Comment for the selection
    await dragText(page, viewer, lineOf(viewer, 11), "await", lineOf(viewer, 11), "incoming");
    await besidePinIn(body).waitFor();
    await fieldFocused(page);
    assert.equal(await popoverOf(page).count(), 1, "one popover: the drag's");
    assert.equal(await popoverReference(page), "sync.ts · Line 11", "the drag opens a comment on its selection");
    await escapePopover(page);
    console.log("PASS code-click: with a popover open (new or saved), a click on another line only closes it, nothing opens, and the next click opens a comment; a drag closes it and Comment opens its selection's editor; a press on a pin switches to its comment");

    // a double click on a word selects it, and leaves no popover
    const store = await wordPoint(lineOf(viewer, 11), "store");
    await page.mouse.dblclick(store.x, store.y);
    await frames(page);
    assert.equal(await popoverOf(page).count(), 0, "no popover after a double click");
    assert.equal(await pendingPinIn(body).count(), 0);
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "store", "the word is selected");
    // the selected word remains available to copy; Comment is offered without opening an editor
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a double click's word selection opens no comment");
    await assertSelectionButton(page, "a double click's word selection");
    await dismissSelection(page, true);
    assert.ok(await viewer.isVisible(), "Escape dismisses the word's Comment action, not the viewer");
    console.log("PASS code-click: a double click selects a word and offers Comment without an editor; Escape dismisses the action and keeps the viewer");

    // Delete, in view beside ↑, takes the pin, the highlight and the line's mark
    await pinsIn(body).click();
    await besidePinIn(body).waitFor();
    await deleteOf(page).click();
    await eventually("the pin to go", async () => (await pinsIn(body).count()) === 0);
    await eventually("the line's mark to go", async () => !(await lineOf(viewer, 8).evaluate((line) => line.classList.contains("is-commented"))));
    await eventually("the highlight to go", async () => (await highlighted(page)) === 0);
    assert.ok(await viewer.isVisible());
    console.log("PASS code-click: Delete removes the pin, the highlight and the line's mark");

    // in a file cut short, a whole line takes a click; one cut off at the load limit (here the file's only line) none
    await viewer.getByRole("button", { name: "Close file", exact: true }).click();
    await viewer.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "big.txt", exact: true }).click();
    viewer = page.getByRole("dialog", { name: "big.txt", exact: true });
    body = viewer.locator(".file-viewer-body");
    const last = viewer.locator(".file-viewer-text .hl-line").last();
    await last.waitFor();
    const whole = await last.getAttribute("data-source-line");
    const atLast = await pointOn(last);
    await page.mouse.click(atLast.x, atLast.y);
    await besidePinIn(body).waitFor();
    assert.equal(await popoverReference(page), `big.txt · Line ${whole}`, "the last whole line of a file cut short takes a click");
    await fieldFocused(page);
    await escapePopover(page);
    await viewer.getByRole("button", { name: "Close file", exact: true }).click();
    await viewer.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "long.txt", exact: true }).click();
    viewer = page.getByRole("dialog", { name: "long.txt", exact: true });
    const cut = lineOf(viewer, 1);
    await cut.waitFor();
    assert.equal(await viewer.locator(".file-viewer-meta .file-viewer-notice").count(), 1, "long.txt opens cut short");
    assert.equal(await viewer.locator(".file-viewer-body[data-comments]").count(), 1, "it takes comments, on its whole lines");
    const atCut = await pointOn(cut);
    await page.mouse.click(atCut.x, atCut.y);
    await frames(page);
    assert.equal(await popoverOf(page).count(), 0, "a click on the cut-off line opens nothing");
    console.log("PASS code-click: in a file cut short the last whole line takes a click; a line cut off at the load limit opens nothing");

    // the code view without wrapping scrolls sideways inside the viewer's body: a pin follows its line as it does, and has
    // none while the line is scrolled wholly out of view, never left where it was, over other text
    await viewer.getByRole("button", { name: "Close file", exact: true }).click();
    await viewer.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "wide.ts", exact: true }).click();
    viewer = page.getByRole("dialog", { name: "wide.ts", exact: true });
    body = viewer.locator(".file-viewer-body");
    await lineOf(viewer, WIDE_LINES.length).waitFor();
    const code = viewer.locator("pre.file-viewer-text");
    const sideways = await code.evaluate((node) => node.scrollWidth - node.clientWidth);
    assert.ok(sideways > 400, `the code view scrolls sideways (${sideways}px)`);
    // clicked near its end, so its point stays in view while the code scrolls a little sideways
    const at2 = await clickAt(page, viewer, await wordPoint(lineOf(viewer, 2), "view"));
    await saveTyped(page, "Wide note");
    await eventually("its pin", async () => (await pinsIn(body).count()) === 1);
    await assertTipAt(viewer, pinsIn(body), at2, "line 2's comment");
    const pinX = (): Promise<number> => pinsIn(body).evaluate((pin) => pin.getBoundingClientRect().left);
    const start = await pinX();
    await code.evaluate((node) => { node.scrollLeft = 120; });
    await eventually("the pin to follow its line sideways", async () => (await pinsIn(body).count()) === 1 && Math.abs((await pinX()) - (start - 120)) <= 2);
    console.log("PASS code-click: the code view scrolled sideways, a pin follows the point of its line it was made at");

    // its popover open beside it: the popover follows the pin, placed against it as on opening
    await pinsIn(body).click();
    await besidePinIn(body).waitFor();
    /**
     * How far the popover lies from where it is placed beside its pin (`besidePlace`: right of it, a gap of 8px,
     * top-aligned, or shifted up to end 8px above the body's visible bottom where it has no room below). This file's
     * body is shorter than the popover: there it only has to reach the pin from above and below.
     */
    const offPlace = (): Promise<number> => viewer.evaluate((node) => {
      const surface = node.querySelector(".file-viewer-body")!;
      const pin = surface.querySelector(".comment-pin:not(.is-pending)")!.getBoundingClientRect();
      const place = surface.querySelector<HTMLElement>(".comment-popover-place")!;
      const popover = place.getBoundingClientRect();
      const bottom = surface.getBoundingClientRect().top + surface.clientTop + surface.clientHeight - 8;
      const top = Math.max(Math.min(pin.top, bottom - popover.height), pin.bottom - popover.height);
      const level = popover.height + 16 > surface.clientHeight
        ? (popover.top <= pin.top + 1 && popover.bottom >= pin.bottom - 1 ? 0 : Infinity)
        : Math.abs(popover.top - top);
      return place.dataset.side !== "right" ? Infinity : Math.max(Math.abs(popover.left - (pin.right + 8)), level);
    });
    assert.ok((await offPlace()) <= 2, "the popover is placed against its pin");
    await code.evaluate((node) => { node.scrollLeft = 40; });
    await eventually("the pin to follow its line back", async () => Math.abs((await pinX()) - (start - 40)) <= 2);
    await eventually("the popover to follow its pin", async () => (await offPlace()) <= 2);

    // line 2 scrolled wholly out of view: its pin goes, and the popover stays where it was rather than becoming a dialog
    await code.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    await eventually("the pin to go while its line is out of view", async () => (await pinsIn(body).count()) === 0);
    assert.ok(await lineOf(viewer, 2).evaluate((line) => {
      const pre = line.closest("pre")!;
      const range = document.createRange();
      range.selectNodeContents(line);
      const last = [...range.getClientRects()].filter((rect) => rect.width > 0).at(-1)!;
      return last.right <= pre.getBoundingClientRect().left + pre.clientLeft;
    }), "line 2 is scrolled wholly out of view");
    assert.equal(await besidePinIn(body).count(), 1, "the open popover stays beside the place it was opened at");
    assert.equal(await dialogOf(page).count(), 0, "and does not become a dialog");
    await escapePopover(page);
    await code.evaluate((node) => { node.scrollLeft = 0; });
    await eventually("the pin back on its line", async () => (await pinsIn(body).count()) === 1 && Math.abs((await pinX()) - start) <= 2);
    console.log("PASS code-click: its popover follows the pin; with the line scrolled wholly out of view the pin goes (the popover stays put), and comes back with the line");
    assert.deepEqual(errors, []);
    await close();
  },

  /** Phone code: line taps and explicit Comment activation open the sheet; touch selection and Copy file stay native. */
  async "code-phone"(open) {
    const { page, errors, close } = await open(PHONE);
    assert.ok(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "the phone's pointer is coarse");
    const viewer = await openSync(page, true);
    // a tap on a line, on its number too, opens the sheet for that line
    const number = await pointOn(lineOf(viewer, 3), true);
    await page.touchscreen.tap(number.x, number.y);
    await dialogOf(page).waitFor();
    assert.equal(await besidePinIn(viewer).count(), 0, "on a phone the popover is the sheet");
    assert.equal(await popoverReference(page), "sync.ts · Line 3");
    await fieldFocused(page);
    assert.ok(await dialogOf(page).getByRole("button", { name: "Start dictation", exact: true }).isVisible(), "the mobile comment microphone is shown by default, even when unavailable");
    await fieldOf(page).fill("Phone note");
    await dialogOf(page).getByRole("button", { name: "Save comment", exact: true }).tap();
    await dialogOf(page).waitFor({ state: "detached" });
    await eventually("its pin", async () => (await pinsIn(viewer).count()) === 1);
    console.log("PASS code-phone: a tap on a line's number opens the sheet for Line 3; saved, its pin");

    // its pin tapped: the sheet with the comment in its field, which does not take the focus (no keyboard rises), with
    // its reference, quote, ✕ and Delete; its text up. A keyboard's Tab and Shift+Tab stay in it
    await pinsIn(viewer).tap();
    await dialogOf(page).waitFor();
    await eventually("the sheet to hold the focus", () => focusedMatches(page, ".modal.comment-popover"));
    await frames(page);
    assert.ok(await focusedMatches(page, ".modal.comment-popover"), "the sheet, not its field, keeps the focus");
    assert.equal(await popoverText(page), "Phone note", "the field holds the comment");
    assert.equal(await popoverReference(page), "sync.ts · Line 3");
    assert.equal(await dialogOf(page).locator("pre.comment-popover-plain").textContent(), SYNC_LINES[2], "the sheet quotes line 3");
    assert.equal(await closeOf(page).count(), 1, "the sheet keeps ✕");
    const bin = await deleteOf(page).boundingBox();
    assert.ok(bin !== null && bin.width >= 40 && bin.height >= 40, `Delete is in view, a full touch target (${JSON.stringify(bin)})`);
    await assertUp(viewer.locator(".file-viewer-body"), SYNC_LINES[2]!.slice(0, 20), "a pin tapped open on a phone");
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      assert.ok(await page.evaluate(() => document.querySelector(".modal.comment-popover")?.contains(document.activeElement) ?? false), `${key} keeps the focus in the sheet`);
    }
    await closeOf(page).tap();
    await dialogOf(page).waitFor({ state: "detached" });
    console.log("PASS code-phone: a pin tapped opens the sheet with its comment in the field, unfocused (no keyboard), quoting Line 3, with ✕ and Delete, its text up; Tab stays in it");
    const code = viewer.locator(".file-viewer-text");
    assert.notEqual(await code.evaluate((pre) => getComputedStyle(pre).userSelect), "none", "the code takes a selection on a touch screen");
    // text selected (as a long press and its handles leave it) offers Comment without opening the sheet
    await selectText(lineOf(viewer, 8), "if", lineOf(viewer, 8), "revision");
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a touch selection opens nothing");
    await assertSelectionButton(page, "a touch selection in the code");
    await selectionButtonOf(page).tap();
    await dialogOf(page).waitFor();
    assert.equal(await popoverReference(page), "sync.ts · Line 8");
    await fieldFocused(page);
    await dialogOf(page).getByRole("button", { name: "Close", exact: true }).tap();
    await dialogOf(page).waitFor({ state: "detached" });
    console.log("PASS code-phone: a touch selection in the code preserves copy and focus; tapping Comment opens the sheet for Line 8");

    const copyButton = viewer.getByRole("button", { name: /^(Copy file|File copied)$/ });
    await page.evaluate(() => {
      const target = window as unknown as { copiedText: string | null };
      target.copiedText = null;
      Object.defineProperty(navigator, "clipboard", { value: { writeText: (value: string) => { target.copiedText = value; return Promise.resolve(); } }, configurable: true });
    });
    await copyButton.tap();
    await eventually("Copy file to copy the file", () => page.evaluate((whole) => (window as unknown as { copiedText: string | null }).copiedText === whole, `${SYNC_LINES.join("\n")}\n`));
    // When both clipboard paths refuse, Copy selects the code for a manual copy.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("no clipboard")) }, configurable: true });
      Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
    });
    await copyButton.tap();
    await eventually("Copy file to select the source", () => page.evaluate((whole) => window.getSelection()?.toString() === whole, SYNC_LINES.join("\n")));
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    assert.equal(await popoverOf(page).count(), 0, "Copy file opens no comment");
    console.log("PASS code-phone: Copy file copies the whole file; when both clipboard paths refuse it selects the source");

    // a file cut short takes comments too, and a viewer without a pane none
    await viewer.getByRole("button", { name: "Close file", exact: true }).tap();
    await viewer.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "big.txt", exact: true }).tap();
    const big = page.getByRole("dialog", { name: "big.txt", exact: true });
    await big.locator(".file-viewer-text .hl-line").first().waitFor();
    assert.equal(await big.locator(".file-viewer-meta .file-viewer-notice").count(), 1, "big.txt opens cut short");
    assert.equal(await big.locator(".file-viewer-body[data-comment-surface]").count(), 1, "a file cut short takes comments");
    await big.getByRole("button", { name: "Close file", exact: true }).tap();
    await big.waitFor({ state: "detached" });
    // as the app opens a file with no pane selected (App.tsx `viewFile`): the preview's history entry, read on load
    await page.evaluate((path) => history.replaceState({ ...history.state, "herdr-web-ui:file-preview": { path, paneId: null, machineId: "local" } }, ""), join(root, "src", "sync.ts"));
    await page.reload();
    const paneless = page.getByRole("dialog", { name: "sync.ts", exact: true });
    await paneless.locator(`.file-viewer-text .hl-line:nth-of-type(${SYNC_LINES.length})`).waitFor();
    assert.equal(await paneless.locator(".file-viewer-body[data-comment-surface]").count(), 0, "no comments without a pane");
    const lone = await pointOn(paneless.locator('.file-viewer-text .hl-line:nth-of-type(3)'));
    await page.touchscreen.tap(lone.x, lone.y);
    await frames(page);
    assert.equal(await popoverOf(page).count(), 0, "a tap on a line of a viewer without a pane opens nothing");
    console.log("PASS code-phone: a file cut short takes comments; a viewer without a pane takes none, nor a tap on a line");
    assert.deepEqual(errors, []);
    await close();
  },

  /** Markdown preview: selections offer Comment, naming their source lines on activation; drag pins keep the release point, taps still comment on blocks. */
  async preview(open) {
    const { page, errors, close } = await open(DESKTOP);
    const viewer = await openSpec(page);
    const body = viewer.locator(".file-viewer-body");
    assert.equal(await viewer.locator(".file-viewer-body[data-comment-surface]").count(), 1, "the preview is a comment surface");

    // 1. activate Comment on a drag across table rows 42–43; its pin keeps the release point
    const release = await dragText(page, viewer, previewLine(viewer, 42), "Older revision", previewLine(viewer, 43), "merged note");
    await besidePinIn(body).waitFor();
    await assertNoButton(page, "a drag over the preview's table rows");
    assert.equal(await popoverReference(page), "spec.md · Lines 42–43");
    await saveTyped(page, "Also return the stored revision.");
    await eventually("its pin", async () => (await pinsIn(body).count()) === 1);
    await assertTipAt(viewer, pinsIn(body), release, "the rows' comment");
    await eventually("the rows' text to be highlighted", async () => (await highlighted(page)) > 0);
    // the quote reads the rows' cells, set off by " | ", with no separator at a row's start
    assert.deepEqual(await storedFileComments(page), [{
      lines: [42, 43],
      quoteLines: ["Older revision | 409 Conflict with the stored note", "Newer revision | 200 with the merged note"],
      view: "preview",
      selected: true,
    }]);
    console.log("PASS preview: a selection over the table's rows names spec.md · Lines 42–43; saved, its pin sits where the drag let go");

    // 2. inside the paragraph's second line: that source line alone
    await dragText(page, viewer, previewLine(viewer, 4), "revision it stores", previewLine(viewer, 4), "revision it stores");
    await besidePinIn(body).waitFor();
    assert.equal(await popoverReference(page), "spec.md · Line 4");
    await fieldFocused(page);
    await escapePopover(page);
    console.log("PASS preview: a selection in the paragraph's second line names Line 4");

    // 3. a word of the fenced block: the fence's line + 1 + its index
    await dragText(page, viewer, previewLine(viewer, 50), "retries", previewLine(viewer, 50), "retries");
    await besidePinIn(body).waitFor();
    assert.equal(await popoverReference(page), "spec.md · Line 50");
    await fieldFocused(page);
    await escapePopover(page);
    console.log("PASS preview: a word in the fenced block names Line 50, the fence's line + 1");

    // a list item's continuation line: the item's lines
    await dragText(page, viewer, previewLine(viewer, 45), "stored revision", previewLine(viewer, 45), "stored revision");
    await besidePinIn(body).waitFor();
    assert.equal(await popoverReference(page), "spec.md · Lines 45–46");
    await fieldFocused(page);
    await escapePopover(page);
    console.log("PASS preview: a selection in a list item's continuation names the item's Lines 45–46");

    // a comment shows only in the view it was written in
    const showSource = viewer.getByRole("button", { name: "Show source", exact: true });
    await showSource.click();
    await lineOf(viewer, 42).waitFor();
    await eventually("no pin in the code", async () => (await pinsIn(body).count()) === 0);
    await showSource.click();
    await eventually("the pin back in the preview", async () => (await pinsIn(body).count()) === 1);
    console.log("PASS preview: the preview's comment has its pin in the preview only");
    assert.deepEqual(errors, []);
    await close();

    // a phone: a long press selects a word and offers Comment without opening a sheet.
    // Headless Chromium selects nothing on a long press (neither a synthesized tap gesture held for a
    // second nor raw touch events do), so the word is selected as a long press leaves it, and its
    // gesture ends with a touch's pointerup (`selectText` on a coarse pointer)
    const phone = await open(PHONE);
    const phoneViewer = await openSpec(phone.page, true);
    await previewLine(phoneViewer, 3).evaluate((line) => line.scrollIntoView({ block: "center" }));
    await selectText(previewLine(phoneViewer, 3), "revision", previewLine(phoneViewer, 3), "revision");
    assert.equal(await phone.page.evaluate(() => window.getSelection()?.toString()), "revision");
    await frames(phone.page, 10);
    assert.equal(await popoverOf(phone.page).count(), 0, "a touch selection opens nothing");
    await assertSelectionButton(phone.page, "a touch selection in the preview");
    await dismissSelection(phone.page);
    // a tap on the paragraph still opens its sheet on all of its lines
    const at3 = await pointOn(previewLine(phoneViewer, 3));
    await phone.page.touchscreen.tap(at3.x, at3.y);
    await dialogOf(phone.page).waitFor();
    assert.equal(await popoverReference(phone.page), "spec.md · Lines 3–4");
    console.log("PASS preview: on a phone a touch selection offers Comment without a sheet; clearing selection dismisses it; a paragraph tap opens the sheet for Lines 3–4");
    assert.deepEqual(phone.errors, []);
    await phone.close();
  },

  /**
   * A click in the preview comments on the element under it: a paragraph whole, by its source lines; a table row; a
   * list item. And the header's walk reaches a comment a folded code block hides, by unfolding the block.
   */
  async "preview-click"(open) {
    const specPath = realpathSync(join(root, "docs", "spec.md"));
    const folded = "seed-spec-folded";
    // a comment on the blank line 2: placed (its line still reads the same), but the preview draws no element for it
    const blank = "seed-spec-blank";
    const { page, errors, close } = await open(DESKTOP, [
      seededComment(folded, specPath, "docs/spec.md", "preview", SPEC_LINES, FOLDED_LINE, FOLDED_LINE, "Fold note", 1),
      seededComment(blank, specPath, "docs/spec.md", "preview", SPEC_LINES, 2, 2, "Blank note", 2),
    ]);
    const viewer = await openSpec(page);
    const body = viewer.locator(".file-viewer-body");

    // the walk to a comment in the folded block's hidden lines: the block unfolds, its pin opens
    const more = viewer.locator(".markdown-code-more");
    assert.equal(await more.getAttribute("aria-expanded"), "false", "the long block opens folded");
    assert.equal(await more.getAttribute("data-fold-end"), String(FOLD_FIRST + 34), "its Show all names its last line");
    assert.equal(await previewLine(viewer, FOLDED_LINE).count(), 0, "the comment's line is folded away");
    assert.equal(await pinsIn(body).count(), 0, "a comment on a folded line has no pin");
    const counter = viewer.locator("button.file-viewer-comments");
    assert.equal(await counter.getAttribute("aria-label"), "2 comments");
    // the first stop, line 2, has no pin: once the walk has waited for one, it opens in the dialog
    await counter.click();
    const dialog = dialogOf(page);
    await dialog.waitFor();
    assert.equal(await popoverText(page), "Blank note", "the dialog opens the comment in its field");
    assert.equal(await referenceText(dialog.locator(".comment-file-reference")), "spec.md · Line 2");
    assert.equal(await dialog.locator(".comment-popover-note").count(), 0, "with no note: it is not outdated");
    assert.equal(await body.locator(`.comment-pin[data-comment-id="${blank}"]`).count(), 0, "it has no pin");
    await fieldFocused(page);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await eventually("the focus back on the counter", () => focusedMatches(page, "button.file-viewer-comments"));
    console.log("PASS preview-click: a stop whose pin is never drawn (a blank line of the preview) opens the comment in the dialog; Escape gives the focus back to the counter");
    // the next stop: line 80, in the folded block
    await counter.click();
    await eventually("the block to unfold", async () => (await more.getAttribute("aria-expanded")) === "true");
    await eventually("the walk to open the folded comment", async () => (await popoverText(page)) === "Fold note");
    assert.equal(await popoverReference(page), `spec.md · Line ${FOLDED_LINE}`);
    const foldedPin = `.comment-pin[data-comment-id="${folded}"]`;
    assert.ok(await body.locator(foldedPin).evaluate((pin) => pin.classList.contains("is-current")), "the walk marks its pin");
    await assertPinAtLineEnd(body, foldedPin, `.hl-line[data-source-line="${FOLDED_LINE}"]`, "the folded comment");
    await eventually("its pin to be scrolled into view", () => inBody(viewer, foldedPin));
    await eventually("its text to take the current highlight", async () => (await highlighted(page, "block-comment-current")) > 0);
    await fieldFocused(page);
    await escapePopover(page);
    console.log("PASS preview-click: the header's walk unfolds the code block that hides a comment's line, opens its pin's popover in its field and marks the pin");

    // a click on a paragraph: all of its source lines, whole
    const p3 = await pointOn(previewLine(viewer, 3));
    await page.mouse.move(p3.x, p3.y);
    // the frame is a tint and two box shadows (FileViewer.css), not an outline
    await eventually("the hovered paragraph to be framed", () => previewLine(viewer, 3).evaluate((line) => getComputedStyle(line.closest("p")!).boxShadow !== "none"));
    const clicked3 = await clickAt(page, viewer, p3);
    await besidePinIn(body).waitFor();
    await pendingPinIn(body).waitFor();
    assert.equal(await popoverReference(page), "spec.md · Lines 3–4");
    await assertTipAt(viewer, pendingPinIn(body), clicked3, "the provisional pin of a clicked paragraph");
    await assertBesideRight(body, pendingPinIn(body), "a clicked paragraph's new comment");
    assert.equal(await popoverOf(page).locator(".comment-popover-quote").count(), 0, "beside its pin the popover quotes nothing");
    assert.equal((await highlightText(page)).replace(/\s+/g, " ").trim(), (`${SPEC_LINES[2]}\n${SPEC_LINES[3]}`).replace(/\s+/g, " ").trim(), "the quote is the paragraph's lines");
    await saveTyped(page, "Paragraph note");
    await eventually("its pin", async () => (await pinsIn(body).count()) === 2);
    await assertTipAt(viewer, body.locator('.comment-pin[aria-label$=": Paragraph note"]'), clicked3, "the paragraph's comment");
    const paragraph = (await storedFileComments(page)).find((comment) => comment.lines[0] === 3);
    assert.deepEqual(paragraph, { lines: [3, 4], quoteLines: [SPEC_LINES[2], SPEC_LINES[3]], view: "preview", selected: false }, "a comment on the paragraph's whole lines");
    console.log("PASS preview-click: a pointer over a paragraph frames it; a click opens a popover on its Lines 3–4, right of a provisional pin whose tip is where it was clicked; saved, its pin stays there");

    // a click on the paragraph again opens its comment to edit
    const again = await pointOn(previewLine(viewer, 4));
    await page.mouse.click(again.x, again.y);
    await eventually("the paragraph's comment to open", async () => (await popoverText(page)) === "Paragraph note");
    await fieldFocused(page);
    await escapePopover(page);

    // a table row is its own line; a list item its own lines
    const row = await pointOn(previewLine(viewer, 42));
    await page.mouse.click(row.x, row.y);
    await besidePinIn(body).waitFor();
    assert.equal(await popoverReference(page), "spec.md · Line 42");
    await fieldFocused(page);
    await escapePopover(page);
    const item = await pointOn(previewLine(viewer, 45));
    await page.mouse.click(item.x, item.y);
    await besidePinIn(body).waitFor();
    assert.equal(await popoverReference(page), "spec.md · Lines 45–46");
    await fieldFocused(page);
    await escapePopover(page);
    // a link or a code block's controls are no line: a click on Show less folds the block, and opens nothing
    await more.click();
    await eventually("the block to fold", async () => (await more.getAttribute("aria-expanded")) === "false");
    await frames(page);
    assert.equal(await popoverOf(page).count(), 0, "the fold button opens no comment");
    console.log("PASS preview-click: a click on the paragraph again opens its comment to edit; a table row names Line 42, a list item Lines 45–46; the fold button comments on nothing");
    assert.deepEqual(errors, []);
    await close();
  },

  /**
   * The viewer's header: the counter of the file's comments walks them one per tap, opening each pin's popover,
   * follows them when the file changes, opens an outdated one in a dialog and switches to the view a comment was
   * written in. It has no Write message button: Close is the way back to the message box.
   */
  async header(open) {
    const syncFile = join(root, "src", "sync.ts");
    const syncPath = realpathSync(syncFile);
    const specPath = realpathSync(join(root, "docs", "spec.md"));
    const page8 = "seed-line-8";
    const range = "seed-lines-7-9";
    const table = "seed-spec-42-43";
    const { page, errors, close } = await open(DESKTOP, [
      seededComment(page8, syncPath, "src/sync.ts", "code", SYNC_LINES, 8, 8, "Compare with <=.", 1),
      seededComment(range, syncPath, "src/sync.ts", "code", SYNC_LINES, 7, 9, "Range note", 2),
      seededComment(table, specPath, "docs/spec.md", "preview", SPEC_LINES, 42, 43, "Also return the stored revision.", 3,
        ["Older revision | 409 Conflict with the stored note", "Newer revision | 200 with the merged note"]),
    ]);
    const pinOf = (id: string): string => `.comment-pin[data-comment-id="${id}"]`;
    const isCurrent = (viewer: Locator, id: string): Promise<boolean> => viewer.locator(pinOf(id)).evaluate((pin) => pin.classList.contains("is-current"));
    const writeSync = (lines: readonly string[]): void => writeFileSync(syncFile, `${lines.join("\n")}\n`);
    try {
      // 1. two comments: the counter reads 2 comments, and walks to them in sending order (lines 7–9, then line 8)
      let viewer = await openSync(page);
      let body = viewer.locator(".file-viewer-body");
      assert.equal(await viewer.locator(".file-viewer-meta").getAttribute("title"), syncPath, "the comments were seeded on the path the viewer resolves");
      let counter = viewer.locator("button.file-viewer-comments");
      await counter.waitFor();
      assert.equal(await counter.getAttribute("aria-label"), "2 comments");
      assert.equal(await counter.locator(".file-viewer-comments-count").textContent(), "2", "the count is a bubble on the icon");
      assert.equal(await counter.innerText(), "2", "the button shows no words, only the bubble's count");
      await eventually("both pins", async () => (await pinsIn(body).count()) === 2);
      await counter.click();
      await eventually("the walk to open the comment on lines 7–9", async () => (await popoverText(page)) === "Range note");
      assert.equal(await popoverReference(page), "sync.ts · Lines 7–9");
      assert.ok(await isCurrent(viewer, range), "the walk marks its pin");
      await eventually("its pin and popover in view", async () => await inBody(viewer, pinOf(range)) && await inBody(viewer, ".comment-popover"));
      await eventually("its text to take the current highlight", async () => (await highlighted(page, "block-comment-current")) > 0);
      // the walk opens it to edit: its field takes the focus, filled with it, its text up meanwhile
      await fieldFocused(page);
      assert.equal(await deleteOf(page).count(), 1, "with its Delete");
      await assertUp(body, "return stored", "the header's walk stop, the focus in its field");
      await counter.click();
      await eventually("the walk to open the comment on line 8", async () => (await popoverText(page)) === "Compare with <=.");
      assert.ok(await isCurrent(viewer, page8), "the walk marks the next pin");
      assert.equal(await isCurrent(viewer, range), false, "the walk stands on one pin at a time");
      console.log("PASS header: the counter reads 2 comments; each tap walks to the next pin (lines 7–9, then line 8), opens its popover, marks the pin, in view");

      // 2. two lines inserted above line 8: the comment on line 8 follows its line to line 10, and the store says so
      await viewer.getByRole("button", { name: "Close file", exact: true }).click();
      await viewer.waitFor({ state: "detached" });
      const moved = [...SYNC_LINES.slice(0, 7), "  // a revision is a counter", "  // that only grows", ...SYNC_LINES.slice(7)];
      writeSync(moved);
      viewer = await openSync(page);
      body = viewer.locator(".file-viewer-body");
      await lineOf(viewer, moved.length).waitFor();
      await assertPinAtLineEnd(body, pinOf(page8), '.hl-line[data-source-line="10"]', "the moved comment");
      const storedLines = (id: string): Promise<number[] | null> => page.evaluate((wanted) => {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)!;
          if (!key.startsWith("herdr-web-ui:block-comments:")) continue;
          const found = (JSON.parse(localStorage.getItem(key)!) as { comments: { id: string; lines: number[] }[] }).comments.find((c) => c.id === wanted);
          if (found !== undefined) return found.lines;
        }
        return null;
      }, id);
      await eventually("the store to hold the comment's new line", async () => JSON.stringify(await storedLines(page8)) === "[10,10]");
      // lines 7–9 no longer follow each other: that comment has no place in the file now
      counter = viewer.locator("button.file-viewer-comments");
      assert.equal(await counter.getAttribute("aria-label"), "2 comments · 1 outdated");
      assert.deepEqual(await storedLines(range), [7, 9], "an outdated comment keeps its lines");
      assert.equal(await body.locator(pinOf(range)).count(), 0, "an outdated comment has no pin");
      console.log("PASS header: after two lines were inserted above line 8, its comment's pin is at line 10 and it is stored as lines [10, 10]");

      // 3. line 7 changed: the comment on lines 7–9 stays outdated, and the walk opens it in a dialog
      await viewer.getByRole("button", { name: "Close file", exact: true }).click();
      await viewer.waitFor({ state: "detached" });
      writeSync(moved.map((line, index) => index === 6 ? "  const stored = await loadLatest(incoming.id);" : line));
      viewer = await openSync(page);
      counter = viewer.locator("button.file-viewer-comments");
      await counter.waitFor();
      assert.equal(await counter.getAttribute("aria-label"), "2 comments · 1 outdated");
      const dialog = dialogOf(page);
      await counter.click();
      await eventually("a stop", async () => (await popoverOf(page).count()) > 0);
      if ((await dialog.count()) === 0) await counter.click();
      await dialog.waitFor();
      assert.equal(await referenceText(dialog.locator(".comment-file-reference")), "sync.ts · Lines 7–9");
      assert.equal(await dialog.locator("pre.comment-popover-plain").textContent(), SYNC_LINES.slice(6, 9).join("\n"), "the quote is the lines as they were");
      assert.equal(await dialog.locator(".comment-popover-note").textContent(), "This part of the file has changed since.");
      assert.equal(await popoverText(page), "Range note", "the outdated comment's dialog opens it in its field");
      assert.equal(await closeOf(page).count(), 1, "the dialog keeps ✕");
      assert.equal(await deleteOf(page).count(), 1, "and Delete");
      await fieldFocused(page);
      // Tab goes round the dialog's own controls, never out to the viewer under it
      const inDialog = (): Promise<boolean> => page.evaluate(() => document.querySelector(".modal.comment-popover")?.contains(document.activeElement) ?? false);
      for (let tab = 0; tab < 3; tab++) {
        await page.keyboard.press("Tab");
        assert.ok(await inDialog(), `Tab ${tab + 1} keeps the focus in the dialog`);
      }
      await page.keyboard.press("Shift+Tab");
      assert.ok(await inDialog(), "Shift+Tab keeps the focus in the dialog");
      // Settings opened by its shortcut over the dialog lies above it, and the question it asks above Settings
      /** What is drawn at the middle of the screen: inside which of these. */
      const topmost = (): Promise<string | null> => page.evaluate(() => {
        const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        return hit?.closest(".confirm-dialog") ? "confirm" : hit?.closest(".settings-dialog") ? "settings" : hit?.closest(".comment-popover") ? "comment" : hit?.closest(".file-viewer") ? "viewer" : hit?.className ?? null;
      });
      await page.keyboard.press("ControlOrMeta+Shift+Comma");
      await page.locator(".settings-dialog").waitFor();
      await eventually("Settings to be topmost", async () => (await topmost()) === "settings");
      await openSettingsPage(page, "Chat");
      const toggle = page.locator(".settings-dialog").getByRole("switch", { name: "Comments", exact: true });
      await toggle.click();
      const confirm = page.getByRole("alertdialog");
      await confirm.waitFor();
      await eventually("its question to be topmost", async () => (await topmost()) === "confirm");
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      await page.keyboard.press("Escape");
      await page.locator(".settings-dialog").waitFor({ state: "detached" });
      assert.equal(await dialog.count(), 1, "the comment's dialog stays under Settings, and Escape closes Settings alone");
      await eventually("the dialog to be topmost again", async () => (await topmost()) === "comment");
      console.log("PASS header: Settings opened by its shortcut over the comment's dialog lies above it, and its comments-off question above Settings; Escape closes Settings alone");
      await eventually("the focus back in the dialog", inDialog);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      assert.ok(await viewer.isVisible(), "Escape closes the dialog, not the viewer");
      await eventually("the focus back on the counter", () => focusedMatches(page, "button.file-viewer-comments"));
      console.log("PASS header: with line 7 changed the counter reads 2 comments · 1 outdated; the walk opens a dialog with sync.ts · Lines 7–9, the old quote and the note; Tab stays in it; Escape closes only it, back to the counter");

      // the dialog's field edited, saved: the outdated comment changes, and the walk goes on from it
      await counter.click();
      await eventually("a stop", async () => (await popoverOf(page).count()) > 0);
      if ((await dialog.count()) === 0) await counter.click();
      await dialog.waitFor();
      await fieldFocused(page);
      assert.equal(await fieldOf(page).inputValue(), "Range note");
      await fieldOf(page).fill("Range note, still");
      // Escape with text typed: the dialog keeps it, and the viewer stays
      await page.keyboard.press("Escape");
      await frames(page);
      assert.equal(await dialog.count(), 1, "Escape with text typed leaves the dialog");
      assert.ok(await viewer.isVisible(), "and the viewer");
      await page.keyboard.press("Control+Enter");
      await dialog.waitFor({ state: "detached" });
      await eventually("the edit to be stored", async () => (await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("herdr-web-ui:block-comments:")).map((key) => localStorage.getItem(key)).join(""))).includes("Range note, still"));
      console.log("PASS header: the dialog opens the comment in its field; Escape with text typed keeps the dialog and the viewer; Ctrl+Enter saves the edit");

      // the dialog open again, and its comment deleted in another tab: it closes, and the viewer stays
      await counter.click();
      await eventually("a stop", async () => (await popoverOf(page).count()) > 0);
      if ((await dialog.count()) === 0) await counter.click();
      await dialog.waitFor();
      assert.equal(await popoverText(page), "Range note, still");
      const other = await page.context().newPage();
      await other.goto(page.url());
      await other.evaluate(() => {
        for (const key of Object.keys(localStorage).filter((name) => name.startsWith("herdr-web-ui:block-comments:"))) {
          const data = JSON.parse(localStorage.getItem(key)!) as { comments: { comment: string }[] };
          localStorage.setItem(key, JSON.stringify({ ...data, comments: data.comments.filter((comment) => !comment.comment.startsWith("Range note")) }));
        }
      });
      await dialog.waitFor({ state: "detached" });
      await other.close();
      assert.ok(await viewer.isVisible(), "the viewer stays");
      await eventually("the counter to count 1 comment", async () => (await counter.getAttribute("aria-label")) === "1 comment");
      console.log("PASS header: the dialog of a comment deleted in another tab closes; the viewer stays");

      // 4. no Write message: the header's comment group is the counter alone
      assert.equal(await viewer.getByRole("button", { name: "Write message", exact: true }).count(), 0, "no Write message button");
      await viewer.getByRole("button", { name: "Close file", exact: true }).click();
      await viewer.waitFor({ state: "detached" });
      console.log("PASS header: the header has no Write message button");

      // 5. a comment written in the preview, walked to from the code: the view switches to it
      const spec = await openSpec(page);
      await spec.getByRole("button", { name: "Show source", exact: true }).click();
      await lineOf(spec, 42).waitFor();
      const specCounter = spec.locator("button.file-viewer-comments");
      assert.equal(await specCounter.getAttribute("aria-label"), "1 comment");
      await specCounter.click();
      await spec.locator(".file-viewer-markdown").waitFor();
      await eventually("the walk to open the preview's comment", async () => (await popoverText(page)) === "Also return the stored revision.");
      assert.ok(await isCurrent(spec, table), "the walk marks its pin");
      console.log("PASS header: walking to a comment written in the preview switches the code view to the preview and opens its pin's popover");
      assert.deepEqual(errors, []);
    } finally {
      writeSync(SYNC_LINES);
      await close();
    }
  },

  /**
   * The composer's bar counts the file comments too, and its walk goes on from the chat's comments
   * into the files: each file stop opens the viewer at that comment, in the view it was written in;
   * after the viewer closes, the next tap goes on after the comment it showed last. A send takes them all.
   */
  async composer(open) {
    const syncPath = realpathSync(join(root, "src", "sync.ts"));
    const specPath = realpathSync(join(root, "docs", "spec.md"));
    const line8 = "seed-sync-8";
    const table = "seed-spec-42-43";
    const tableQuote = ["Older revision | 409 Conflict with the stored note", "Newer revision | 200 with the merged note"];
    // the spec's comment was written first: its file's comments are sent first
    const { page, errors, sent, close } = await open(DESKTOP, [
      seededComment(line8, syncPath, "src/sync.ts", "code", SYNC_LINES, 8, 8, "Compare with <=.", 2),
      seededComment(table, specPath, "docs/spec.md", "preview", SPEC_LINES, 42, 43, "Also return the stored revision.", 1, tableQuote),
    ]);
    const chat = page.locator(".chat-view");
    const walk = walkOf(page);
    await walk.waitFor();
    assert.equal(await walk.getAttribute("aria-label"), "2 comments", "with file comments the bar counts comments, not comments on the reply");

    // the chat's comment, written as in the chat case: a reply comment's anchor is the chat's to make
    const paragraph = page.locator(".chat-view p.is-commentable", { hasText: REPLY });
    await dragText(page, null, paragraph, "every revision", paragraph, "in order");
    await saveTyped(page, "Say which order.");
    await eventually("the chat's pin", async () => (await pinsIn(chat).count()) === 1);
    await eventually("the bar to count 3 comments", async () => (await walk.getAttribute("aria-label")) === "3 comments");
    assert.equal(await walk.locator(".composer-comments-text").textContent(), "3 comments");
    console.log("PASS composer: with one comment on the reply and two on files, the bar reads 3 comments");

    /** Whether the viewer's popover reads `text` and the pin of `id` is marked current. */
    const openedInViewer = async (viewer: Locator, id: string, text: string): Promise<boolean> =>
      (await besidePinIn(viewer.locator(".file-viewer-body")).count()) === 1 && (await popoverText(page)) === text
      && await viewer.locator(`.comment-pin[data-comment-id="${id}"]`).evaluate((pin) => pin.classList.contains("is-current")).catch(() => false);

    // tap 1: the chat's pin
    await walk.click();
    await eventually("the walk to open the chat's comment", async () => (await besidePinIn(chat).count()) === 1 && (await popoverText(page)) === "Say which order.");
    assert.equal(await page.locator(".file-viewer").count(), 0, "the chat's stop opens no viewer");
    console.log("PASS composer: tap 1 opens the chat's comment by its pin");

    // tap 2: the viewer opens docs/spec.md in the preview, at its comment
    await walk.click();
    const spec = page.getByRole("dialog", { name: "spec.md", exact: true });
    await spec.locator(".file-viewer-markdown").waitFor();
    await eventually("the viewer to open the spec's comment", () => openedInViewer(spec, table, "Also return the stored revision."));
    assert.equal(await spec.getByRole("button", { name: "Show source", exact: true }).getAttribute("aria-pressed"), "false", "the preview shows");
    // the viewer's own walk has nothing else in this file: it stays on the comment
    const specCounter = spec.locator("button.file-viewer-comments");
    assert.equal(await specCounter.getAttribute("aria-label"), "1 comment");
    await specCounter.click();
    await eventually("the viewer's walk to stay on the spec's comment", () => openedInViewer(spec, table, "Also return the stored revision."));
    await spec.getByRole("button", { name: "Close file", exact: true }).click();
    await spec.waitFor({ state: "detached" });
    console.log("PASS composer: tap 2 opens docs/spec.md in the preview at its comment's popover; the viewer's walk stays there");

    // tap 3: on after the comment the viewer showed last, to src/sync.ts in the code view at line 8
    await walk.click();
    const sync = page.getByRole("dialog", { name: "sync.ts", exact: true });
    await lineOf(sync, SYNC_LINES.length).waitFor();
    await eventually("the viewer to open the comment on line 8", () => openedInViewer(sync, line8, "Compare with <=."));
    await assertPinAtLineEnd(sync.locator(".file-viewer-body"), `.comment-pin[data-comment-id="${line8}"]`, '.hl-line[data-source-line="8"]', "line 8's comment");
    await sync.getByRole("button", { name: "Close file", exact: true }).click();
    await sync.waitFor({ state: "detached" });
    console.log("PASS composer: tap 3 opens src/sync.ts in the code view at its comment on line 8");

    // a send takes every comment: the reply's first, then the files' in the order they were first commented, then the text
    const expected = [
      // The blank line ends Markdown's quote before the user's comment (no lazy continuation).
      "> every revision in order\n\nSay which order.",
      `> docs/spec.md:42-43\n${tableQuote.map((line) => `> ${line}`).join("\n")}\n\nAlso return the stored revision.`,
      `> src/sync.ts:8\n> ${SYNC_LINES[7]}\n\nCompare with <=.`,
      "Thanks",
    ].join("\n\n");
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("Thanks");
    await page.getByRole("button", { name: /^Send message/ }).click();
    await walk.waitFor({ state: "detached" });
    await eventually("the message to be sent", async () => sent.length > 0);
    assert.deepEqual(sent, [expected]);
    const stored = await page.evaluate(() => {
      let count = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)!;
        if (key.startsWith("herdr-web-ui:block-comments:")) count += (JSON.parse(localStorage.getItem(key)!) as { comments: unknown[] }).comments.length;
      }
      return count;
    });
    assert.equal(stored, 0, "the store is empty after the send");
    console.log("PASS composer: Send sends the reply's comment, then docs/spec.md's, then src/sync.ts's, then Thanks; the store is empty after");
    assert.deepEqual(errors, []);
    await close();
  },

  /**
   * The comment's sheet on a phone. iOS raises the keyboard only for a focus inside the tap's own event: the field
   * must have the focus before the tap's task ends (checked here with only microtasks run after it, no frame). The
   * keyboard then shrinks the view from below (simulated by a shorter viewport): the sheet stays in it. Send in the
   * message box while a comment is half written sends nothing and gives that comment's field the focus.
   */
  async "form-phone"(open) {
    const { page, errors, sent, close } = await open(PHONE);
    const sheetField = ".modal.comment-popover textarea";
    /** Shrinks the page as a phone's keyboard does, waits for `view` to follow, and for the sheet and its field to stay on screen. */
    const keyboardUp = async (view: Locator): Promise<void> => {
      const before = await view.evaluate((node) => node.clientHeight);
      await page.setViewportSize({ width: PHONE.viewport!.width, height: PHONE.viewport!.height - 300 });
      await eventually("the view to shrink", async () => (await view.evaluate((node) => node.clientHeight)) < before);
      await eventually("the sheet and its field to be on the shrunk screen", () => page.evaluate(() => {
        const sheet = document.querySelector(".modal.comment-popover");
        const field = sheet?.querySelector("textarea");
        if (!sheet || !field) return false;
        const box = sheet.getBoundingClientRect();
        const input = field.getBoundingClientRect();
        return box.top >= -1 && box.bottom <= window.innerHeight + 1 && input.top >= 0 && input.bottom <= window.innerHeight + 1;
      }));
      await page.setViewportSize(PHONE.viewport!);
    };

    /** A tap's click on the middle of `element` (a single one, `detail` 1, of the primary button): whether the sheet's field has the focus before the tap's task ends. */
    const tapFocuses = (element: Locator, block: ScrollLogicalPosition = "center"): Promise<boolean> => element.evaluate(async (node, wanted) => {
      node.scrollIntoView({ block: wanted.block });
      const box = node.getBoundingClientRect();
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: box.left + Math.min(box.width, 60) / 2, clientY: box.top + box.height / 2 }));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      return document.activeElement?.matches(wanted.field) ?? false;
    }, { field: sheetField, block });

    // the chat: a touch selection offers Comment, whose activation focuses the sheet inside the tap
    const paragraph = page.locator(".chat-view p.is-commentable", { hasText: REPLY });
    await selectText(paragraph, "every revision", paragraph, "in order");
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a touch selection opens nothing");
    await assertSelectionButton(page, "a touch selection in the chat");
    const focusedOnComment = await selectionButtonOf(page).evaluate(async (button, field) => {
      (button as HTMLButtonElement).click();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      return document.activeElement?.matches(field) ?? false;
    }, sheetField);
    assert.ok(focusedOnComment, "the chat's sheet takes the focus inside the tap on Comment");
    const sheet = dialogOf(page);
    await sheet.waitFor();
    await keyboardUp(page.locator(".chat-view"));
    console.log("PASS form-phone: a touch selection offers Comment without an editor; activation focuses the sheet's field inside the tap; the sheet stays in view as the keyboard rises");

    // Send with a comment half written: nothing goes, the comment's field takes the focus (in the tap)
    await fieldOf(page).fill("Half a thought");
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Thanks");
    const sendButton = page.getByRole("button", { name: /^Send message/ });
    const heldForComment = await sendButton.evaluate(async (node, field) => {
      (node as HTMLElement).click();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      return document.activeElement?.matches(field) ?? false;
    }, sheetField);
    assert.ok(heldForComment, "Send with a typed comment focuses its field, inside the tap");
    assert.deepEqual(sent, [], "nothing was sent");
    assert.equal(await message.inputValue(), "Thanks", "the message stays in the box");
    await fieldOf(page).fill("");
    await sheet.getByRole("button", { name: "Close", exact: true }).tap();
    await sheet.waitFor({ state: "detached" });
    await sendButton.tap();
    await eventually("the message to be sent once the comment is given up", async () => sent.length > 0);
    assert.deepEqual(sent, ["Thanks"]);
    console.log("PASS form-phone: Send with a comment half written sends nothing and focuses its field; given up, the message goes");

    // the code view: a tap on a line at the view's bottom edge
    await page.getByRole("button", { name: "big.txt", exact: true }).tap();
    const viewer = page.getByRole("dialog", { name: "big.txt", exact: true });
    await lineOf(viewer, 40).waitFor();
    assert.ok(await tapFocuses(lineOf(viewer, 40), "end"), "the code view's sheet takes the focus inside the tap on a line");
    await sheet.waitFor();
    assert.equal(await popoverReference(page), "big.txt · Line 40");
    await keyboardUp(viewer.locator(".file-viewer-body"));
    console.log("PASS form-phone: a tap on a code line at the view's bottom edge opens the sheet with its field focused inside the tap; the sheet stays in view as the keyboard rises");

    // a tap on a line opens the sheet too, focused inside the tap
    await fieldOf(page).fill("");
    await sheet.getByRole("button", { name: "Close", exact: true }).tap();
    await sheet.waitFor({ state: "detached" });
    const focusedOnLine = await lineOf(viewer, 12).evaluate(async (line, field) => {
      line.scrollIntoView({ block: "center" });
      // a tap's click: a single one (`detail` 1) of the primary button
      line.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      return document.activeElement?.matches(field) ?? false;
    }, sheetField);
    assert.ok(focusedOnLine, "a tap on a line opens the sheet with its field focused inside the tap");
    assert.equal(await popoverReference(page), "big.txt · Line 12");
    console.log("PASS form-phone: a tap on a code line opens its sheet with the field focused inside the tap");
    assert.deepEqual(errors, []);
    await close();
  },
};

const wanted = process.env.FILE_COMMENTS_CASE?.split(",").map((name) => name.trim()).filter((name) => name !== "") ?? Object.keys(cases);
const unknown = wanted.filter((name) => !(name in cases));
if (unknown.length > 0) throw new Error(`unknown FILE_COMMENTS_CASE: ${unknown.join(", ")} (known: ${Object.keys(cases).join(", ")})`);

let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
const failed: string[] = [];

try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-file-comments" });
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
  const url = `http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`;
  const launched = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  browser = launched;
  /** A fresh context (an empty comment store, or `seed`'s comments) on the pane's chat, its reply drawn. */
  const open = async (options: BrowserContextOptions, seed: readonly object[] = []): Promise<Opened> => {
    const context = await launched.newContext(options);
    const page = await context.newPage();
    await page.addInitScript((id) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`herdr-web-ui:view:${id.pane}`, "chat");
      // seeded once: a reload keeps what the page has done to them since
      const key = `herdr-web-ui:block-comments:${id.pane}`;
      if (id.seed.length > 0 && localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ version: 1, comments: id.seed }));
    }, { pane, seed });
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sent: string[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload)) as { type?: string; text?: string };
        if (frame.type === "submit" && typeof frame.text === "string") sent.push(frame.text);
      } catch { /* not JSON */ }
    }));
    await page.goto(url);
    await page.locator(".conn-live").waitFor();
    await page.locator(".chat-view p.is-commentable", { hasText: REPLY }).waitFor();
    return { page, errors, sent, close: () => context.close() };
  };
  for (const name of wanted) {
    try {
      await cases[name]!(open);
      console.log(`PASS case ${name}`);
    } catch (error) {
      failed.push(name);
      console.log(`FAIL case ${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
if (failed.length > 0) {
  console.log(`FAIL ${failed.length} of ${wanted.length} cases: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`PASS all ${wanted.length} cases: ${wanted.join(", ")}`);
