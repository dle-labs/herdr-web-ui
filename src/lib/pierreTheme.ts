import { registerCustomTheme } from "@pierre/diffs";
import type { SyntaxRole } from "./highlight.ts";

export const PIERRE_THEME = "herdr";
/** Literal CSS colors also encode roles in the chat worker; no computed-theme/color matching. */
export function syntaxColor(role: SyntaxRole): string { return `var(--syntax-${role})`; }
const scopes: Record<SyntaxRole, string[]> = {
  keyword: ["keyword", "storage", "constant.language"],
  string: ["string", "markup.inline.raw", "markup.raw", "markup.fenced_code"],
  number: ["constant.numeric"],
  comment: ["comment"],
  function: ["entity.name.function", "support.function", "meta.function-call", "markup.heading", "markup.heading entity.name.section"],
  type: ["entity.name.type", "entity.name.class", "entity.other.inherited-class", "support.type", "entity.name.tag"],
  variable: ["variable", "support.variable", "entity.other.attribute-name", "meta.object-literal.key", "support.type.property-name", "markup.underline.link", "meta.link"],
  meta: ["meta.preprocessor", "entity.name.section", "keyword.control.directive"],
  inserted: ["markup.inserted"],
  deleted: ["markup.deleted"],
};
/** Raw Shiki theme, also loaded directly inside the bounded file/chat worker. */
export const PIERRE_THEME_DEFINITION = {
  name: PIERRE_THEME,
  type: "dark" as const,
  colors: { "editor.foreground": "var(--text)", "editor.background": "var(--bg-panel)" },
  tokenColors: Object.entries(scopes).map(([role, scope]) => ({ scope, settings: { foreground: syntaxColor(role as SyntaxRole) } })),
};
/** Register before mounting a Pierre provider; its pool sends the resolved theme to its workers. */
registerCustomTheme(PIERRE_THEME, async () => PIERRE_THEME_DEFINITION);
