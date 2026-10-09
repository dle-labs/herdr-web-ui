import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";

import "./BlockComments.css";

import { foldCode, mathNestsTooDeep, parseMarkdown, type InlineNode, type ListBlock, type MarkdownBlock, type SourceLines } from "../lib/markdown.ts";
import { codeIsFilePath, OpenFileContext, splitFilePaths } from "../lib/filePaths.ts";
import { fileUriPath } from "../lib/terminalFileLinks.ts";
import { CHAT_HIGHLIGHT_LIMIT, languageForFence } from "../lib/highlight.ts";
import { HighlightedCode } from "./HighlightedCode.tsx";
import { useT } from "../lib/i18n.ts";
import { copyText } from "../lib/clipboard.ts";
import { BlockCommentContext, partAnchor, replyParts, usePartTouched, type PartLookup } from "../lib/blockComments.ts";
import { forgetCommentPart, rememberCommentPart } from "../lib/commentSelection.ts";

/**
 * True inside a quoted block (the comment editor's, `MarkdownBlocks quoted`): the block is shown
 * as context, not used. A code block has no header, copy or fold, and a link reads as its text.
 * They are not rendered, so they are neither in the tab order nor in the accessibility tree.
 */
const QuotedContext = createContext(false);

/**
 * The commentable parts of the reply this `Markdown` renders (`replyParts`): each part takes its
 * target from it, and a comment over several parts finds the parts it covers in it.
 */
const ReplyPartsContext = createContext<PartLookup | null>(null);

type Katex = typeof import("katex").default;
/** KaTeX is a fifth of the app's script: the first expression loads it (lib/katex.ts), and every later one has it at once. */
let katexModule: Katex | null = null;
let katexLoad: Promise<Katex> | null = null;

/** KaTeX, fetched once; a static render (the unit test) waits on it to draw math as the chat does. */
export function loadKatex(): Promise<Katex> {
  // offline before it was ever fetched: every expression stays in its source form until a reload
  // (no retry: Chrome keeps a failed import's answer for the page's life without fetching again)
  katexLoad ??= import("../lib/katex.ts").then((module) => (katexModule = module.default));
  return katexLoad;
}

function useKatex(): Katex | null {
  const [katex, setKatex] = useState(katexModule);
  useEffect(() => {
    if (katex) return;
    let live = true;
    loadKatex().then((loaded) => { if (live) setKatex(loaded); }, () => {});
    return () => { live = false; };
  }, [katex]);
  return katex;
}

function MathExpression({ value, displayMode = false }: { value: string; displayMode?: boolean }) {
  const katex = useKatex();
  const source = displayMode ? `\\[${value}\\]` : `\\(${value}\\)`;
  if (!katex || mathNestsTooDeep(value)) return <span>{source}</span>;
  try {
    // KaTeX escapes text and rejects untrusted commands by default, and an unknown command
    // throws - the catch below then draws the source form. `trust` stays at its default, which
    // is what keeps \href and \includegraphics refused. `strict` only governs input LaTeX would
    // not accept: "ignore" draws Korean, Japanese or Chinese text inside an expression, which
    // `strict: true` throws on.
    const html = katex.renderToString(value, { displayMode, strict: "ignore" });
    return <span className={displayMode ? "markdown-math-display" : "markdown-math"} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch {
    return <span>{source}</span>;
  }
}

/** A file path the viewer opens: a button that reads as the text or code it replaced. */
function FilePath({ path, code, open }: { path: string; code: boolean; open: (path: string) => void }) {
  const t = useT();
  const label = code ? <code>{path}</code> : path;
  return <button type="button" className={`markdown-file${code ? " is-code" : ""}`} title={t("Open {path}", { path })} onClick={() => open(path)}>{label}</button>;
}

/** `interactive` is false inside a link or file label: nothing clickable nests in another. */
function Inline({ nodes, interactive = true }: { nodes: InlineNode[]; interactive?: boolean }) {
  const context = useContext(OpenFileContext);
  const open = interactive ? context : null;
  const quoted = useContext(QuotedContext);
  const t = useT();
  return <>{nodes.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case "text":
        if (open === null) return <span key={key}>{node.value}</span>;
        return <span key={key}>{splitFilePaths(node.value).map((part, n) => typeof part === "string" ? part : <FilePath key={n} path={part.path} code={false} open={open} />)}</span>;
      case "code": {
        const file = fileUriPath(node.value);
        if (open !== null && file !== null) return <FilePath key={key} path={file} code open={open} />;
        // agents often put an address in backticks: it stays code to the eye, and opens
        if (interactive && !quoted && /^https?:\/\/\S+$/i.test(node.value)) return <a key={key} className="markdown-code-link" href={node.value} target="_blank" rel="noopener noreferrer"><code>{node.value}</code></a>;
        return open !== null && codeIsFilePath(node.value) ? <FilePath key={key} path={node.value} code open={open} /> : <code key={key}>{node.value}</code>;
      }
      case "math": return <MathExpression key={key} value={node.value} />;
      case "strong": return <strong key={key}><Inline nodes={node.children} interactive={interactive} /></strong>;
      case "em": return <em key={key}><Inline nodes={node.children} interactive={interactive} /></em>;
      case "del": return <del key={key}><Inline nodes={node.children} interactive={interactive} /></del>;
      case "link": return quoted
        ? <span key={key}><Inline nodes={node.children} interactive={false} /></span>
        : <a key={key} href={node.href} target="_blank" rel="noopener noreferrer"><Inline nodes={node.children} interactive={false} /></a>;
      // the label opens the file; where nothing can open one, the path shows after it, as Codex's terminal does
      case "file": {
        const label = <Inline nodes={node.children} interactive={false} />;
        return open !== null
          ? <button key={key} type="button" className="markdown-file" title={t("Open {path}", { path: node.path })} onClick={() => open(node.path)}>{label}</button>
          : <span key={key}>{label} (<code>{node.path}</code>)</span>;
      }
    }
  })}</>;
}

