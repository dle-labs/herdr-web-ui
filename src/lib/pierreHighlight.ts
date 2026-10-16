// Worker-only engine: never import this module from the application's lightweight language helpers.
import { getSharedHighlighter } from "@pierre/diffs";
import { canHighlight, ROLES, type Runs } from "./highlight.ts";
import { PIERRE_THEME, PIERRE_THEME_DEFINITION, syntaxColor } from "./pierreTheme.ts";

// EJS has no bundled Shiki grammar. Preserve filename recognition but render it plain.
const SHIKI_LANGUAGES: Record<string, string | null> = { ts: "typescript", js: "javascript", shell: "shellscript", env: "dotenv", ejs: null };
const COLOR_ROLES = new Map(ROLES.flatMap((role, index) => role === null ? [] : [[syntaxColor(role), index] as const]));

/** Normalized UTF-16 source to compact semantic runs; caller supplies a terminating worker budget. */
export async function highlightRuns(source: string, language: string): Promise<Runs> {
  const lang = Object.hasOwn(SHIKI_LANGUAGES, language) ? SHIKI_LANGUAGES[language] : language;
  if (!canHighlight(language) || lang == null) return { lengths: Uint32Array.from(source ? [source.length] : []), roles: Uint8Array.from(source ? [0] : []) };
  // Pierre's resolver deliberately refuses language/theme resolution in browser
  // workers. Get its shared Shiki instance, then use Shiki's worker-safe loaders.
  const highlighter = await getSharedHighlighter({ themes: [], langs: [], preferredHighlighter: "shiki-js" });
  if (!highlighter.getLoadedLanguages().includes(lang)) await highlighter.loadLanguage(lang);
  if (!highlighter.getLoadedThemes().includes(PIERRE_THEME)) await highlighter.loadTheme(PIERRE_THEME_DEFINITION);
  const { tokens } = highlighter.codeToTokens(source, { lang, theme: PIERRE_THEME });
  const lengths: number[] = [];
  const roles: number[] = [];
  let at = 0;
  const append = (length: number, role: number) => {
    if (length <= 0) return;
    const last = roles.length - 1;
    if (last >= 0 && roles[last] === role) lengths[last] = lengths[last]! + length;
    else { lengths.push(length); roles.push(role); }
    at += length;
  };
  // Offsets retain every newline and whitespace character, including empty lines and trailing LF.
  for (const line of tokens) for (const token of line) {
    append(token.offset - at, 0);
    append(token.content.length, COLOR_ROLES.get(token.color ?? "") ?? 0);
  }
  append(source.length - at, 0);
  return { lengths: Uint32Array.from(lengths), roles: Uint8Array.from(roles) };
}
