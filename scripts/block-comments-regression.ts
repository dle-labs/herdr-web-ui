/**
 * Comments on an agent's reply in the chat, with a real Codex transcript and an owned herdr pane: a comment made by a
 * mouse's drag over text (it opens as the mouse lets go) or by clicking or tapping a block, never by a Comment button
 * (there is none: a keyboard or touch selection, a double or triple click open nothing), its pin's tip where it was
 * clicked or the drag let go, else (a comment stored without a point) after the end of its text (the text highlighted),
 * the popover beside the pin, to its right (a bottom sheet on a phone), a saved comment opened straight into its field
 * (its text highlighted meanwhile) with Delete beside ↑, the keys and the focus, the composer's walk and send, the text
 * moving under the pins, and the setting that turns comments off.
 *
 * One server, pane and browser per run. Each case starts from a fresh page with an empty comment store (or the
 * comments it seeds), so a case runs alone: `BLOCK_COMMENTS_CASE=<name>[,<name>]` runs only those (unset: all).
 * Waits are bounded polls (`eventually`, `frames`), never fixed sleeps. Serves `dist/`: build first.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

const INTRO = "Intro paragraph about the state.";
const LONG_PARAGRAPH = "A longer paragraph that runs across several lines on a phone, so its first line reaches the right edge where the comment button sits.";
/** One word, no space to break at, that wraps anywhere (`.markdown` has `overflow-wrap: anywhere`): its first line fills the column to its right edge. */
const CHECKSUM = `Checksum:${"0123456789abcdef".repeat(10)}`;
const ANSWER = [
  INTRO,
  "",
  "1. Run the migration",
  "2. Restart the server",
  "   - check the logs",
  "",
  "See [docs](https://example.com).",
  "",
  LONG_PARAGRAPH,
  "",
  CHECKSUM,
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  // more than a view of text: the walk has to scroll to a comment, and a view of the end hides the intro
  ...Array.from({ length: 14 }, (_, n) => `Step ${n + 1} of the rollout keeps the service up while it moves.\n`),
].join("\n");

const root = mkdtempSync(join(tmpdir(), "herdr-web-ui-block-comments-"));
const codexHome = join(root, "codex-home");
const thread = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc12";
mkdirSync(join(codexHome, "sessions"), { recursive: true });
const transcript = join(codexHome, "sessions", `rollout-2026-10-04T00-00-00-${thread}.jsonl`);
writeFileSync(transcript, [
  { type: "session_meta", payload: { id: thread, cwd: root } },
  { timestamp: "2026-10-04T10:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Show me the plan." }] } },
  { timestamp: "2026-10-04T10:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: ANSWER }] } },
].map((row) => JSON.stringify(row)).join("\n"));
const db = new Database(join(codexHome, "state_5.sqlite"));
db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, first_user_message TEXT)");
db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli', ?)").run(thread, transcript, root, "Show me the plan.");
db.close();
const standIn = join(root, "codex");
writeFileSync(standIn, "#!/bin/sh\nsleep 600\n");
chmodSync(standIn, 0o755);

const DESKTOP: BrowserContextOptions = { viewport: { width: 1280, height: 800 } };
const { defaultBrowserType: _webkit, ...iPhone } = devices["iPhone 13"]!;
/** 390 × 844, a touch screen. */
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

/** The saved comments' pins in the chat, in the document's order (reading order). */
const pinsOf = (page: Page): Locator => page.locator(".chat-view .comment-pin:not(.is-pending)");
/** The provisional pin of the comment being written. */
const pendingPinOf = (page: Page): Locator => page.locator(".chat-view .comment-pin.is-pending");
/** The open comment's popover, wherever it is drawn. */
const popoverOf = (page: Page): Locator => page.locator(".comment-popover");
/** The popover beside its pin, in the chat's scrolling content. */
const besidePinOf = (page: Page): Locator => page.locator(".chat-view .comment-popover");
/** The popover as a dialog of its own (the shared modal: a bottom sheet on a phone), portalled to the body. */
const dialogOf = (page: Page): Locator => page.locator(".modal-scrim > .modal.comment-popover");
const fieldOf = (page: Page): Locator => popoverOf(page).getByRole("textbox", { name: "Comment", exact: true });
const messageOf = (page: Page): Locator => page.getByRole("textbox", { name: "Message", exact: true });
const partOf = (page: Page, text: string): Locator => page.locator(".chat-view p.is-commentable", { hasText: text });
/** The comments' context bar above the message box, and its text, which walks to them. */
const barOf = (page: Page): Locator => page.locator(".composer-surface > .composer-comments-bar");
const walkOf = (page: Page): Locator => barOf(page).locator("button.composer-comments-walk");

/** Whether the focused element matches `selector`. */
const focusedMatches = (page: Page, selector: string): Promise<boolean> => page.evaluate((wanted) => document.activeElement?.matches(wanted) ?? false, selector);
/** Waits for the open popover's field to take the focus (it does as the popover mounts). */
const fieldFocused = (page: Page): Promise<void> => eventually("the popover's field to take the focus", () => focusedMatches(page, ".comment-popover textarea"));
/** The open popover's Delete (a saved comment's, beside ↑), and its ✕ (a dialog's and a sheet's only). */
const deleteOf = (page: Page): Locator => popoverOf(page).getByRole("button", { name: "Delete comment", exact: true });
const closeOf = (page: Page): Locator => popoverOf(page).getByRole("button", { name: "Close", exact: true });
/**
 * The comment whose text is up (the active or current highlight) in the chat, and whether the chat is in focus mode:
 * `ranges` the ranges those highlights hold, `text` their text.
 */
const upInChat = (page: Page): Promise<{ ranges: number; text: string; focus: boolean }> => page.evaluate(() => {
  const registry = (CSS as unknown as { highlights: { get(key: string): Iterable<Range> | undefined } }).highlights;
  const ranges = [...(registry.get("block-comment-active") ?? []), ...(registry.get("block-comment-current") ?? [])];
  return { ranges: ranges.length, text: ranges.map((range) => range.toString()).join("\n"), focus: document.querySelector(".chat-view")?.hasAttribute("data-comment-focus") ?? false };
});
/** Polls until the text up in the chat (`upInChat`) includes `text`, the chat in focus mode. */
async function assertUp(page: Page, text: string, what: string): Promise<void> {
  let seen: unknown = null;
  await eventually(`${what}: its text up, the chat in focus mode`, async () => {
    const up = await upInChat(page);
    seen = up;
    return up.ranges > 0 && up.text.includes(text) && up.focus;
  }).catch((error: Error) => { throw new Error(`${error.message} (${JSON.stringify(seen)})`); });
}

/** One comment as the store keeps it. */
interface StoredComment { id: string; anchor: string; comment: string; quote?: string; point?: { x: number; y: number } }
const storedOf = (page: Page): Promise<StoredComment[]> => page.evaluate(() => {
  const found: unknown[] = [];
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("herdr-web-ui:block-comments:")) found.push(...(JSON.parse(localStorage.getItem(key)!) as { comments: unknown[] }).comments);
  }
  return found as StoredComment[];
});

/** The center of the first `word` in `part`'s text, in client pixels, its line scrolled to the chat view's middle first. */
async function wordPoint(part: Locator, word: string): Promise<{ x: number; y: number }> {
  return part.evaluate((node, wanted) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let next = walker.nextNode(); next; next = walker.nextNode()) {
      const at = (next as Text).data.indexOf(wanted);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(next, at);
      range.setEnd(next, at + wanted.length);
      const view = document.querySelector(".chat-view")!;
      const box = view.getBoundingClientRect();
      const first = range.getBoundingClientRect();
      view.scrollBy({ top: first.top + first.height / 2 - (box.top + box.height / 2), behavior: "instant" });
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`"${wanted}" is not in the part`);
  }, word);
}
/** A point the pointer acted at, in client pixels, and the chat view's `scrollTop` then: where it is on the text after a scroll. */
interface Pointed { x: number; y: number; scroll: number }
const scrollOf = (page: Page): Promise<number> => page.locator(".chat-view").evaluate((node) => node.scrollTop);

/** A plain click on `word` in `part`: the click that comments on the block. Returns where it clicked. */
async function clickWord(page: Page, part: Locator, word: string): Promise<Pointed> {
  const at = await wordPoint(part, word);
  await page.mouse.click(at.x, at.y);
  return { ...at, scroll: await scrollOf(page) };
}

/**
 * A mouse's drag over `part`'s text from the start of `from` to the end of the first `to` after it, a real press, moves
 * and release (one click): the selection opens its comment at once, without the Comment button. Returns where it let go.
 */
