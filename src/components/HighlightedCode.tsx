import { forwardRef, Fragment, memo, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { canHighlight, extendLines, normalizeCode, plainLines, type Lines } from "../lib/highlight.ts";
import { highlightedFrom, highlightKnown, highlightOffThread, type Highlighted } from "../lib/highlightOffThread.ts";
import { useT } from "../lib/i18n.ts";
import { useSettings } from "../lib/settings.ts";
import "./HighlightedCode.css";

/**
 * The lines of `code` to show now, and whether they were left plain for being too long. Highlighting
 * never holds the page: short code is highlighted at once, longer code in a worker (shown plain
 * until it answers, or with the colors it had while a reply grows), and code the worker gives up on
 * stays plain. Above `limit` characters it is not tried at all; without one, the worker's budget
 * alone bounds it. Off in Settings, or in a language it has no grammar for, every code is plain and
 * never too long.
 */
export function useHighlightedLines(code: string, language: string | null, limit?: number): Highlighted {
  const { settings } = useSettings();
  const source = useMemo(() => normalizeCode(code), [code]);
  const highlighted = settings.highlightCode && canHighlight(language) ? language : null;
  const overLimit = highlighted !== null && limit !== undefined && code.length > limit;
  // what is known without waiting: no language, too long, short enough, or highlighted before
  const known = useMemo((): Highlighted | null => {
    if (highlighted === null || overLimit) return { lines: plainLines(source), tooLong: overLimit };
    return highlightKnown(source, highlighted);
  }, [source, highlighted, overLimit]);
  const [answer, setAnswer] = useState<{ source: string; language: string; lines: Lines | null } | null>(null);
  useEffect(() => {
    if (known !== null || highlighted === null) return;
    let live = true;
    const job = highlightOffThread(source, highlighted);
    void job.promise.then((lines) => { if (live) setAnswer({ source, language: highlighted, lines }); });
    // a newer text (a reply still growing) replaces a request that has not started
    return () => { live = false; job.cancel(); };
  }, [known, source, highlighted]);
  // the lines last shown, whose colors a growing text keeps while its new end is highlighted
  const shown = useRef<{ source: string; language: string; lines: Lines } | null>(null);
  const result = useMemo((): Highlighted => {
    if (known !== null) return known;
    if (answer !== null && answer.source === source && answer.language === highlighted) return highlightedFrom(source, answer.lines);
    const last = shown.current;
    if (last !== null && last.language === highlighted && source.startsWith(last.source)) {
      return { lines: extendLines(last.lines, source.slice(last.source.length)), tooLong: false };
    }
    return { lines: plainLines(source), tooLong: false };
  }, [known, answer, source, highlighted]);
  useEffect(() => {
    shown.current = highlighted === null || result.tooLong ? null : { source, language: highlighted, lines: result.lines };
  }, [result, source, highlighted]);
  return result;
}

interface CodeLinesProps {
  /** from `useHighlightedLines`; the same array while the code is unchanged */
  lines: Lines;
  lineNumbers?: boolean;
  wrap?: boolean;
  className?: string;
  /** the source line of the first line: with it each `.hl-line` carries its number as `data-source-line` */
  firstLine?: number;
}

/**
 * Code colored by role, one `.hl-line` per source line. `memo` skips a parent's re-render while
 * `lines` is the same array, and the line elements are built apart from the attributes: toggling
 * `wrap` or `lineNumbers` leaves them alone. The line-number gutter is a CSS counter, so it never
 * reaches a copy.
 *
 * The lines are inline spans, each but the last followed by a literal "\n" text node, so the
 * text of the `<pre>` is the code itself: `innerText` and a copied selection keep every blank line.
 * Block lines would add a line break of their own between lines and drop or double the blank ones.
 * The "\n" stays outside the `.hl-line`: a line's element holds its text only. The ref is that
 * `<pre>`: the file viewer selects it when the clipboard is out of reach.
 */
export const CodeLines = memo(forwardRef<HTMLPreElement, CodeLinesProps>(function CodeLines({ lines, lineNumbers = false, wrap = false, className, firstLine }, ref) {
  // index keys: the lines are a static list that is rebuilt as a whole
  const elements = useMemo(() => lines.map((tokens, index) => (
    <Fragment key={index}>
      <span className="hl-line" data-source-line={firstLine === undefined ? undefined : firstLine + index}>
        {tokens.map((token, n) => token.role === null ? token.text : <span className={`hl-${token.role}`} key={n}>{token.text}</span>)}
      </span>
      {index < lines.length - 1 && "\n"}
    </Fragment>
  )), [lines, firstLine]);
  // the gutter is as wide as the last line's number, at least two digits
  const gutter = lineNumbers ? { "--hl-digits": String(Math.max(2, String(lines.length).length)) } as CSSProperties : undefined;
  return <pre ref={ref} className={className ? `hl-code ${className}` : "hl-code"} style={gutter} data-line-numbers={lineNumbers ? "" : undefined} data-wrap={wrap ? "" : undefined}><code>{elements}</code></pre>;
}));

interface HighlightedCodeProps {
  code: string;
  language: string | null;
  /** Characters; above it the code shows as plain text with the note. */
  limit?: number;
  /** the source line of the first line (a code block of the file viewer's preview): its lines carry their numbers */
  firstLine?: number;
}

/**
 * A code block that highlights itself and, when it was left plain for its length, says so under
 * the code. Every prop is a primitive, so `memo` skips a parent's re-render (a chat reply's other
 * blocks while one grows). A host that says "too long" elsewhere (the file viewer, in its header)
 * calls `useHighlightedLines` and draws `CodeLines` itself.
 */
export const HighlightedCode = memo(function HighlightedCode({ code, language, limit, firstLine }: HighlightedCodeProps) {
  const t = useT();
  const { lines, tooLong } = useHighlightedLines(code, language, limit);
  return (
    <>
      <CodeLines lines={lines} firstLine={firstLine} />
      {tooLong && <p className="hl-note">{t("Too long to highlight")}</p>}
    </>
  );
});
