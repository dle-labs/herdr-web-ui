/**
 * AsciiDoc for the file viewer's Preview: rewritten as the Markdown the Preview already draws, line for line, so a
 * block's source lines (and the comments placed on them) are the AsciiDoc file's own. It covers what documentation
 * commonly uses (headings, emphasis, links and xrefs, images, lists, description lists, admonitions, delimited
 * blocks, tables, attributes and comments), not every construct Asciidoctor knows; anything else shows as its text.
 * Nothing becomes HTML: passthrough blocks show as code, and links go through the Markdown parser's own checks.
 */

type Container = { delimiter: string; kind: "quote" | "comment" | "open" };
type Fence = { delimiter: string };

const ADMONITION = /^(NOTE|TIP|IMPORTANT|WARNING|CAUTION):\s+(.*)$/;
const ADMONITION_NAME: Record<string, string> = { NOTE: "Note", TIP: "Tip", IMPORTANT: "Important", WARNING: "Warning", CAUTION: "Caution" };
const PREPROCESSOR = /^(?:ifdef|ifndef|ifeval|endif)::.*\[.*\]\s*$/;
// asciidoctor-diagram's block styles: `[mermaid]` over a literal or listing block draws it; only Mermaid renders here
const DIAGRAMS = new Set(["a2s", "actdiag", "blockdiag", "bpmn", "bytefield", "d2", "dbml", "ditaa", "dpic", "erd", "gnuplot", "graphviz", "lilypond", "mermaid", "msc", "nomnoml", "nwdiag", "packetdiag", "pikchr", "plantuml", "rackdiag", "seqdiag", "shaape", "smcat", "structurizr", "svgbob", "symbolator", "syntrax", "tikz", "umlet", "vega", "vegalite", "wavedrom"]);
const BUILTIN_ATTRIBUTES: Record<string, string> = { nbsp: " ", zwsp: "", empty: "", sp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", brvbar: "¦", vbar: "|", plus: "+", startsb: "[", endsb: "]", caret: "^", asterisk: "*", tilde: "~", backslash: "\\", backtick: "`", "two-colons": "::", "two-semicolons": ";;", "cpp": "C++" };

/** `text` with its delimiter-free inline AsciiDoc as Markdown: emphasis, links, xrefs, images, attributes. */
export function asciidocInline(text: string, attributes: ReadonlyMap<string, string> = new Map()): string {
  // inline code first, and kept out of every later rewrite
  const code: string[] = [];
  const keep = (value: string): string => `\u0000${code.push(value) - 1}\u0000`;
  let out = text
    .replace(/`\+(.+?)\+`/g, (_, body: string) => keep(`\`${body}\``))
    .replace(/`([^`\n]+)`/g, (whole: string) => keep(whole))
    .replace(/kbd:\[([^\]]*)\]/g, (_, keys: string) => keep(`\`${keys}\``));
  out = out.replace(/\{([\w-]+)\}/g, (whole, name: string) => attributes.get(name.toLowerCase()) ?? BUILTIN_ATTRIBUTES[name.toLowerCase()] ?? whole);
  const imagesdir = attributes.get("imagesdir");
  const image = (target: string): string => imagesdir && !/^(?:[a-z][\w+.-]*:|\/)/i.test(target) ? `${imagesdir.replace(/\/+$/, "")}/${target}` : target;
  const firstAttribute = (list: string): string => list.split(",")[0]!.replace(/^"|"$/g, "").trim();
  out = out
    .replace(/image:(?!:)([^\s[]+)\[([^\]]*)\]/g, (_, target: string, list: string) => `![${firstAttribute(list)}](${image(target)})`)
    .replace(/footnote:(?:[\w-]*)\[([^\]]*)\]/g, (_, note: string) => note ? ` (${note})` : "")
    .replace(/btn:\[([^\]]*)\]/g, "**$1**")
    .replace(/menu:([^\s[]+)\[([^\]]*)\]/g, (_, menu: string, items: string) => `**${[menu, ...items.split(">").map((item) => item.trim()).filter(Boolean)].join(" › ")}**`)
    .replace(/xref:([^\s[]+)\[([^\]]*)\]/g, (_, target: string, label: string) => `[${firstAttribute(label) || target}](${target})`)
    .replace(/<<([^,>]+)(?:,\s*([^>]+))?>>/g, (_, id: string, label?: string) => label?.trim() || id.trim())
    .replace(/link:([^\s[]+)\[([^\]]*)\]/g, (_, target: string, label: string) => `[${firstAttribute(label) || target}](${target})`)
    .replace(/(^|[\s(<])((?:https?|ftp|irc|mailto):[^\s[\]<>]+)\[([^\]]*)\]/g, (_, before: string, target: string, label: string) => `${before}[${firstAttribute(label) || target.replace(/^mailto:/, "")}](${target})`)
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/(^|\s)\[[.#%][^\]]*\]#([^#\n]+)#/g, "$1$2")
    .replace(/##([^#\n]+)##/g, "$1")
    // unconstrained **bold** and __italic__ stay or become Markdown's; constrained *bold* and _italic_ too
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?[^\s*])\*(?![\w*])/g, "$1**$2**")
    .replace(/__(?=\S)([^_\n]*?\S)__/g, "*$1*")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1*$2*")
    .replace(/\s\+$/, "");
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)]!);
}