async function dragSelect(page: Page, part: Locator, from: string, to: string): Promise<Pointed> {
  const [start, end] = await part.evaluate((node, text) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const glyph = (wanted: string, after: number, last: boolean): { rect: DOMRect; at: number } => {
      let seen = 0;
      for (let next = walker.nextNode(); next; next = walker.nextNode()) {
        const data = (next as Text).data;
        const at = data.indexOf(wanted, Math.max(0, after - seen));
        if (at >= 0) {
          const offset = last ? at + wanted.length - 1 : at;
          const range = document.createRange();
          range.setStart(next, offset);
          range.setEnd(next, offset + 1);
          return { rect: range.getBoundingClientRect(), at: seen + at + wanted.length };
        }
        seen += data.length;
      }
      throw new Error(`"${wanted}" is not in the part`);
    };
    const view = document.querySelector(".chat-view")!;
    const box = view.getBoundingClientRect();
    const first = glyph(text.from, 0, false);
    view.scrollBy({ top: first.rect.top + first.rect.height / 2 - (box.top + box.height / 2), behavior: "instant" });
    walker.currentNode = node;
    const head = glyph(text.from, 0, false);
    walker.currentNode = node;
    const tail = glyph(text.to, head.at, true);
    return [{ x: head.rect.left + 1, y: head.rect.top + head.rect.height / 2 }, { x: tail.rect.right - 1, y: tail.rect.top + tail.rect.height / 2 }];
  }, { from, to });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await page.mouse.up();
  return { ...end, scroll: await scrollOf(page) };
}
/** A finger's tap on `word` in `part`. */
async function tapWord(page: Page, part: Locator, word: string): Promise<void> {
  const at = await wordPoint(part, word);
  await page.touchscreen.tap(at.x, at.y);
}

/**
 * Selects text in `part` the way the keyboard (Shift+arrows) or a finger's long press leaves it: from `from` to the end
 * of the first `to` after it (or of `from` alone), or, with `firstLine`, from `from` to the last character of the line
 * it starts on. The selection is the page's, the selected text in the chat view's middle, then the event that ends the
 * gesture: a finger's `pointerup` on a touch screen, else the `keyup` of the Shift key. Neither is a mouse's drag, so
 * the selection opens nothing.
 */
async function select(part: Locator, from: string, { to, firstLine = false }: { to?: string; firstLine?: boolean } = {}): Promise<void> {
  await part.evaluate((node, text) => {
    const skipped = ".comment-pins, .markdown-code-header, button:not(.markdown-file), [aria-hidden='true']";
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: (found) => {
        const hit = found.parentElement?.closest(skipped);
        return hit && node.contains(hit) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes: Text[] = [];
    let all = "";
    for (let next = walker.nextNode(); next; next = walker.nextNode()) {
      nodes.push(next as Text);
      all += (next as Text).data;
    }
    const point = (offset: number, atEnd: boolean): [Text, number] => {
      let seen = 0;
      for (const piece of nodes) {
        if (offset < seen + piece.length || (atEnd && offset === seen + piece.length)) return [piece, offset - seen];
        seen += piece.length;
      }
      throw new Error("no text node at the offset");
    };
    const start = all.indexOf(text.from);
    if (start < 0) throw new Error(`"${text.from}" is not in the part: ${JSON.stringify(all)}`);
    const view = document.querySelector(".chat-view")!;
    const box = view.getBoundingClientRect();
    const glyph = (offset: number): DOMRect => {
      const range = document.createRange();
      range.setStart(...point(offset, false));
      range.setEnd(...point(offset + 1, true));
      return range.getBoundingClientRect();
    };
    const head = glyph(start);
    view.scrollBy({ top: head.top + head.height / 2 - (box.top + box.height / 2), behavior: "instant" });
    let end = start + text.from.length;
    if (text.firstLine) {
      const top = glyph(start).top;
      end = start + 1;
      while (end < all.length && Math.abs(glyph(end).top - top) < 2) end += 1;
      while (all[end - 1] === " ") end -= 1;
    } else if (text.to !== undefined) {
      const at = all.indexOf(text.to, end);
      if (at < 0) throw new Error(`"${text.to}" does not follow "${text.from}" in the part`);
      end = at + text.to.length;
    }
    const range = document.createRange();
    range.setStart(...point(start, false));
    range.setEnd(...point(end, true));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const line = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).at(-1) ?? range.getBoundingClientRect();
    if (matchMedia("(pointer: coarse)").matches) {
      node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", clientX: line.right, clientY: line.top + line.height / 2 }));
    } else node.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift", shiftKey: false }));
  }, { from, to, firstLine });
}

/** Writes `text` in the open popover's field and saves it with Ctrl+Enter; returns once the popover is gone. */
async function saveTyped(page: Page, text: string): Promise<void> {
  await fieldFocused(page);
  await fieldOf(page).fill(text);
  await page.keyboard.press("Control+Enter");
  await popoverOf(page).waitFor({ state: "detached" });
}

/** A comment `text` on all of `part`, by a click on `word` in it; returns once its pin is there. */
async function commentBlock(page: Page, part: Locator, word: string, text: string): Promise<void> {
  const before = await pinsOf(page).count();
  await clickWord(page, part, word);
  await saveTyped(page, text);
  await eventually(`the pin of "${text}"`, async () => (await pinsOf(page).count()) === before + 1);
}

/**
 * A comment `text` on the selection `from`…`to` of `part`, made by a mouse's drag, then stored as an earlier version
 * kept it, without a point (its pin after the end of its text), and the page reloaded to read it so; returns once its
 * pin is there.
 */
async function pointlessSelectionComment(page: Page, part: Locator, from: string, to: string, text: string): Promise<void> {
  const before = await pinsOf(page).count();
  await dragSelect(page, part, from, to);
  await saveTyped(page, text);
  await eventually(`the pin of "${text}"`, async () => (await pinsOf(page).count()) === before + 1);
  await page.evaluate((wanted) => {
    for (const key of Object.keys(localStorage).filter((name) => name.startsWith("herdr-web-ui:block-comments:"))) {
      const data = JSON.parse(localStorage.getItem(key)!) as { comments: { comment: string; point?: unknown }[] };
      for (const comment of data.comments) if (comment.comment === wanted) delete comment.point;
      localStorage.setItem(key, JSON.stringify(data));
    }
  }, text);
  await page.reload();
  await page.locator(".conn-live").waitFor();
  await partOf(page, INTRO).waitFor();
  await eventually(`the pin of "${text}" after the reload`, async () => (await pinsOf(page).count()) === before + 1);
  assert.equal(await storedPoint(page, text), undefined, "stored without a point");
}

/** No Comment button anywhere: there is none, whatever selected text. */
const assertNoButton = async (page: Page, what: string): Promise<void> => {
  assert.equal(await page.locator(".comment-selection").count(), 0, `${what}: no Comment button`);
};

/**
 * For each pin (or the provisional one, `pending`; only those whose name holds `named`), where its tip (its square top
 * left corner) lies against the end of the last line of highlighted text nearest to it: `dx` from the line's right end,
 * `dy` from the line's middle. Lines are measured as the pins are placed: the text nodes in a range, without controls or
 * hidden text.
 */
const pinOffsets = (page: Page, pending = false, named?: string): Promise<{ dx: number; dy: number }[]> => page.evaluate(({ isPending, named }) => {
  const registry = (CSS as unknown as { highlights?: { get(key: string): Iterable<Range> | undefined } }).highlights;
  const ranges = [...(registry?.get(isPending ? "block-comment-pending" : "block-comment") ?? [])];
  const skipped = ".comment-pins, .markdown-code-header, button:not(.markdown-file), [aria-hidden='true'], .katex-mathml";
  const lastLine = (range: Range): DOMRect | undefined => {
    const container = range.commonAncestorContainer;
    const nodes: Text[] = [];
    if (container instanceof Text) nodes.push(container);
    else {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (let next = walker.nextNode(); next; next = walker.nextNode()) if (range.intersectsNode(next)) nodes.push(next as Text);
    }
    let last: DOMRect | undefined;
    for (const node of nodes) {
      if (node.parentElement?.closest(skipped)) continue;
      const piece = document.createRange();
      piece.selectNodeContents(node);
      if (node === range.startContainer) piece.setStart(node, range.startOffset);
      if (node === range.endContainer) piece.setEnd(node, range.endOffset);
      for (const rect of piece.getClientRects()) if (rect.width > 0 && rect.height > 0) last = rect;
    }
    return last;
  };
  const lines = ranges.map(lastLine).filter((line): line is DOMRect => line !== undefined);
  const pins = [...document.querySelectorAll(isPending ? ".chat-view .comment-pin.is-pending" : ".chat-view .comment-pin:not(.is-pending)")]
    .filter((pin) => named === undefined || (pin.getAttribute("aria-label") ?? "").includes(named));
  return pins.map((pin) => {
    const box = pin.getBoundingClientRect();
    let best = { dx: Number.POSITIVE_INFINITY, dy: Number.POSITIVE_INFINITY };
    for (const line of lines) {
      const dx = box.left - line.right;
      const dy = box.top - (line.top + line.height / 2);
      if (Math.abs(dx - 4) + Math.abs(dy) < Math.abs(best.dx - 4) + Math.abs(best.dy)) best = { dx, dy };
    }
    return best;
  });
}, { isPending: pending, named });

/** How far right of the end of its text a pin's tip may be: its gap (4px), and a little for rounding. */
const PIN_REACH_PX = 8;
/**
 * Every pin (or the provisional one; only those whose name holds `named`) without a point, a selection's made with the
 * keyboard or a finger: its tip within `PIN_REACH_PX` right of its text's last line, at that line's middle: polled.
 */
async function assertPinsAtText(page: Page, what: string, { pending = false, count, named }: { pending?: boolean; count?: number; named?: string } = {}): Promise<void> {
  let seen: { dx: number; dy: number }[] = [];
  await eventually(`${what}: each pin's tip within ${PIN_REACH_PX}px right of its text's last line, at its middle`, async () => {
    seen = await pinOffsets(page, pending, named);
    return seen.length > 0 && (count === undefined || seen.length === count) && seen.every(({ dx, dy }) => dx >= 0 && dx <= PIN_REACH_PX && Math.abs(dy) <= 2);
  }).catch((error: Error) => { throw new Error(`${error.message} (offsets ${JSON.stringify(seen)})`); });
}