/** The source lines an element was drawn from, for the file viewer's comments (lib/fileCommentDom.ts); none for the chat's blocks, which carry no `source`. */
function sourceAttributes(source: SourceLines | undefined): { "data-source-line"?: number; "data-source-end"?: number } {
  if (source === undefined) return {};
  return source[1] > source[0] ? { "data-source-line": source[0], "data-source-end": source[1] } : { "data-source-line": source[0] };
}

/** A list; each item is commentable on its own (`ItemView`), the list as a whole is not. A task
 * item's box stands in for its bullet. */
function List({ block, path, commentable }: { block: ListBlock; path: number[]; commentable: boolean }) {
  const Tag = block.ordered ? "ol" : "ul";
  return (
    <Tag className="markdown-list" start={block.ordered ? block.start : undefined}>
      {block.items.map((_, index) => <ItemView key={index} list={block} index={index} path={[...path, index]} commentable={commentable} />)}
    </Tag>
  );
}

/**
 * One list item: each one is a block of its own for comments, nested items included. The item's
 * own text sits in `.markdown-item`, so a highlight and a selection's offsets cover the
 * item's words, not its nested blocks (they have their own). The wrapper is there whether or not
 * the item is commentable or commented: adding a comment remounts none of the nested blocks.
 */
function ItemView({ list, index, path, commentable }: { list: ListBlock; index: number; path: number[]; commentable: boolean }) {
  const item = list.items[index]!;
  const comment = useCommentable(path, commentable);
  const id = useId();
  // `list-style` only works on the <li>, so the task class stays there; the comment's classes go on the wrapper
  return (
    <li className={item.checked === undefined ? undefined : "markdown-task"}>
      <div ref={comment.ref} className={comment.className === undefined ? "markdown-item" : `markdown-item ${comment.className}`} {...sourceAttributes(item.source)}>
        {/* a task's box shows its state; the agent's text owns it, so it cannot be ticked here. Drawn,
            not an <input>: a disabled checkbox is greyed by the browser and ignores the accent */}
        {item.checked !== undefined && <span className="markdown-task-box" role="checkbox" aria-checked={item.checked} aria-disabled="true" aria-labelledby={id}>{item.checked && <Check aria-hidden="true" />}</span>}
        {item.checked === undefined ? <Inline nodes={item.content} /> : <span id={id}><Inline nodes={item.content} /></span>}
      </div>
      {item.blocks !== undefined && <Blocks blocks={item.blocks} path={path} commentable={commentable} />}
    </li>
  );
}

/**
 * `firstLine`: the file line of the block's first line, in the file viewer's preview (its `.hl-line`s carry their
 * lines). There a folded block's "Show all" names the block's last line (`data-fold-end`), so the viewer's walk can
 * unfold the block that hides a comment's lines (`unfoldAt`); not as `data-source-line`, which would make the button a
 * line element of its own.
 */
