import { pathParts } from "./filePaths.ts";

/** What a token means, independent of any theme; CSS maps each role to a token color. */
export type SyntaxRole =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "type"
  | "variable"
  | "meta"
  | "inserted"
  | "deleted";

export interface Token {
  text: string;
  /** `null` is plain text. */
  role: SyntaxRole | null;
}

/** One entry per source line, including the empty entry after a final newline. */
export type Lines = Token[][];

/**
 * A tokenized text as runs over its source: run `i` is `lengths[i]` characters in the role
 * `ROLES[roles[i]]` (0 is plain). Typed arrays, so a worker hands them over without copying.
 */
export interface Runs {
  lengths: Uint32Array;
  roles: Uint8Array;
}

export const ROLES: readonly (SyntaxRole | null)[] = [null, "keyword", "string", "number", "comment", "function", "type", "variable", "meta", "inserted", "deleted"];

/**
 * Code blocks in chat are highlighted up to this many characters (`limit` counts characters). The
 * worker's budget bounds the time; this bounds what a reply can make it hold: a pasted log or a
 * minified bundle is not worth a worker run, and its colors would fill the cache.
 */
export const CHAT_HIGHLIGHT_LIMIT = 100 * 1024;

/**
 * Past this many lines, code is drawn as one text, without colors: every line is an element of its
 * own, and in Chromium 20 000 of them take about 0.3 s to draw, while 256 KB of line breaks (262 144
 * lines) held the page for 4 s. Bytes do not bound that, so the lines are counted.
 */
export const LINE_ELEMENT_LIMIT = 20_000;

/** Lightweight application language names; grammar loading belongs exclusively to the worker. */
const LANGUAGES = new Set(["apache", "cmake", "cpp", "css", "diff", "dockerfile", "ejs", "env", "go", "html", "http", "js", "json", "jsx", "markdown", "mermaid", "nginx", "php", "python", "scheme", "shell", "sql", "svelte", "toml", "ts", "tsx", "vue", "yaml"]);
const LANGUAGE_ALIASES: Record<string, string> = {
  javascript: "js", mjs: "js", cjs: "js", "js-vue": "js", typescript: "ts", mts: "ts", cts: "ts", "angular-ts": "ts",
  bash: "shell", sh: "shell", zsh: "shell", ksh: "shell", fish: "shell", shellscript: "shell", cmd: "shell", console: "shell",
  yml: "yaml", py: "python", golang: "go", patch: "diff", docker: "dockerfile", dotenv: "env",
  c: "cpp", h: "cpp", "c++": "cpp", cxx: "cpp", cc: "cpp", hpp: "cpp", hxx: "cpp", scss: "css", less: "css",
  xml: "html", svg: "html", xhtml: "html", htm: "html", "angular-html": "html",
  jsonc: "json", json5: "json", scm: "scheme", racket: "scheme",
  md: "markdown", mkd: "markdown", mdown: "markdown", mkdn: "markdown",
  ini: "toml", cfg: "toml",
};

export function canHighlight(language: string | null): language is string {
  return language !== null && LANGUAGES.has(language);
}
function languageForWord(word: string): string | null {
  const language = LANGUAGE_ALIASES[word] ?? word;
  return canHighlight(language) ? language : null;
}
/** First fence word only, case-insensitive; unknown and plain text deliberately have no grammar. */
export function languageForFence(info: string): string | null {
  return languageForWord(info.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
}
/** Sole filename-to-language policy for the app, without importing a highlighting engine. */
export function languageForPath(path: string): string | null {
  const { stem, extension } = pathParts(path.toLowerCase());
  const name = stem + extension;
  if (name.endsWith(".md") || name.endsWith(".markdown")) return "markdown";
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile") || name === "containerfile") return "dockerfile";
  if (name === "cmakelists.txt") return "cmake";
  if (name === "nginx.conf") return "nginx";
  if ([".bashrc", ".zshrc", ".profile", ".bash_profile"].includes(name)) return "shell";
  if (name === ".env" || name.startsWith(".env.")) return "env";
  if (name === ".gitignore" || name === ".editorconfig") return "toml";
  return languageForWord(extension.slice(1));
}

/** How many lines a normalized source (`normalizeCode`) has: one more than its line breaks. */
export function countLines(source: string): number {
  let lines = 1;
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) lines += 1;
  return lines;
}

/** Normalize line endings without discarding source whitespace from rendered text and selection. */
export function normalizeCode(code: string): string {
  return code.replace(/\r\n?/g, "\n");
}

/** Uncolored lines, in the same shape as tokenized ones, so a view never tells the two apart. */
export function plainLines(source: string): Lines {
  return source.split("\n").map((line) => (line === "" ? [] : [{ text: line, role: null }]));
}

/**
 * The lines of `source` colored by `runs`. A run that spans lines keeps its role on each. Runs that
 * do not add up to the source (a stale answer) leave the rest plain.
 */
export function linesFromRuns(source: string, runs: Runs): Lines {
  const lines: Lines = [[]];
  let at = 0;
  /** Adds `text` in `role`, starting a new line at each "\n". */
  const append = (text: string, role: SyntaxRole | null) => {
    text.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1]!.push({ text: part, role });
    });
  };
  for (let i = 0; i < runs.lengths.length && at < source.length; i++) {
    const length = runs.lengths[i]!;
    append(source.slice(at, at + length), ROLES[runs.roles[i]!] ?? null);
    at += length;
  }
  if (at < source.length) append(source.slice(at), null);
  return lines;
}

/**
 * Lines already colored, followed by `tail` uncolored: a reply still being written keeps the colors
 * of what it had while its new end is highlighted. The lines given are not changed.
 */
export function extendLines(lines: Lines, tail: string): Lines {
  if (tail === "") return lines;
  const next = lines.slice();
  const [first, ...rest] = tail.split("\n");
  if (first) next[next.length - 1] = [...next[next.length - 1]!, { text: first, role: null }];
  for (const line of rest) next.push(line === "" ? [] : [{ text: line, role: null }]);
  return next;
}