/** How far a pin's tip may lie from the point it was made at: rounding, the fractions' four decimals. */
const TIP_SLACK_PX = 3;
/** The tip (the square top left corner) of `pin`, in client pixels. */
const tipOf = async (pin: Locator): Promise<{ x: number; y: number }> => {
  const box = await pin.boundingBox();
  if (box === null) throw new Error("the pin is not drawn");
  return { x: box.x, y: box.y };
};
/** `pin`'s tip lies within `TIP_SLACK_PX` of `at`, where that point is now that the chat may have scrolled: polled. */
async function assertTipAt(page: Page, pin: Locator, at: Pointed, what: string): Promise<void> {
  let seen: unknown = null;
  await eventually(`${what}: its pin's tip at (${at.x.toFixed(1)}, ${at.y.toFixed(1)})`, async () => {
    const tip = await tipOf(pin).catch(() => null);
    const y = at.y - ((await scrollOf(page)) - at.scroll);
    seen = { tip, want: { x: at.x, y } };
    return tip !== null && Math.abs(tip.x - at.x) <= TIP_SLACK_PX && Math.abs(tip.y - y) <= TIP_SLACK_PX;
  }).catch((error: Error) => { throw new Error(`${error.message} (${JSON.stringify(seen)})`); });
}

/** The bubble: a square top left corner (its tip), the other three round. */
async function assertBubble(pin: Locator): Promise<void> {
  const radii = await pin.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map((value) => parseFloat(value));
  });
  assert.ok(radii[0] === 0 && radii.slice(1).every((radius) => radius >= 10), `the pin is a bubble with a square top left corner (${radii.join(", ")})`);
}

/** The popover beside its pin lies to the pin's right, 8px from it, its top level with the pin's top: polled. */
async function assertBesideRight(page: Page, pin: Locator, what: string): Promise<void> {
  let seen: unknown = null;
  await eventually(`${what}: the popover right of its pin, top-aligned`, async () => {
    const pinBox = await pin.boundingBox();
    const place = page.locator(".chat-view .comment-popover-place");
    const box = await place.boundingBox().catch(() => null);
    const side = await place.getAttribute("data-side").catch(() => null);
    seen = { pinBox, box, side };
    return pinBox !== null && box !== null && side === "right" && Math.abs(box.x - (pinBox.x + pinBox.width + 8)) <= 1 && Math.abs(box.y - pinBox.y) <= 1;
  }).catch((error: Error) => { throw new Error(`${error.message} (${JSON.stringify(seen)})`); });
}

/** The stored point of the comment whose text is `comment`. */
const storedPoint = async (page: Page, comment: string): Promise<{ x: number; y: number } | undefined> =>
  (await storedOf(page)).find((entry) => entry.comment === comment)?.point;

/** Where a box lies against the chat view's visible box: whether it is inside it (1px of slack). */
const inView = (page: Page, selector: string): Promise<boolean> => page.evaluate((wanted) => {
  const node = document.querySelector(wanted);
  const view = document.querySelector(".chat-view")!;
  if (node === null) return false;
  const box = node.getBoundingClientRect();
  const outer = view.getBoundingClientRect();
  const top = outer.top + view.clientTop;
  return box.height > 0 && box.top >= top - 1 && box.bottom <= top + view.clientHeight + 1;
}, selector);

/** The chat view's scroll position stays put for a few frames in a row: a smooth scroll has ended. */
async function scrollSettled(page: Page): Promise<void> {
  let last = -1;
  let still = 0;
  await eventually("the chat view to stop scrolling", async () => {
    await frames(page, 2);
    const now = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
    still = now === last ? still + 1 : 0;
    last = now;
    return still >= 3;
  }, 5000);
}

/** The context and page of a case: the pane's chat, its reply drawn. `errors` collects the page's, `sent` the texts it submitted to the pane. */
interface Opened { page: Page; context: BrowserContext; url: string; errors: string[]; sent: string[]; close: () => Promise<void> }
type Open = (options: BrowserContextOptions, seed?: { comments?: readonly object[]; settings?: Record<string, unknown> }) => Promise<Opened>;
type Case = (open: Open) => Promise<void>;

/** A stored comment on a reply that is not in the chat: its turn is not loaded. The walk reaches it with no pin. */
const UNLOADED = {
  id: "unloaded-1",
  anchor: "2026-01-01T00:00:00.000Z:0:0",
  order: [Date.parse("2026-01-01T00:00:00.000Z"), 0, 0],
  block: { type: "paragraph", lines: [[{ type: "text", value: "A reply from a turn the chat has not loaded." }]] },
  comment: "Is this still true?",
};