function CodeBlock({ language, value, firstLine }: { language: string; value: string; firstLine?: number }) {
  const t = useT();
  const quoted = useContext(QuotedContext);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const block = useRef<HTMLDivElement>(null);
  // no inner scroll: a long block folds, with a visible "Show all" row
  const fold = useMemo(() => foldCode(value), [value]);
  /** Copies the whole block, folded lines included, and flips the button to "copied" for a moment. */
  const copy = async (): Promise<void> => {
    const ok = await copyText(value);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) window.setTimeout(() => setCopied(false), 1500);
  };
  const folding = useRef(false);
  /** Shows all lines or folds them again; after folding, the block's top is brought back into view. */
  const toggle = (): void => {
    folding.current = expanded;
    setExpanded(!expanded);
  };
  // "Show less" sits at the bottom of a long block: after folding, bring the block's top back
  // into view rather than leave the reader far below it
  useLayoutEffect(() => {
    if (!folding.current) return;
    folding.current = false;
    const node = block.current;
    const view = node?.closest(".chat-view");
    if (node && view && node.getBoundingClientRect().top < view.getBoundingClientRect().top) node.scrollIntoView({ block: "start" });
  }, [expanded]);
  // quoted: the whole block, without header, copy or fold
  if (quoted) return <div className="markdown-code"><pre><code>{value}</code></pre></div>;
  return (
    <div className="markdown-code" ref={block}>
      <div className="markdown-code-header">
        <span>{language || "text"}</span>
        <button type="button" className="icon-button markdown-code-copy" onClick={() => void copy()} aria-label={t(copied ? "Code copied" : "Copy code")}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
      {copyFailed && <p className="markdown-code-error" role="alert">{t("Couldn't copy. Select the text and copy it manually.")}</p>}
      <HighlightedCode code={fold !== null && !expanded ? fold.head : value} language={languageForFence(language)} limit={CHAT_HIGHLIGHT_LIMIT} firstLine={firstLine} />
      {fold !== null && (
        <button type="button" className="markdown-code-more" aria-expanded={expanded} data-fold-end={firstLine === undefined ? undefined : firstLine + fold.lines - 1} onClick={toggle}>
          {expanded ? t("Show less") : t("Show all {n} lines", { n: fold.lines })}
        </button>
      )}
    </div>
  );
}

const NO_PATH: number[] = [];

/**
 * `path` locates the blocks inside the reply part (a list item's index is part of it), which is
 * how a comment finds its block again. Inside a blockquote nothing is commentable on its own:
 * the quote is one block.
 */
function Blocks({ blocks, path = NO_PATH, commentable = true }: { blocks: MarkdownBlock[]; path?: number[]; commentable?: boolean }) {
  return <>{blocks.map((block, index) => <BlockView key={`${block.type}-${index}`} block={block} path={[...path, index]} commentable={commentable} />)}</>;
}

/**
 * One block at `path`, commentable unless it is a rule; a list carries its comments on its items.
 * A block of the file viewer's preview (one with `source`)
 * writes its source lines on the elements a selection maps to lines: a heading, each line of a
 * paragraph, each table row, each code line, a formula. The viewer draws nothing in it of the comments: their text is
 * highlighted and their pins lie in its pin layer (FileComments.tsx).
 */
function BlockView({ block, path, commentable }: { block: MarkdownBlock; path: number[]; commentable: boolean }): ReactNode {
  const comment = useCommentable(path, commentable && block.type !== "hr" && block.type !== "list");
  const { className, ref } = comment;
  switch (block.type) {
    case "heading": {
      // agent headings are h3 whatever the agent wrote: the app's own h1/h2 (Brand, the dialog
      // titles) stay the outline above them. The level rides on a class, so the stylesheet
      // keeps drawing each level as it did (ChatView.css `.markdown-h1`...`.markdown-h6`).
      const level = `markdown-h${block.level}`;
      return <h3 ref={ref} className={className ? `${level} ${className}` : level} {...sourceAttributes(block.source)}><Inline nodes={block.content} /></h3>;
    }
    case "paragraph": {
      const lineNumbers = block.lineNumbers;
      return <p ref={ref} className={className}>{block.lines.map((line, lineIndex) => {
        const fileLine = lineNumbers?.[lineIndex];
        return <span key={lineIndex} {...sourceAttributes(fileLine === undefined ? undefined : [fileLine, fileLine])}><Inline nodes={line} />{lineIndex < block.lines.length - 1 && <br />}</span>;
      })}</p>;
    }
    case "list": return <List block={block} path={path} commentable={commentable} />;
    case "blockquote": return <blockquote ref={ref} className={className}><Blocks blocks={block.blocks} path={path} commentable={false} /></blockquote>;
    case "hr": return <hr />;
    default: {
      const rowLine = (row: number): { "data-source-line"?: number } => {
        const line = block.type === "table" ? block.rowLines?.[row] : undefined;
        return line === undefined ? {} : { "data-source-line": line };
      };
      const body = block.type === "code" ? <CodeBlock language={block.language} value={block.value} firstLine={block.source === undefined ? undefined : block.source[0] + 1} />
        : block.type === "math" ? <MathExpression value={block.value} displayMode />
        : <div className="markdown-table-wrap">
          <table><thead><tr {...rowLine(0)}>{block.header.map((cell, cellIndex) => <th key={cellIndex}><Inline nodes={cell} /></th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} {...rowLine(rowIndex + 1)}>{row.map((cell, cellIndex) => <td key={cellIndex}><Inline nodes={cell} /></td>)}</tr>)}</tbody>
          </table>
        </div>;
      // a code block, a table or a formula is commentable on a host around it. The
      // host is there whether or not the block is commentable, so a reply turning final (or live
      // again) keeps the same element, and a code block the reader unfolded stays unfolded. A
      // formula's host is its line element too; a code block's and a table's lines are their own
      return <div ref={ref} className={className === undefined ? "markdown-block" : `markdown-block ${className}`} {...(block.type === "math" ? sourceAttributes(block.source) : {})}>{body}</div>;
    }
  }
}

