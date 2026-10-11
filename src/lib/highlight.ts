import { pathParts } from "./filePaths.ts";

/** What a token means, independent of the theme; CSS maps each role to a token color. */
export type SyntaxRole = "keyword" | "string" | "number" | "comment" | "function" | "type" | "variable" | "meta" | "inserted" | "deleted";
export interface Token { text: string; role: SyntaxRole | null }
/** One entry per source line, including the empty entry after a final newline. */
export type Lines = Token[][];
/** Run i covers lengths[i] UTF-16 characters with ROLES[roles[i]]; transferable worker buffers. */
export interface Runs { lengths: Uint32Array; roles: Uint8Array }
export const ROLES: readonly (SyntaxRole | null)[] = [null, "keyword", "string", "number", "comment", "function", "type", "variable", "meta", "inserted", "deleted"];
/** Bound the source characters held and colored for a chat code block. */
export const CHAT_HIGHLIGHT_LIMIT = 100 * 1024;
/** Avoid creating a DOM element for every line of enormous newline-heavy input. */
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

export function countLines(source: string): number {
  let lines = 1;
  for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1)) lines += 1;
  return lines;
}
/** Match Markdown/fileLines while retaining trailing source whitespace. */
export function normalizeCode(code: string): string { return code.replace(/\r\n?/g, "\n"); }
export function plainLines(source: string): Lines {
  return source.split("\n").map((line) => line === "" ? [] : [{ text: line, role: null }]);
}
/** Runs that fall short leave the remainder plain, never dropping source text. */
export function linesFromRuns(source: string, runs: Runs): Lines {
  const lines: Lines = [[]];
  let at = 0;
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
/** Preserve previously colored streaming content while the new tail awaits its worker result. */
export function extendLines(lines: Lines, tail: string): Lines {
  if (tail === "") return lines;
  const next = lines.slice();
  const [first, ...rest] = tail.split("\n");
  if (first) next[next.length - 1] = [...next[next.length - 1]!, { text: first, role: null }];
  for (const line of rest) next.push(line === "" ? [] : [{ text: line, role: null }]);
  return next;
}
