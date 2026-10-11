/**
 * Screen-only recognition of RPIV ask-user-question 2.12.0. This is deliberately
 * NOT a keyboard adapter: its English footer is static even when Pi remaps the
 * select/submit/newline bindings. In addition, active tabs are distinguished only
 * by ANSI background colors, which detection text does not preserve. Neither a
 * footer nor a persisted tool call attests to the live keyboard configuration.
 *
 * Keep recognizable unsupported overlays off the native/fallback responders and
 * out of queued chat delivery. Do not infer that a fully hidden overlay ended.
 */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const BORDER = /^[─━]{8,}$/;
const FOOTER = /^Enter to select · ↑\/↓ to navigate(?: ·|…|$)/;
const COLLAPSED = /^\S+ to expand · Esc to cancel$/;
const OPTION = /^(?:❯\s*)?\d+\.\s+(?:\[(?: |✔)\]\s*)?\S/;

export interface RpivQuestionnaire {
  /** Read-only screen excerpt, never interpreted as executable choices. */
  body: string;
  state: "question" | "review" | "collapsed" | "clipped";
}

export function parseRpivQuestionnaire(screen: string): RpivQuestionnaire | null {
  // Bounded detection window. A giant/history-only read is not actionable evidence.
  const lines = screen.slice(-64_000).replace(ANSI, "").split(/\r?\n/).map((line) => line.trim());
  while (lines.at(-1) === "") lines.pop();
  const footer = lines.at(-1) ?? "";
  if (COLLAPSED.test(footer)) return { state: "collapsed", body: footer };
  if (!FOOTER.test(footer) && !/^Enter to select ·.*…$/.test(footer)) return null;
  const end = lines.length - 1;
  let bottom = end - 1;
  while (bottom >= 0 && !BORDER.test(lines[bottom]!)) bottom--;
  if (bottom < 0) return null;
  let top = bottom - 1;
  while (top >= 0 && !BORDER.test(lines[top]!)) top--;
  if (top < 0) return null;
  const content = lines.slice(top + 1, bottom);
  const review = content.includes("Review your answers")
    && lines.slice(bottom + 1, end).some((line) => /^(?:Ready to submit your answers\?|⚠ Answer remaining questions before submitting:)/.test(line));
  const options = content.filter((line) => OPTION.test(line));
  const cursor = content.some((line) => /^❯\s*(?:\d+\.|Next$|Submit$)/.test(line));
  const overflow = content.some((line) => /^[↑↓↕]$/.test(line));
  // Both bounded borders and RPIV-specific chrome/list evidence are required;
  // a quoted hint alone must not hijack an ordinary Pi dialog. For quarantine
  // (not answering), missing/duplicate cursors and chrome-only views also hold
  // input: they must never fall through to a generic Enter/Cancel responder.
  const rpivChrome = / · (?:n to add notes|Space to toggle|Tab to switch questions|\S+ to collapse|Shift\+Enter for newline)/.test(footer);
  const sentinel = content.some((line) => /\bType something\.$/.test(line));
  if (!review && !rpivChrome && !(options.length >= 2 && cursor && sentinel) && !overflow) return null;
  return {
    state: overflow || footer.endsWith("…") || (!review && !cursor) ? "clipped" : review ? "review" : "question",
    body: lines.slice(top + 1, end).join("\n").slice(0, 12_000),
  };
}