/**
 * The fence language a block attribute line gives the code block under it: `[source,ts]` and `[,ts]` name it in
 * their second position, a diagram style (`[mermaid]`, `[plantuml,target,svg]`) is its own; anything else names none.
 */
export function blockLanguage(attributes: string | null): string {
  const list = /^\[(.*)\]$/.exec(attributes ?? "")?.[1];
  if (list === undefined) return "";
  const positional = list.split(",").map((value) => value.trim()).filter((value) => !value.includes("="));
  // the style may carry an id, roles and options: `source#id.role%linenums`
  const style = (positional[0] ?? "").replace(/[#.%].*$/, "").toLowerCase();
  if (DIAGRAMS.has(style)) return style;
  if (style === "" || style === "source" || style === "listing") return /^[^\s"']+$/.exec(positional[1] ?? "")?.[0] ?? "";
  return "";
}

/** The cells of a table row line: AsciiDoc starts each with `|`, its spec (`2+`, `a`, `^.^`) before it. */
function tableCells(line: string): string[] {
  // an escaped `\|` is part of its cell: set aside before the split, put back after it
  const parts = line.replace(/\\\|/g, "\u0001").split("|");
  parts.shift();
  return parts.map((cell, index) => (index < parts.length - 1 ? cell.replace(/\s[\d.*+<^>a-z]+$/i, "") : cell).replace(/\u0001/g, "|").trim());
}

/** How many columns a table's `cols` attribute names (`3`, `1,2,1`, `3*`), or null when it names none. */
function columnCount(attributes: string): number | null {
  const cols = /cols\s*=\s*"?([^"\]]+)"?/.exec(attributes)?.[1];
  if (!cols) return null;
  const repeat = /^(\d+)\*/.exec(cols.trim());
  if (repeat) return Number(repeat[1]);
  if (/^\d+$/.test(cols.trim()) && !cols.includes(",")) return Number(cols.trim());
  return cols.split(/[,;]/).length;
}

/** A table's lines (between and including its `|===`) as as many Markdown lines: header, delimiter, rows, then blanks. */
function table(lines: string[], attributes: string, inline: (text: string) => string): string[] {
  const body = lines.slice(1, -1);
  const firstRow = body.findIndex((line) => line.trim() !== "");
  const cells = body.flatMap(tableCells);
  const columns = columnCount(attributes) ?? (firstRow === -1 ? 1 : Math.max(1, tableCells(body[firstRow]!).length));
  const rows: string[][] = [];
  for (let at = 0; at < cells.length; at += columns) rows.push(cells.slice(at, at + columns));
  while (rows.length && rows.at(-1)!.length < columns) rows.at(-1)!.push("");
  const row = (values: string[]): string => `| ${values.map((value) => inline(value).replace(/\|/g, "\\|")).join(" | ")} |`;
  // Markdown needs a header row: the first row is it (AsciiDoc's implicit header, or %header), else an empty one
  const explicit = /%header|options\s*=\s*"?[^"\]]*header/.test(attributes);
  const implicit = firstRow !== -1 && body[firstRow + 1]?.trim() === "" && tableCells(body[firstRow]!).length === columns;
  const noHeader = /%noheader|options\s*=\s*"?[^"\]]*noheader/.test(attributes);
  const header = rows.length && (explicit || implicit) && !noHeader ? rows.shift()! : Array<string>(columns).fill(" ");
  const out = [row(header), `|${" --- |".repeat(columns)}`, ...rows.map(row)];
  while (out.length < lines.length) out.push("");
  return out;
}