interface Commentable {
  /** undefined where the block is not commentable */
  className: string | undefined;
  /** on the block's element: where it is commentable, the selection and click handlers find its target from it */
  ref: (node: HTMLElement | null) => void;
}

/**
 * What makes the block at `path` commentable; nothing where it is not (outside a final answer,
 * inside a blockquote, a rule). Its target is the reply's part at `path` (`ReplyPartsContext`; a
 * list item's path ends in its index). A comment is made by selecting text in the block or by
 * clicking it (ChatView), which finds the block's target through the element `ref` registers. The
 * block draws nothing of its comments: their text is highlighted (lib/commentHighlight.ts), which
 * looks for the parts some comment covers (`is-commented`), and their pins lie in the chat's pin
 * layer (CommentPins.tsx). With comments turned off no part is commented, whatever is stored (`BlockCommentStore.setEnabled`).
 */
function useCommentable(path: number[], enabled: boolean): Commentable {
  const reply = useContext(BlockCommentContext);
  const parts = useContext(ReplyPartsContext);
  const target = enabled && reply !== null ? parts?.get(partAnchor(reply, path))?.target ?? null : null;
  const touched = usePartTouched(reply?.owner ?? "", target, parts);
  // registered while mounted and commentable, and taken out when either ends
  const registered = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    if (registered.current !== null) forgetCommentPart(registered.current);
    registered.current = node;
    if (node !== null && target !== null && reply !== null && parts !== null) rememberCommentPart(node, { owner: reply.owner, target, parts });
  }, [reply, target, parts]);
  if (target === null || reply === null) return { className: undefined, ref };
  // commented: some comment covers some of its text
  return { className: `is-commentable${touched ? " is-commented" : ""}`, ref };
}

/**
 * Blocks already parsed, as the chat shows them: a comment's block in the comment editor. With
 * `quoted` they show as a quote, without anything to press: no code header, copy or fold, links
 * as their text, file paths as plain text or code.
 */
export function MarkdownBlocks({ blocks, quoted = false }: { blocks: MarkdownBlock[]; quoted?: boolean }) {
  // the editor is portalled out of a reply but inherits its context: nothing commentable inside it
  const content = <div className="markdown"><Blocks blocks={blocks} /></div>;
  return (
    <BlockCommentContext.Provider value={null}><ReplyPartsContext.Provider value={null}>
      {quoted ? <QuotedContext.Provider value><OpenFileContext.Provider value={null}>{content}</OpenFileContext.Provider></QuotedContext.Provider> : content}
    </ReplyPartsContext.Provider></BlockCommentContext.Provider>
  );
}

/**
 * Markdown rendered. Every prop is a string, so `memo` skips a parent's re-render: a reply's other
 * parts are not rendered again while one grows.
 */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(children), [children]);
  return <ParsedMarkdown blocks={blocks} className={className} />;
});

/**
 * Markdown parsed elsewhere, rendered as `Markdown` renders its text: the file viewer parses a file
 * in a worker, so a file the parser is slow on cannot hold the page. Blocks with their `source`
 * (`parseMarkdownWithLines`, as the file viewer's are) write the lines they come from on their
 * elements, where a file comment finds the lines it is on; the chat's blocks carry none, so its DOM stays as it was. The ref is the `.markdown` root: the file viewer's
 * comments measure selections in it.
 */
export const ParsedMarkdown = memo(forwardRef<HTMLDivElement, { blocks: MarkdownBlock[]; className?: string }>(function ParsedMarkdown({ blocks, className }, ref) {
  // a final reply part: a selection that comments stays inside one (lib/commentSelection.ts)
  const reply = useContext(BlockCommentContext);
  // the same targets across renders while the reply and its text stay: a part re-renders only for its own comments
  const parts = useMemo(() => reply === null ? null : replyParts(reply, blocks), [reply, blocks]);
  return <ReplyPartsContext.Provider value={parts}>
    <div ref={ref} className={className === undefined ? "markdown" : `markdown ${className}`} data-comment-root={reply === null ? undefined : ""}><Blocks blocks={blocks} /></div>
  </ReplyPartsContext.Provider>;
}));