const cases: Record<string, Case> = {
  async selection(open) {
    const { page, errors, close } = await open(DESKTOP);
    const intro = partOf(page, INTRO);
    // a mouse's drag: the comment opens as it lets go, no Comment button, the provisional pin's tip where it let go
    const release = await dragSelect(page, intro, "paragraph", "state");
    await pendingPinOf(page).waitFor();
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    assert.equal(await page.locator(".chat-view .comment-selection").count(), 0, "a mouse's drag needs no Comment button");
    await assertTipAt(page, pendingPinOf(page), release, "the provisional pin of a dragged selection");
    await assertBubble(pendingPinOf(page));
    await assertBesideRight(page, pendingPinOf(page), "a dragged selection's new comment");
    await fieldOf(page).fill("Say which state.");
    await page.keyboard.press("Control+Enter");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("one pin", async () => (await pinsOf(page).count()) === 1 && (await pendingPinOf(page).count()) === 0);
    await assertTipAt(page, pinsOf(page).first(), release, "a dragged selection's saved comment");
    assert.ok((await storedPoint(page, "Say which state.")) !== undefined, "the comment keeps where the drag let go");
    assert.equal(await page.locator(".chat-transcript [data-comment-id], .chat-transcript .comment-pins, .chat-transcript .comment-popover").count(), 0, "no comment element is drawn inside the transcript, under the text");
    assert.ok(!((await page.locator(".chat-transcript").first().textContent()) ?? "").includes("Say which state."), "the comment's text is not drawn in the transcript");
    assert.ok((await highlighted(page)) > 0, "the selected text is highlighted");
    const stored = await storedOf(page);
    assert.deepEqual(stored.map((entry) => [entry.comment, entry.quote]), [["Say which state.", "paragraph about the state"]]);
    assert.equal(await pinsOf(page).first().getAttribute("aria-label"), "Comment on “paragraph about the state”: Say which state.");
    await pinsOf(page).first().click();
    await besidePinOf(page).waitFor();
    await assertBesideRight(page, pinsOf(page).first(), "a saved comment opened by its pin");
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "Say which state.", "the pin opens the comment in its field");
    await page.mouse.move(2, 2);
    await assertUp(page, "paragraph about the state", "a selection's comment opened by its pin");
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    console.log("PASS selection: a mouse's drag opens the popover at once, right of a provisional bubble whose tip is where it let go, the field focused; Ctrl+Enter leaves one pin there, no card");

    // a keyboard's selection (no drag) opens nothing, and there is no Comment button for it
    const long = partOf(page, "A longer paragraph");
    await select(long, "longer", { to: "several" });
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a keyboard selection opens nothing");
    await assertNoButton(page, "a keyboard selection");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    console.log("PASS selection: a keyboard selection opens nothing, and no Comment button shows");

    /** A drag of the mouse from `start` to `end` (client pixels): opens a new comment beside its provisional pin, never a button; closed again. */
    const dragOpens = async (start: { x: number; y: number }, end: { x: number; y: number }, what: string): Promise<string> => {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
      await page.mouse.move(end.x, end.y, { steps: 4 });
      await page.mouse.up();
      await besidePinOf(page).waitFor().catch(() => { throw new Error(`${what}: no popover opened`); });
      await pendingPinOf(page).waitFor();
      await fieldFocused(page);
      await assertNoButton(page, what);
      assert.equal(await popoverOf(page).locator(".comment-popover-quote").count(), 0, `${what}: beside its pin the popover quotes nothing`);
      const quote = await highlightText(page);
      await page.keyboard.press("Escape");
      await popoverOf(page).waitFor({ state: "detached" });
      return quote;
    };
    /** Where `word` starts (or ends, `end`) in `part`, in client pixels, without scrolling. */
    const edge = (part: Locator, word: string, end = false): Promise<{ x: number; y: number; right: number; bottom: number }> => part.evaluate((node, wanted) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let next = walker.nextNode(); next; next = walker.nextNode()) {
        const at = (next as Text).data.indexOf(wanted.word);
        if (at < 0) continue;
        const offset = wanted.end ? at + wanted.word.length - 1 : at;
        const range = document.createRange();
        range.setStart(next, offset);
        range.setEnd(next, offset + 1);
        const rect = range.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return { x: wanted.end ? rect.right - 1 : rect.left + 1, y: rect.top + rect.height / 2, right: box.right, bottom: box.bottom };
      }
      throw new Error(`"${wanted.word}" is not in the part`);
    }, { word, end });
    const docs = partOf(page, "See docs");
    await docs.evaluate((node) => node.scrollIntoView({ block: "center" }));
    // let go past the end of the line, in the empty space right of it
    const see = await edge(docs, "See");
    const seeLine = await docs.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);
      return { right: Math.max(...rects.map((rect) => rect.right)), y: rects[0]!.top + rects[0]!.height / 2 };
    });
    assert.ok((await dragOpens(see, { x: seeLine.right + 120, y: seeLine.y }, "a drag let go past the end of its line")).includes("See docs"));
    // let go in the margin under a paragraph, before the next block
    await intro.evaluate((node) => node.scrollIntoView({ block: "center" }));
    const introStart = await edge(intro, "Intro");
    const gap = await intro.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const next = node.closest(".markdown-block, p")!.nextElementSibling!.getBoundingClientRect();
      return { x: box.left + box.width / 3, y: (box.bottom + next.top) / 2, room: next.top - box.bottom };
    });
    assert.ok(gap.room >= 4, `a margin lies under the paragraph (${gap.room}px)`);
    assert.ok((await dragOpens(introStart, gap, "a drag let go in the margin under its paragraph")).includes("Intro"));
    // across two paragraphs: one comment on both
    await long.evaluate((node) => node.scrollIntoView({ block: "center" }));
    const across = await dragOpens(await edge(long, "longer"), await edge(partOf(page, "Checksum"), "Checksum", true), "a drag across two paragraphs");
    assert.ok(across.includes("several lines") && across.includes("Checksum"), `the quote holds both paragraphs (${across})`);
    console.log("PASS selection: a drag let go past the end of its line, in the margin under its paragraph, or across two paragraphs opens the popover at once, never a Comment button");
    assert.deepEqual(errors, []);
    await close();
  },

  async "block-click"(open) {
    const { page, errors, close } = await open(DESKTOP);
    const long = partOf(page, "A longer paragraph");
    // a pointer over a block frames it (a tint and two box shadows, BlockComments.css), only while no popover is open
    const framed = (): Promise<boolean> => long.evaluate((node) => getComputedStyle(node.closest(".is-commentable") ?? node).boxShadow !== "none");
    await long.hover();
    await eventually("the hovered paragraph to be framed", framed);
    const clicked = await clickWord(page, long, "several");
    await besidePinOf(page).waitFor();
    assert.equal(await framed(), false, "no frame on the block while its popover is open");
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "", "a new comment's field starts empty");
    assert.equal(await popoverOf(page).getByRole("button", { name: "Close", exact: true }).count(), 0, "a comment being written beside its pin has no ✕");
    await pendingPinOf(page).waitFor();
    // the provisional bubble's tip is where the paragraph was clicked, not at its end; the popover right of it
    await assertTipAt(page, pendingPinOf(page), clicked, "the provisional pin of a clicked block");
    await assertBubble(pendingPinOf(page));
    await assertBesideRight(page, pendingPinOf(page), "a clicked block's new comment");
    await fieldOf(page).fill("Too long for a phone?");
    await page.keyboard.press("Control+Enter");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("the block comment's pin", async () => (await pinsOf(page).count()) === 1);
    const stored = await storedOf(page);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.quote, undefined, "a block click comments on the whole block, no quote");
    assert.ok(stored[0]!.point !== undefined && stored[0]!.point.x > 0 && stored[0]!.point.x < 1, `the comment keeps where it was clicked (${JSON.stringify(stored[0]!.point)})`);
    await assertTipAt(page, pinsOf(page).first(), clicked, "a clicked block's saved comment");
    await assertBubble(pinsOf(page).first());

    // the same block clicked again elsewhere: its comment, to edit, its pin where it was first put
    await clickWord(page, long, "paragraph");
    await besidePinOf(page).waitFor();
    await assertTipAt(page, pinsOf(page).first(), clicked, "a block clicked again elsewhere");
    await assertBesideRight(page, pinsOf(page).first(), "a clicked block's comment opened again");
    assert.deepEqual((await storedOf(page)).map((entry) => entry.point), [stored[0]!.point], "the second click moves no point");
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "Too long for a phone?", "the click opens the comment in its field");
    assert.equal(await closeOf(page).count(), 0, "a saved comment beside its pin has no ✕");
    assert.equal(await deleteOf(page).count(), 1, "its Delete is in view");
    await assertUp(page, "A longer paragraph", "a block's comment opened by a click");
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    console.log("PASS block-click: a pointer over a paragraph frames it, and the frame goes while a popover is open; a click on a paragraph opens a new comment right of a provisional bubble whose tip is where it was clicked; saved, the pin stays there; clicked again elsewhere, its comment opens in its field, its text up, the pin unmoved");

    // with a popover open, a press outside it only closes it: a click on another block opens nothing there, and the
    // next click does
    const step = partOf(page, "Step 3 of the rollout");
    const closedOnly = async (what: string): Promise<void> => {
      await popoverOf(page).waitFor({ state: "detached" });
      await frames(page, 10);
      assert.equal(await popoverOf(page).count(), 0, `${what}: no popover opens`);
      assert.equal(await pendingPinOf(page).count(), 0, `${what}: no provisional pin`);
    };
    await clickWord(page, partOf(page, INTRO), "Intro");
    await fieldFocused(page);
    await clickWord(page, step, "rollout");
    await closedOnly("a click on another block with a new comment open");
    await clickWord(page, step, "rollout");
    await besidePinOf(page).waitFor();
    await pendingPinOf(page).waitFor();
    assert.ok((await highlightText(page)).includes("Step 3"), "the next click opens a comment on the block");
    // a saved comment's popover the same
    await pinsOf(page).first().click();
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "Too long for a phone?", "a press on a pin switches straight to its comment");
    await clickWord(page, step, "rollout");
    await closedOnly("a click on another block with a saved comment open");
    // a drag that starts while a popover is open closes it and opens its own selection's comment at once
    await clickWord(page, partOf(page, INTRO), "Intro");
    await fieldFocused(page);
    await dragSelect(page, step, "Step", "rollout");
    await besidePinOf(page).waitFor();
    await pendingPinOf(page).waitFor();
    await fieldFocused(page);
    assert.equal(await popoverOf(page).count(), 1, "one popover: the drag's");
    assert.ok((await highlightText(page)).includes("Step 3 of the rollout"), "the drag's new comment is on its selection");
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    console.log("PASS block-click: with a popover open (new or saved), a click on another block only closes it, nothing opens, and the next click opens a comment; a drag closes it and opens its selection's comment at once; a press on a pin switches to its comment");
    assert.deepEqual(errors, []);
    await close();
  },

  async "edit-delete"(open) {
    const { page, errors, close } = await open(DESKTOP);
    await commentBlock(page, partOf(page, INTRO), "Intro", "First note.");
    await commentBlock(page, partOf(page, "A longer paragraph"), "several", "Second note.");
    const first = pinsOf(page).first();
    assert.equal(await first.getAttribute("aria-label"), `Comment on “${INTRO}”: First note.`, "pins are in reading order");

    // the pin opens the comment straight into its field, the caret at its end: no view to read first, no ⋯ menu
    await first.click();
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "First note.", "the pin opens the field with the comment");
    assert.deepEqual(await fieldOf(page).evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]), [11, 11], "the caret at its end");
    assert.equal(await popoverOf(page).getByRole("button", { name: "More", exact: true }).count(), 0, "no ⋯ menu");
    assert.equal(await closeOf(page).count(), 0, "no ✕ beside its pin");
    // beside its pin a saved comment is its field alone, as in Claude: the highlighted text beside it is what it is on
    assert.equal(await popoverOf(page).locator(".comment-popover-quote").count(), 0, "a saved comment beside its pin quotes nothing");
    // its text stays up while the field has the focus, the pointer off the pin: the other comment's mark goes (focus mode)
    await page.mouse.move(2, 2);
    await assertUp(page, INTRO, "a saved comment opened by its pin, the focus in its field");
    assert.ok(!(await upInChat(page)).text.includes("A longer paragraph"), "only the open comment is up");
    // Delete is in view, at the left of the field's footer, ↑ at its right
    assert.ok(await deleteOf(page).isVisible(), "Delete is in view, without a menu");
    const footer = await popoverOf(page).evaluate((node) => {
      const bin = node.querySelector(".comment-popover-delete")!.getBoundingClientRect();
      const save = node.querySelector(".comment-popover-save")!.getBoundingClientRect();
      const box = node.querySelector(".comment-popover-edit")!.getBoundingClientRect();
      return { bin: bin.left - box.left, save: box.right - save.right, row: Math.abs(bin.top - save.top) };
    });
    assert.ok(footer.bin < 12 && footer.save < 12 && footer.row < 1, `Delete at the box's bottom left, ↑ at its bottom right (${JSON.stringify(footer)})`);
    await fieldOf(page).fill("First note, changed.");
    await page.keyboard.press("Control+Enter");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("the pin's name to follow the edit", async () => (await pinsOf(page).first().getAttribute("aria-label")) === `Comment on “${INTRO}”: First note, changed.`);
    console.log("PASS edit-delete: a pin opens its comment in the field, caret at the end, no ⋯ or ✕, its text up while the field has the focus; saved, the pin's name changes");

    await pinsOf(page).first().click();
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    await deleteOf(page).click();
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("one pin left", async () => (await pinsOf(page).count()) === 1);
    await eventually("the focus on the next pin", () => pinsOf(page).first().evaluate((node) => node === document.activeElement && node.getAttribute("aria-label")!.endsWith("Second note.")));
    assert.deepEqual((await storedOf(page)).map((entry) => entry.comment), ["Second note."]);

    await pinsOf(page).first().click();
    await besidePinOf(page).waitFor();
    await deleteOf(page).click();
    await eventually("no pin left", async () => (await pinsOf(page).count()) === 0);
    await eventually("the focus on the composer", () => focusedMatches(page, ".composer-text"));
    assert.deepEqual(await storedOf(page), []);
    await eventually("no highlight left", async () => (await highlighted(page)) === 0 && (await upInChat(page)).ranges === 0 && !(await upInChat(page)).focus);
    console.log("PASS edit-delete: Delete beside ↑ takes the comment and its pin at once; the focus goes to the next pin, then to the composer");
    assert.deepEqual(errors, []);
    await close();
  },

  async escape(open) {
    const { page, errors, close } = await open(DESKTOP);
    const intro = partOf(page, INTRO);
    await clickWord(page, intro, "Intro");
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("the provisional pin to go with it", async () => (await pendingPinOf(page).count()) === 0);

    await clickWord(page, intro, "Intro");
    await fieldFocused(page);
    await fieldOf(page).fill("Not lost");
    await page.keyboard.press("Escape");
    await frames(page);
    assert.equal(await popoverOf(page).count(), 1, "Escape leaves a popover with text typed in it");
    // a click outside it, on text that is not a reply's
    await clickWord(page, page.locator(".chat-turn-user"), "plan");
    await frames(page);
    assert.equal(await popoverOf(page).count(), 1, "a click outside leaves it too");
    assert.equal(await fieldOf(page).inputValue(), "Not lost");
    assert.ok(await focusedMatches(page, ".comment-popover textarea"), "and puts the focus back in its field");
    // another block clicked: the open one keeps its place, and the focus goes back to its field
    await clickWord(page, partOf(page, "A longer paragraph"), "several");
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "Not lost");
    assert.equal(await pinsOf(page).count(), 0);
    console.log("PASS escape: Escape closes an untouched popover; with text typed it stays open on Escape, a click outside (the focus back in its field) and another block's click");

    // a saved comment opened by its pin: no ✕ beside it; unchanged, Escape and a click outside close it, and its text goes down
    await page.keyboard.press("Control+Enter");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("its pin", async () => (await pinsOf(page).count()) === 1);
    const pin = pinsOf(page).first();
    await pin.click();
    await fieldFocused(page);
    assert.equal(await closeOf(page).count(), 0, "a saved comment beside its pin has no ✕");
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    await pin.click();
    await fieldFocused(page);
    await page.mouse.move(2, 2);
    await assertUp(page, INTRO, "a saved comment opened again");
    await clickWord(page, page.locator(".chat-turn-user"), "plan");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("its text to go down as it closes", async () => (await upInChat(page)).ranges === 0 && !(await upInChat(page)).focus);
    // changed: Escape and a click outside keep it, each putting the focus back in its field
    await pin.click();
    await fieldFocused(page);
    await page.keyboard.type(" More.");
    await page.keyboard.press("Escape");
    await frames(page);
    assert.equal(await popoverOf(page).count(), 1, "Escape keeps a changed comment");
    assert.ok(await focusedMatches(page, ".comment-popover textarea"), "the focus stays in its field");
    await deleteOf(page).focus();
    await page.keyboard.press("Escape");
    await fieldFocused(page);
    assert.equal(await popoverOf(page).count(), 1, "Escape from its Delete keeps it too, the focus back in the field");
    await clickWord(page, page.locator(".chat-turn-user"), "plan");
    await frames(page);
    assert.equal(await popoverOf(page).count(), 1, "a click outside keeps a changed comment");
    assert.ok(await focusedMatches(page, ".comment-popover textarea"), "and puts the focus back in its field");
    assert.equal(await fieldOf(page).inputValue(), "Not lost More.");
    await assertUp(page, INTRO, "a changed comment kept open");
    // its change undone, it is unchanged again: Escape closes it
    await fieldOf(page).fill("Not lost");
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    assert.deepEqual((await storedOf(page)).map((entry) => entry.comment), ["Not lost"]);
    console.log("PASS escape: a saved comment beside its pin has no ✕; unchanged, Escape and a click outside close it and its text goes down; changed, both keep it with the focus back in the field");
    assert.deepEqual(errors, []);
    await close();
  },

  async "double-click"(open) {
    const { page, errors, close } = await open(DESKTOP);
    const selected = (): Promise<string | undefined> => page.evaluate(() => window.getSelection()?.toString().trim());
    const at = await wordPoint(partOf(page, "A longer paragraph"), "several");
    // the double click's first click alone: it opens a new comment on the paragraph
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ clickCount: 1 });
    await page.mouse.up({ clickCount: 1 });
    await besidePinOf(page).waitFor();
    await pendingPinOf(page).waitFor();
    // its second click selects the word, and the untouched new comment closes
    await page.mouse.down({ clickCount: 2 });
    await page.mouse.up({ clickCount: 2 });
    await eventually("the popover the first click opened to close", async () => (await popoverOf(page).count()) === 0 && (await pendingPinOf(page).count()) === 0);
    assert.equal(await selected(), "several", "the word is selected");
    // the word it selected is no mouse's drag: it is there to copy, and nothing opens for it, no Comment button either
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a double click's word selection opens no comment");
    assert.equal(await pendingPinOf(page).count(), 0);
    await assertNoButton(page, "a double click's word selection");
    assert.equal(await selected(), "several", "the word stays selected");
    console.log("PASS double-click: a double click opens a new comment with its first click, then selects a word and leaves no popover; the word selection opens nothing, no Comment button");

    // a triple click selects the paragraph, to copy: nothing opens, nothing shows
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    const intro = await wordPoint(partOf(page, INTRO), "about");
    await page.mouse.move(intro.x, intro.y);
    for (const clickCount of [1, 2, 3]) {
      await page.mouse.down({ clickCount });
      await page.mouse.up({ clickCount });
    }
    await frames(page, 10);
    assert.equal(await selected(), INTRO, "the paragraph is selected");
    assert.equal(await popoverOf(page).count(), 0, "a triple click opens no comment");
    assert.equal(await pendingPinOf(page).count(), 0);
    await assertNoButton(page, "a triple click's selection");
    console.log("PASS double-click: a triple click selects the paragraph to copy; nothing opens and no Comment button shows");

    // a double click inside an open untouched popover (a word typed in its field) selects that word, and the popover stays
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await clickWord(page, partOf(page, INTRO), "Intro");
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    const field = await fieldOf(page).boundingBox();
    assert.ok(field !== null);
    await page.mouse.dblclick(field.x + 4, field.y + field.height / 2);
    await frames(page);
    assert.equal(await besidePinOf(page).count(), 1, "the popover stays open");
    console.log("PASS double-click: a double click inside an untouched popover keeps the popover");
    assert.deepEqual(errors, []);
    await close();
  },

  async keyboard(open) {
    const { page, errors, close } = await open(DESKTOP);
    await commentBlock(page, partOf(page, INTRO), "Intro", "Keys one.");
    await commentBlock(page, partOf(page, "A longer paragraph"), "several", "Keys two.");
    // the mouse off the pins (the last one was drawn under it), so only the keyboard brings a comment's text up
    await page.mouse.move(2, 2);
    // from the transcript's last control, Tab goes on to the pins, in reading order
    await page.evaluate(() => {
      const stops = [...document.querySelectorAll<HTMLElement>(".chat-transcript a[href], .chat-transcript button:not(:disabled), .chat-transcript summary, .chat-transcript [tabindex]")]
        .filter((node) => node.tabIndex >= 0 && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden");
      stops.at(-1)!.focus();
    });
    const focusedName = (): Promise<string | null> => page.evaluate(() => document.activeElement?.matches(".comment-pin") ? document.activeElement.getAttribute("aria-label") : null);
    await page.keyboard.press("Tab");
    assert.equal(await focusedName(), `Comment on “${INTRO}”: Keys one.`, "Tab reaches the first pin");
    await page.keyboard.press("Tab");
    assert.equal(await focusedName(), `Comment on “${LONG_PARAGRAPH.slice(0, 31)}…”: Keys two.`, "then the second");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focusedName(), `Comment on “${INTRO}”: Keys one.`);
    await page.keyboard.press("Enter");
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "Keys one.", "Enter on a pin opens its comment in the field");
    // the pin's keyboard focus moved into the field: the comment's text stays up while its popover is open
    await assertUp(page, INTRO, "a pin opened with Enter, the focus in its field");
    assert.ok(!(await upInChat(page)).text.includes("A longer paragraph"), "only the open comment is up");
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("the focus back on the pin", async () => (await focusedName()) === `Comment on “${INTRO}”: Keys one.`);
    console.log("PASS keyboard: Tab reaches the pins in reading order, Enter opens one in its field, its text up, Escape closes it with the focus back on its pin");

    // saved changed (a new id): the same pin stays, and the focus goes back to it
    const pinBefore = await page.evaluateHandle(() => document.activeElement);
    await page.keyboard.press("Enter");
    await fieldFocused(page);
    await page.keyboard.type(" Edited.");
    await page.keyboard.press("ControlOrMeta+Enter");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("the focus back on the edited comment's pin", async () => (await focusedName()) === `Comment on “${INTRO}”: Keys one. Edited.`);
    assert.ok(await page.evaluate((node) => node === document.activeElement && (node as Element).isConnected, pinBefore), "the edited comment keeps its pin element");
    console.log("PASS keyboard: an edit saved with Cmd/Ctrl+Enter keeps its pin, with the focus back on it");

    // the popover beside a pin comes right after that pin in the tab order: Shift+Tab from it goes back to its own pin,
    // Tab from its own pin into it, and Tab out of it on to the next pin (not past the remaining pins)
    await page.keyboard.press("Enter");
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    assert.ok(await page.evaluate(() => {
      const place = document.querySelector(".chat-view .comment-popover-place");
      return place?.previousElementSibling?.matches(".comment-pin") === true && place.nextElementSibling?.matches(".comment-pin") === true;
    }), "the popover's place lies between its pin and the next one");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focusedName(), `Comment on “${INTRO}”: Keys one. Edited.`, "Shift+Tab from the popover goes back to its own pin");
    assert.equal(await besidePinOf(page).count(), 1, "the popover stays open");
    await page.keyboard.press("Tab");
    assert.ok(await focusedMatches(page, ".comment-popover *"), "Tab from its pin goes into the popover");
    // its field, then Delete, then out: ↑ is disabled while the comment is unchanged, so Tab passes it
    const stops: string[] = [];
    for (let step = 0; step < 6 && await focusedMatches(page, ".comment-popover, .comment-popover *"); step++) {
      stops.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
      await page.keyboard.press("Tab");
    }
    assert.deepEqual(stops, ["Comment", "Delete comment"], "Tab goes through the field and Delete, past the disabled ↑");
    assert.equal(await focusedName(), `Comment on “${LONG_PARAGRAPH.slice(0, 31)}…”: Keys two.`, "Tab out of the popover goes on to the next pin");
    // changed, ↑ is a stop too
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await fieldFocused(page);
    await page.keyboard.type(" Edited.");
    assert.equal(await page.locator(".comment-popover-save").isEnabled(), true, "a change enables ↑");
    const changed: string[] = [];
    for (let step = 0; step < 6 && await focusedMatches(page, ".comment-popover, .comment-popover *"); step++) {
      changed.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
      await page.keyboard.press("Tab");
    }
    assert.deepEqual(changed, ["Comment", "Delete comment", "Save comment"], "with a change, Tab goes through the field, Delete and ↑");
    console.log("PASS keyboard: the popover sits after its own pin in the tab order: Shift+Tab goes back to that pin, Tab through its field, Delete (and ↑ once changed) out to the next pin");
    assert.deepEqual(errors, []);
    await close();
  },

  async walk(open) {
    // a view shorter than the reply: the walk scrolls to the intro from the end
    const { page, context, url, errors, close } = await open({ viewport: { width: 1280, height: 720 } }, { comments: [UNLOADED] });
    await commentBlock(page, partOf(page, INTRO), "Intro", "Walk here.");
    const scrolls = await page.locator(".chat-view").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      return node.scrollHeight - node.clientHeight;
    });
    assert.ok(scrolls > 200, `the chat scrolls (${scrolls}px)`);
    await scrollSettled(page);
    assert.equal(await inView(page, ".chat-view .comment-pin:not(.is-pending)"), false, "the pin is out of view before the walk");

    await walkOf(page).click();
    await besidePinOf(page).waitFor();
    assert.equal(await fieldOf(page).inputValue(), "Walk here.", "the walk opens a comment in its field, to edit");
    assert.equal(await deleteOf(page).count(), 1, "with its Delete");
    assert.equal(await page.locator(".chat-view .comment-pin.is-current").count(), 1, "its pin is the current one");
    assert.equal(await page.locator(".chat-view .comment-pin.is-current").getAttribute("aria-label"), `Comment on “${INTRO}”: Walk here.`);
    // the walk's smooth scroll and the popover's own scroll into view do not cut each other short: once settled, the
    // text, its pin and the popover are all on screen
    await scrollSettled(page);
    assert.ok(await inView(page, ".chat-view .comment-pin.is-current"), "the pin is in view");
    assert.ok(await inView(page, ".chat-view .comment-popover"), "the popover is in view");
    assert.ok(await page.evaluate(() => {
      const marks = (CSS as unknown as { highlights: { get(key: string): Iterable<Range> | undefined } }).highlights.get("block-comment-current");
      const range = marks === undefined ? undefined : [...marks][0];
      const view = document.querySelector(".chat-view")!.getBoundingClientRect();
      const box = range?.getBoundingClientRect();
      return box !== undefined && box.height > 0 && box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
    }), "its text, the current highlight, is in view");
    await fieldFocused(page);
    await assertUp(page, INTRO, "the walk's stop, the focus in its field");
    // Escape closes it and hands the focus to the walk control, which walks on with Enter
    await page.keyboard.press("Escape");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("the walk control to take the focus", () => walkOf(page).evaluate((node) => node === document.activeElement));
    assert.equal(await page.locator(".chat-view .comment-pin.is-current").count(), 0, "the mark goes");
    console.log("PASS walk: the comments bar opens the next comment's popover in its field, its pin current, its text up, scrolled into view without the two scrolls fighting");

    await page.keyboard.press("Enter");
    await dialogOf(page).waitFor();
    await fieldFocused(page);
    assert.equal(await fieldOf(page).inputValue(), "Is this still true?", "the dialog opens the comment in its field");
    assert.equal(await dialogOf(page).locator(".comment-popover-quote").innerText(), "A reply from a turn the chat has not loaded.", "it quotes its block");
    assert.equal(await closeOf(page).count(), 1, "a dialog keeps ✕");
    assert.equal(await deleteOf(page).count(), 1, "and Delete");
    // ✕ follows the popover's rule: a change typed keeps the dialog, the focus back in its field
    await fieldOf(page).fill("Is this still true? Check.");
    await closeOf(page).click();
    await frames(page);
    assert.equal(await dialogOf(page).count(), 1, "✕ keeps a changed comment's dialog");
    assert.ok(await focusedMatches(page, ".comment-popover textarea"), "and puts the focus back in its field");
    await fieldOf(page).fill("Is this still true?");
    await page.keyboard.press("Escape");
    await dialogOf(page).waitFor({ state: "detached" });
    await eventually("the walk control to take the focus back", () => walkOf(page).evaluate((node) => node === document.activeElement));
    console.log("PASS walk: a comment whose turn is not loaded opens as a dialog, and gives the focus back to the walk control");

    // the dialog open again (the walk goes round: the pin, then the dialog), and its comment deleted in another tab: it closes
    await page.keyboard.press("Enter");
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    await page.keyboard.press("Escape");
    await eventually("the walk control to take the focus", () => walkOf(page).evaluate((node) => node === document.activeElement));
    await page.keyboard.press("Enter");
    await dialogOf(page).waitFor();
    const other = await context.newPage();
    await other.goto(url);
    await other.evaluate((id) => {
      const key = Object.keys(localStorage).find((name) => name.startsWith("herdr-web-ui:block-comments:"))!;
      const data = JSON.parse(localStorage.getItem(key)!) as { comments: { id: string }[] };
      localStorage.setItem(key, JSON.stringify({ ...data, comments: data.comments.filter((comment) => comment.id !== id) }));
    }, UNLOADED.id);
    await dialogOf(page).waitFor({ state: "detached" });
    await other.close();
    assert.equal(await pinsOf(page).count(), 1, "the other comment stays");
    console.log("PASS walk: the dialog of a comment deleted in another tab closes");
    assert.deepEqual(errors, []);
    await close();
  },

  async reflow(open) {
    const { page, errors, close } = await open(DESKTOP);
    await pointlessSelectionComment(page, partOf(page, INTRO), "paragraph", "about", "Reflow one.");
    const long = partOf(page, "A longer paragraph");
    const clicked = await clickWord(page, long, "several");
    await saveTyped(page, "Reflow two.");
    await eventually("both pins", async () => (await pinsOf(page).count()) === 2);
    const clickedPin = page.locator(".chat-view .comment-pin:not(.is-pending)[aria-label*='Reflow two.']");
    await assertPinsAtText(page, "the selection's pin before the font size changes", { named: "Reflow one.", count: 1 });
    await assertTipAt(page, clickedPin, clicked, "the clicked block's pin before the font size changes");
    const before = await pinsOf(page).evaluateAll((pins) => pins.map((pin) => pin.getBoundingClientRect().left));
    /** the clicked pin's tip lies inside its paragraph's text box, at the fractions it was made at */
    const insideItsBlock = async (what: string): Promise<void> => {
      const point = (await storedPoint(page, "Reflow two."))!;
      let seen: unknown = null;
      await eventually(`${what}: the clicked pin inside its paragraph, at its point`, async () => {
        const tip = await tipOf(clickedPin);
        const box = await long.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
          return { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
        });
        const want = { x: box.left + point.x * (box.right - box.left), y: box.top + point.y * (box.bottom - box.top) };
        seen = { tip, box, want };
        return tip.x >= box.left && tip.x <= box.right && tip.y >= box.top && tip.y <= box.bottom
          && Math.abs(tip.x - want.x) <= TIP_SLACK_PX && Math.abs(tip.y - want.y) <= TIP_SLACK_PX;
      }).catch((error: Error) => { throw new Error(`${error.message} (${JSON.stringify(seen)})`); });
    };
    await insideItsBlock("before the font size changes");
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    const bigger = page.getByRole("button", { name: "Increase chat font size", exact: true });
    for (let step = 0; step < 4; step++) await bigger.click();
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });
    await eventually("the pins to move with the text", async () => {
      const after = await pinsOf(page).evaluateAll((pins) => pins.map((pin) => pin.getBoundingClientRect().left));
      return after.some((left, index) => Math.abs(left - before[index]!) > 4);
    });
    await assertPinsAtText(page, "the selection's pin after the font size changed", { named: "Reflow one.", count: 1 });
    await insideItsBlock("after the font size changed");
    // a narrower window rewraps the paragraph over more lines: the clicked pin keeps its place on it
    await page.setViewportSize({ width: 820, height: 800 });
    await insideItsBlock("after the window narrowed");
    await assertPinsAtText(page, "the selection's pin after the window narrowed", { named: "Reflow one.", count: 1 });
    console.log("PASS reflow: with a larger chat font and a narrower window a selection's pin stored without a point stays at the end of its text, and a clicked block's pin inside its paragraph, at its point");
    assert.deepEqual(errors, []);
    await close();
  },

  async acknowledged(open) {
    const { page, errors, sent, close } = await open(DESKTOP);
    await commentBlock(page, partOf(page, INTRO), "Intro", "Ack me.");
    await pinsOf(page).first().click();
    await besidePinOf(page).waitFor();
    // the message box focused without a press outside the popover, so only the send's acknowledgement can close it
    const message = messageOf(page);
    await message.focus();
    await message.fill("Please look.");
    await page.keyboard.press("Enter");
    await eventually("the message to be sent", async () => sent.length === 1, 5000);
    assert.ok(sent[0]!.includes("Ack me.") && sent[0]!.includes("Please look."), "the comment goes with the message");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("the sent comment's pin to go", async () => (await pinsOf(page).count()) === 0);
    console.log("PASS acknowledged: a saved comment's popover open, unchanged, when its comment is sent closes as the send is acknowledged");

    await clickWord(page, partOf(page, "A longer paragraph"), "several");
    await fieldFocused(page);
    await fieldOf(page).fill("Still typing");
    await message.focus();
    await message.fill("Second message.");
    await page.keyboard.press("Enter");
    await fieldFocused(page);
    await frames(page);
    assert.equal(sent.length, 1, "nothing goes while a comment is being written");
    assert.equal(await fieldOf(page).inputValue(), "Still typing", "the popover stays with its text");
    await page.keyboard.press("Control+Enter");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("its pin", async () => (await pinsOf(page).count()) === 1);
    console.log("PASS acknowledged: with text typed in a popover, a send stays and gives the field the focus; saving makes its pin");

    // a saved comment being edited, with a change typed: the send is held back the same way (the Send guard), so its
    // comment is never acknowledged under the edit; the popover keeps the change, and saving it replaces the comment
    const [saved] = await storedOf(page);
    await pinsOf(page).first().click();
    await besidePinOf(page).waitFor();
    await fieldFocused(page);
    await fieldOf(page).fill("Still typing, changed");
    await message.focus();
    await message.fill("Third message.");
    await page.keyboard.press("Enter");
    await fieldFocused(page);
    await frames(page);
    assert.equal(sent.length, 1, "nothing goes while a saved comment's edit is typed: the send is held back, not acknowledged under it");
    assert.equal(await fieldOf(page).inputValue(), "Still typing, changed", "the edit stays with its text");
    assert.deepEqual((await storedOf(page)).map((entry) => entry.comment), ["Still typing"], "the comment is still stored as it was");
    await page.keyboard.press("Control+Enter");
    await popoverOf(page).waitFor({ state: "detached" });
    await eventually("its pin again", async () => (await pinsOf(page).count()) === 1);
    const edited = await storedOf(page);
    assert.deepEqual(edited.map((entry) => entry.comment), ["Still typing, changed"]);
    assert.notEqual(edited[0]!.id, saved!.id, "saved as a new comment (a new id)");
    assert.equal(await message.inputValue(), "Third message.", "the message waits in the box");
    console.log("PASS acknowledged: editing a saved comment holds a send back too; the popover keeps the typed change, and saving it makes a new comment with its pin");
    assert.deepEqual(errors, []);
    await close();
  },

  async phone(open) {
    const { page, errors, close } = await open(PHONE);
    const intro = partOf(page, INTRO);
    await tapWord(page, intro, "Intro");
    await dialogOf(page).waitFor();
    assert.equal(await besidePinOf(page).count(), 0, "on a phone the popover is the sheet");
    const sheet = await dialogOf(page).evaluate((node) => ({ bottom: node.getBoundingClientRect().bottom, height: window.innerHeight }));
    assert.ok(Math.abs(sheet.bottom - sheet.height) <= 2, `the sheet sits at the bottom of the viewport (${sheet.bottom} of ${sheet.height})`);
    await fieldFocused(page);
    await fieldOf(page).fill("Phone note");
    await dialogOf(page).getByRole("button", { name: "Save comment", exact: true }).tap();
    await dialogOf(page).waitFor({ state: "detached" });
    await eventually("its pin", async () => (await pinsOf(page).count()) === 1);
    console.log("PASS phone: a tap on a block opens the sheet at the bottom of the viewport; saved, its pin");

    // a tap on the pin opens the sheet with the comment in its field, but raises no keyboard: the field is not focused
    // (the sheet is), until a tap into it starts editing. The sheet quotes, keeps ✕, and has Delete; the text stays up
    await pinsOf(page).first().tap();
    await dialogOf(page).waitFor();
    await eventually("the sheet to hold the focus", () => focusedMatches(page, ".modal.comment-popover"));
    await frames(page);
    assert.ok(await focusedMatches(page, ".modal.comment-popover"), "the sheet, not its field, keeps the focus");
    assert.equal(await fieldOf(page).inputValue(), "Phone note", "the field holds the comment");
    assert.equal(await dialogOf(page).locator(".comment-popover-quote").count(), 1, "the sheet quotes what it is on");
    assert.equal(await closeOf(page).count(), 1, "the sheet keeps ✕");
    assert.ok(await deleteOf(page).isVisible(), "Delete is in view");
    const bin = await deleteOf(page).boundingBox();
    assert.ok(bin !== null && bin.width >= 40 && bin.height >= 40, `Delete is a full touch target (${JSON.stringify(bin)})`);
    await assertUp(page, INTRO, "a pin tapped open on a phone");
    await fieldOf(page).tap();
    await fieldFocused(page);
    await closeOf(page).tap();
    await dialogOf(page).waitFor({ state: "detached" });
    console.log("PASS phone: a tap on a pin opens the sheet with the comment in its field, unfocused (no keyboard), quoting it, with ✕ and Delete; a tap into the field focuses it");

    // an untouched sheet closes on a tap on its scrim, and the tap's click does not open another on the block under it
    await tapWord(page, partOf(page, "A longer paragraph"), "several");
    await dialogOf(page).waitFor();
    await fieldFocused(page);
    const overBlock = await page.evaluate(() => {
      const sheetTop = document.querySelector(".modal.comment-popover")!.getBoundingClientRect().top;
      const view = document.querySelector(".chat-view")!.getBoundingClientRect();
      for (const part of document.querySelectorAll(".chat-view p.is-commentable")) {
        const box = part.getBoundingClientRect();
        const y = box.top + Math.min(box.height, 20) / 2;
        if (box.height > 0 && y > view.top + 8 && y < sheetTop - 8) return { x: box.left + Math.min(box.width, 60) / 2, y };
      }
      return null;
    });
    assert.ok(overBlock !== null, "a paragraph lies under the scrim, above the sheet");
    assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.matches(".modal-scrim") ?? false, overBlock), "the tap lands on the scrim");
    await page.touchscreen.tap(overBlock.x, overBlock.y);
    await eventually("the sheet to close", async () => (await dialogOf(page).count()) === 0);
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "the scrim's tap opens no sheet on the block under it");
    assert.equal(await pendingPinOf(page).count(), 0);
    console.log("PASS phone: a tap on the scrim closes an untouched sheet and opens none on the block under it");

    // a touch selection (a long press and its handles) opens nothing, and there is no Comment button for it: a tap on a
    // block is the way to comment on a phone
    await select(partOf(page, "Checksum"), "Checksum", { firstLine: true });
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a touch selection opens nothing");
    await assertNoButton(page, "a touch selection");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    console.log("PASS phone: a touch selection opens nothing, and no Comment button shows");

    // a tap at the end of a first line that reaches the column's right edge: its pin is kept inside the view, hit area and all
    const lineEnd = await partOf(page, "Checksum").evaluate((node) => {
      node.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(node);
      const first = [...range.getClientRects()].find((rect) => rect.width > 0)!;
      return { x: first.right - 3, y: first.top + first.height / 2 };
    });
    await page.touchscreen.tap(lineEnd.x, lineEnd.y);
    await dialogOf(page).waitFor();
    await fieldOf(page).fill("Edge note");
    await dialogOf(page).getByRole("button", { name: "Save comment", exact: true }).tap();
    await dialogOf(page).waitFor({ state: "detached" });
    await eventually("both pins", async () => (await pinsOf(page).count()) === 2);
    const edge = await page.evaluate(() => {
      const view = document.querySelector<HTMLElement>(".chat-view")!;
      const pins = [...document.querySelectorAll<HTMLElement>(".chat-view .comment-pin:not(.is-pending)")];
      const right = view.getBoundingClientRect().left + view.clientLeft + view.clientWidth;
      const hits = pins.map((pin) => {
        const after = getComputedStyle(pin, "::before");
        return { width: parseFloat(after.width), height: parseFloat(after.height) };
      });
      return { right, rights: pins.map((pin) => pin.getBoundingClientRect().right), hits, scrollWidth: view.scrollWidth, clientWidth: view.clientWidth };
    });
    const clamped = Math.max(...edge.rights);
    assert.ok(clamped <= edge.right && clamped >= edge.right - 40, `a pin is clamped at the right edge (${clamped} of ${edge.right})`);
    assert.ok(edge.hits.every((hit) => hit.width >= 44 && hit.height >= 44), `each pin's hit area is at least 44 × 44 (${JSON.stringify(edge.hits)})`);
    assert.equal(edge.scrollWidth, edge.clientWidth, "no pin or hit area pans the chat sideways");
    console.log("PASS phone: a pin at the right edge stays inside the view with its 44 × 44 hit area, and the chat does not pan sideways");

    // with the message box focused, a tap on a block only puts the keyboard away
    await messageOf(page).tap();
    await eventually("the message box to have the focus", () => focusedMatches(page, ".composer-text"));
    await tapWord(page, partOf(page, "A longer paragraph"), "several");
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a tap with the composer focused opens nothing");
    console.log("PASS phone: with the composer focused, a tap on a block opens nothing");
    assert.deepEqual(errors, []);
    await close();
  },

  async setting(open) {
    const { page, context, url, errors, sent, close } = await open(DESKTOP);
    await commentBlock(page, partOf(page, INTRO), "Intro", "Setting one.");
    // the store as it holds the intro's comment alone: what another tab writes back below
    const written = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith("herdr-web-ui:block-comments:"))!;
      return { key, value: localStorage.getItem(key)! };
    });
    await commentBlock(page, partOf(page, "A longer paragraph"), "several", "Setting two.");
    // a new comment being written when comments are turned off: it goes too, unsaved
    await clickWord(page, partOf(page, "Step 1 of the rollout"), "rollout");
    await fieldFocused(page);
    await fieldOf(page).fill("Unsaved thought");
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    const toggle = page.locator(".settings-dialog").getByRole("switch", { name: "Comments", exact: true });
    // a press in a dialog over the chat is that dialog's own: the popover with text typed beneath it neither takes the
    // focus back into its field nor holds the press's default back (a select would not open, a drag select nothing)
    await page.evaluate(() => {
      (window as unknown as { pressPrevented: boolean[] }).pressPrevented = [];
      document.addEventListener("mousedown", (event) => {
        setTimeout(() => (window as unknown as { pressPrevented: boolean[] }).pressPrevented.push(event.defaultPrevented));
      });
    });
    await toggle.focus();
    await page.locator(".settings-dialog h2, .settings-dialog h3").first().click();
    await frames(page, 2);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { pressPrevented: boolean[] }).pressPrevented), [false], "a press in Settings keeps its default with a comment typed beneath");
    assert.equal(await focusedMatches(page, ".comment-popover textarea"), false, "the focus does not go back to the comment beneath Settings");
    await toggle.click();
    const confirm = page.getByRole("alertdialog");
    await confirm.waitFor();
    assert.equal(await confirm.getByRole("heading").first().innerText(), "Delete 2 comments?", "the question names how many");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "Cancel keeps comments on");
    assert.equal((await storedOf(page)).length, 2, "and the comments");
    assert.equal(await fieldOf(page).inputValue(), "Unsaved thought", "and the popover being written in");
    await toggle.click();
    await confirm.waitFor();
    await confirm.getByRole("button", { name: "Turn off and delete", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await eventually("the focus back on the Comments switch", () => toggle.evaluate((node) => node === document.activeElement));
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });
    await eventually("no pin", async () => (await page.locator(".comment-pin").count()) === 0);
    assert.equal(await popoverOf(page).count(), 0, "the popover being written in is gone");
    assert.equal(await page.locator(".chat-view[data-comments]").count(), 0, "the chat is no comment surface any more");
    assert.equal(await barOf(page).count(), 0, "no comments bar");
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("herdr-web-ui:block-comments:"))), [], "no comment is stored, the unsaved one not either");
    await select(partOf(page, INTRO), "paragraph", { to: "state" });
    await frames(page);
    assert.equal(await page.locator(".comment-selection").count(), 0, "a selection has no Comment button");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await dragSelect(page, partOf(page, INTRO), "paragraph", "state");
    await frames(page, 10);
    assert.equal(await popoverOf(page).count(), 0, "a mouse's drag opens nothing");
    await clickWord(page, partOf(page, "A longer paragraph"), "several");
    await frames(page);
    assert.equal(await popoverOf(page).count(), 0, "a click on a block opens nothing");
    console.log("PASS setting: turning comments off asks about the 2 comments; Cancel keeps them and the popover being written; confirmed, no popover, pin, Comment button, bar or stored comment is left, the typed one unsaved");

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await toggle.click();
    await frames(page);
    assert.equal(await page.getByRole("alertdialog").count(), 0, "with no comments nothing is asked");
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    console.log("PASS setting: with no comment stored, turning comments off asks nothing");

    // no comment stored, but one being written with text typed: turning comments off would lose it, so it asks about it
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });
    await clickWord(page, partOf(page, INTRO), "Intro");
    await fieldFocused(page);
    await fieldOf(page).fill("Typed only");
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    await toggle.click();
    await confirm.waitFor();
    assert.equal(await confirm.getByRole("heading").first().innerText(), "Delete 1 comment?", "the comment being written is the one asked about");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    assert.equal(await toggle.getAttribute("aria-checked"), "true", "Cancel keeps comments on");
    assert.equal(await fieldOf(page).inputValue(), "Typed only", "and the text typed");
    await toggle.click();
    await confirm.waitFor();
    await confirm.getByRole("button", { name: "Turn off and delete", exact: true }).click();
    await confirm.waitFor({ state: "detached" });
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await eventually("the focus back on the Comments switch", () => toggle.evaluate((node) => node === document.activeElement));
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });
    assert.equal(await popoverOf(page).count(), 0, "the popover being written in is gone");
    assert.deepEqual(await storedOf(page), [], "nothing is stored");
    console.log("PASS setting: with only a comment being written, turning comments off asks about 1 comment; Cancel keeps it, confirmed it goes and the focus is back on the switch");

    // comments off here, and another tab that still has them on writes one: it stays stored, untouched, but this tab
    // shows no highlight, pin or bar for it, and a message sent here carries no quote
    const other = await context.newPage();
    await other.goto(url);
    await other.evaluate(({ key, value }) => localStorage.setItem(key, value), written);
    await other.close();
    await eventually("the other tab's comment to be stored", async () => (await storedOf(page)).length === 1);
    await frames(page, 10);
    assert.equal(await highlighted(page), 0, "its text is not highlighted");
    assert.equal(await page.locator(".chat-view .is-commented").count(), 0, "no part is marked commented");
    assert.equal(await page.locator(".comment-pin").count(), 0, "no pin");
    assert.equal(await barOf(page).count(), 0, "no comments bar");
    const before = sent.length;
    await messageOf(page).fill("Off message.");
    await page.keyboard.press("Enter");
    await eventually("the message to be sent", async () => sent.length === before + 1, 5000);
    assert.equal(sent.at(-1), "Off message.", "the message goes alone, without the stored comment or its quote");
    assert.deepEqual((await storedOf(page)).map((entry) => entry.comment), ["Setting one."], "the other tab's comment stays stored, untouched");
    console.log("PASS setting: with comments off, a comment another tab stores shows no highlight, pin or bar, and a sent message carries no quote; it stays stored");
    assert.deepEqual(errors, []);
    await close();
  },
};