/** `source` as Markdown with exactly its line count, each block on the lines it came from. */
export function asciidocToMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const attributes = new Map<string, string>();
  const containers: Container[] = [];
  let fence: Fence | null = null;
  // the block attribute line (`[source,ts]`, `[NOTE]`, `[cols="1,2"]`) for the block that follows it
  let pending: string | null = null;
  // the widths of the open list levels' markers, for their items' indentation
  let listLevels: { marker: string; width: number }[] = [];
  const inline = (text: string): string => asciidocInline(text, attributes);
  const prefix = (): string => "> ".repeat(containers.filter((container) => container.kind === "quote").length);

  // a paragraph after a blank line ends the list above it; a list item there continues it
  let afterBlank = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const trimmed = line.trimEnd();
    const blankBefore = afterBlank;
    afterBlank = false;
    if (fence) {
      if (trimmed === fence.delimiter) { fence = null; out.push(`${prefix()}\`\`\``); }
      else out.push(`${prefix()}${line}`);
      continue;
    }
    if (containers.at(-1)?.kind === "comment") {
      if (trimmed === containers.at(-1)!.delimiter) containers.pop();
      out.push("");
      continue;
    }
    if (/^\/{4,}$/.test(trimmed)) { containers.push({ delimiter: trimmed, kind: "comment" }); out.push(""); continue; }
    // a line comment also ends the list above it, as Asciidoctor separates two lists
    if (/^\/\/(?!\/)/.test(trimmed) || /^\/\/\/(?!\/)/.test(trimmed)) { listLevels = []; out.push(""); continue; }
    const attribute = /^:(!?)([\w-]+)(!?):(?:\s+(.*))?$/.exec(trimmed);
    if (attribute) {
      const name = attribute[2]!.toLowerCase();
      if (attribute[1] || attribute[3]) attributes.delete(name); else attributes.set(name, attribute[4] ?? "");
      out.push("");
      continue;
    }
    if (PREPROCESSOR.test(trimmed) || /^toc::\[.*\]$/.test(trimmed) || trimmed === "<<<") { out.push(""); continue; }

    // delimited code: listing, literal, and passthrough (shown as its source, never as HTML)
    // a diagram style makes an open block (`--`) a diagram's source too
    const diagramOpen = trimmed === "--" && DIAGRAMS.has(blockLanguage(pending));
    if (/^-{4,}$/.test(trimmed) || /^\.{4,}$/.test(trimmed) || /^\+{4,}$/.test(trimmed) || trimmed === "```" || /^```[\w+-]*$/.test(trimmed) || diagramOpen) {
      const source = blockLanguage(pending);
      const language = trimmed.startsWith("```") ? trimmed.slice(3) : trimmed.startsWith("+") ? "html" : source;
      fence = { delimiter: trimmed.startsWith("```") ? "```" : trimmed };
      pending = null;
      listLevels = [];
      out.push(`${prefix()}\`\`\`${language}`);
      continue;
    }
    // delimited containers: quote, sidebar, example (an admonition when [NOTE] and the like name it) and open blocks
    if (/^(?:_{4,}|\*{4,}|={4,}|--)$/.test(trimmed)) {
      const open = containers.at(-1);
      if (open?.delimiter === trimmed) {
        containers.pop();
        out.push(prefix().trimEnd());
        continue;
      }
      const admonition = /^\[(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/.exec(pending ?? "")?.[1];
      const titled = /^\[quote(?:,\s*([^,\]]+))?(?:,\s*([^\]]+))?\]$/.exec(pending ?? "");
      if (trimmed === "--" && !admonition) {
        // an open block only groups; it draws nothing of its own
        containers.push({ delimiter: trimmed, kind: "open" });
        out.push(prefix().trimEnd());
        pending = null;
        continue;
      }
      containers.push({ delimiter: trimmed, kind: "quote" });
      pending = null;
      listLevels = [];
      out.push(admonition ? `${prefix()}**${ADMONITION_NAME[admonition]}**` : titled?.[1] ? `${prefix()}*— ${titled[1].trim()}${titled[2] ? `, ${titled[2].trim()}` : ""}*` : prefix());
      continue;
    }
    if (/^\|={3,}$/.test(trimmed)) {
      let end = index + 1;
      while (end < lines.length && !/^\|={3,}$/.test(lines[end]!.trimEnd())) end++;
      const block = lines.slice(index, Math.min(end + 1, lines.length));
      for (const row of table(block, pending ?? "", inline)) out.push(`${prefix()}${row}`.trimEnd());
      pending = null;
      listLevels = [];
      index += block.length - 1;
      continue;
    }

    if (trimmed === "") { out.push(prefix().trimEnd()); pending = null; afterBlank = true; continue; }
    if (/^\[\[[^\]]*\]\]$/.test(trimmed) || /^\[#[^\]]*\]$/.test(trimmed)) { out.push(prefix().trimEnd()); continue; }
    if (/^\[[^\]]*\]$/.test(trimmed) && !/^\[[ xX*]\]/.test(trimmed)) { pending = trimmed; out.push(prefix().trimEnd()); continue; }

    const heading = /^(={1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      listLevels = [];
      out.push(`${prefix()}${"#".repeat(heading[1]!.length)} ${inline(heading[2]!)}`);
      continue;
    }
    if (/^\.(?=[^.\s])/.test(trimmed)) { out.push(`${prefix()}**${inline(trimmed.slice(1))}**`); continue; }
    if (/^'{3,}$/.test(trimmed)) { out.push(`${prefix()}---`); continue; }
    const blockImage = /^image::([^\s[]+)\[([^\]]*)\]$/.exec(trimmed);
    if (blockImage) { out.push(`${prefix()}${inline(`image:${blockImage[1]}[${blockImage[2]}]`)}`); continue; }
    const include = /^include::([^\s[]+)\[[^\]]*\]$/.exec(trimmed);
    if (include) { out.push(`${prefix()}*include:* [${include[1]}](${include[1]})`); continue; }
    if (trimmed === "+") { out.push(prefix().trimEnd()); continue; }

    const admonition = ADMONITION.exec(trimmed);
    if (admonition) { out.push(`${prefix()}> **${ADMONITION_NAME[admonition[1]!]}:** ${inline(admonition[2]!)}`); continue; }

    const item = /^\s*(\*{1,5}|-|\.{1,5}|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      const marker = /^\d+\.$/.test(item[1]!) ? "." : item[1]!;
      const at = listLevels.findIndex((level) => level.marker === marker);
      if (at === -1) listLevels.push({ marker, width: marker.startsWith(".") ? 3 : 2 });
      else listLevels = listLevels.slice(0, at + 1);
      const depth = listLevels.length - 1;
      const indent = " ".repeat(listLevels.slice(0, depth).reduce((sum, level) => sum + level.width, 0));
      out.push(`${prefix()}${indent}${marker.startsWith(".") ? "1." : "-"} ${inline(item[2]!)}`);
      continue;
    }
    const term = /^(?!.*:\/\/)(.+?)(:{2,4}|;;)(?:\s+(.*))?$/.exec(trimmed);
    if (term && !/^[\w-]+::\S/.test(trimmed)) {
      out.push(`${prefix()}**${inline(term[1]!.trim())}**${term[3] ? ` — ${inline(term[3])}` : ""}`);
      continue;
    }
    if (blankBefore) listLevels = [];
    out.push(`${prefix()}${inline(line.replace(/^\s+/, ""))}`);
  }
  return out.join("\n");
}