const wanted = process.env.BLOCK_COMMENTS_CASE?.split(",").map((name) => name.trim()).filter((name) => name !== "") ?? Object.keys(cases);
const unknown = wanted.filter((name) => !(name in cases));
if (unknown.length > 0) throw new Error(`unknown BLOCK_COMMENTS_CASE: ${unknown.join(", ")} (known: ${Object.keys(cases).join(", ")})`);

let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
const failed: string[] = [];

try {
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-block-comments" });
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
  /** A fresh context on the pane's chat, its reply drawn, with `seed`'s comments stored and settings set beforehand. */
  const open: Open = async (options, seed = {}) => {
    const context = await launched.newContext(options);
    await context.route("https://example.com/**", (route) => route.abort());
    const page = await context.newPage();
    await page.addInitScript(({ id, comments, settings }) => {
      // seeded once: a reload keeps what the page has done since
      if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", ...settings }));
      localStorage.setItem(`herdr-web-ui:view:${id}`, "chat");
      const key = `herdr-web-ui:block-comments:${id}`;
      if (comments.length > 0 && localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ version: 1, comments }));
    }, { id: pane, comments: seed.comments ?? [], settings: seed.settings ?? {} });
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
    await partOf(page, INTRO).waitFor();
    return { page, context, url, errors, sent, close: () => context.close() };
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
