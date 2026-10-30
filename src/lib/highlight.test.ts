import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeLines } from "../components/HighlightedCode.tsx";
import { canHighlight, countLines, extendLines, languageForFence, languageForPath, LINE_ELEMENT_LIMIT, linesFromRuns, normalizeCode, plainLines, type Lines } from "./highlight.ts";
import { highlightRuns } from "./pierreHighlight.ts";
import { fileLines } from "./fileComments.ts";

const text = (lines: Lines) => lines.map((line) => line.map((token) => token.text).join(""));
async function highlight(code: string, language: string): Promise<Lines> {
  const source = normalizeCode(code);
  return linesFromRuns(source, await highlightRuns(source, language));
}
const roleText = (lines: Lines, role: string) => lines.flat().filter((token) => token.role === role).map((token) => token.text).join("");

describe("language resolution remains lightweight and stable", () => {
  it.each([
    ["ts", "ts"], ["typescript", "ts"], ["TSX title=x", "tsx"], ["javascript", "js"],
    ["sh", "shell"], ["bash", "shell"], ["yml", "yaml"], ["dockerfile", "dockerfile"],
    ["c", "cpp"], ["c++", "cpp"], ["hxx", "cpp"], ["jsonc", "json"], ["json5", "json"],
    ["angular-ts", "ts"], ["js-vue", "js"], ["angular-html", "html"], ["htm", "html"], ["racket", "scheme"], ["scm", "scheme"], ["console", "shell"], ["cmd", "shell"],
    ["scss", "css"], ["md", "markdown"], ["mkd", "markdown"], ["mdown", "markdown"], ["mkdn", "markdown"],
    ["", null], ["klingon", null], ["text", null], ["plaintext", null], ["TXT", null],
  ])("fence %s → %s", (word, language) => expect(languageForFence(word!)).toBe(language));
  it.each([
    ["/r/Dockerfile", "dockerfile"], ["/r/Dockerfile.dev", "dockerfile"], ["/r/app.dockerfile", "dockerfile"],
    ["/r/dockerfile.txt", "dockerfile"], ["/r/dockerfiles.json", "json"], ["/r/dockerfiles", null], ["/r/Dockerfile.md", "markdown"],
    ["/r/.gitignore", "toml"], ["/r/.env.local", "env"], ["/r/.env", "env"], ["/r/x.tsx", "tsx"], ["/r/x.ts", "ts"],
    ["/r/x.mjs", "js"], ["/r/README.md", "markdown"], ["/r/notes.MARKDOWN", "markdown"], ["/r/x.mdx", null],
    ["/r/x.mkd", "markdown"], ["/r/x.mdown", "markdown"], ["/r/a.toml", "toml"], ["/r/a.ini", "toml"], ["/r/a.svg", "html"],
    ["/r/a.py", "python"], ["C:\\r\\a.go", "go"], ["/r/a.", null], ["/r/.bashrc", "shell"], ["/r.d/LICENSE", null],
    ["/r/CMakeLists.txt", "cmake"], ["/r/a.json", "json"], ["/r/a.yml", "yaml"], ["/r/a.vue", "vue"], ["/r/a.c", "cpp"],
    ["/r/a.txt", null], ["/r/a.text", null], ["/r/notes.xyz", null], ["/r/Makefile", null],
  ])("path %s → %s", (path, language) => expect(languageForPath(path!)).toBe(language));
  it("recognizes canonical application names only", () => {
    expect(canHighlight("ts")).toBe(true);
    expect(canHighlight("typescript")).toBe(false);
    expect(canHighlight(null)).toBe(false);
  });
});

describe("Shiki semantic highlighting", () => {
  it("preserves multiline comments, strings, and useful code roles", async () => {
    const lines = await highlight("/* a\nb */\nconst x = 1;\nclass Box {}\nfunction run() {}\nconst s = `a\nb`;", "ts");
    expect(lines[0]!.every((t) => t.role === "comment")).toBe(true);
    expect(lines[1]!.every((t) => t.role === "comment")).toBe(true);
    expect(roleText(lines, "keyword")).toContain("const");
    expect(roleText(lines, "number")).toContain("1");
    expect(roleText(lines, "type")).toContain("Box");
    expect(roleText(lines, "function")).toContain("run");
    expect(roleText([lines[6]!], "string")).toContain("b");
  });
  it("colors Markdown headings, inline code and links without assuming token segmentation", async () => {
    const lines = await highlight("# Title\nsome `code` and [a](b)", "markdown");
    expect(roleText(lines, "function")).toContain("Title");
    expect(roleText(lines, "string")).toContain("code");
    expect(roleText(lines, "variable")).toContain("b");
  });
  it("colors inserted and deleted diff text", async () => {
    const lines = await highlight("+added\n-removed", "diff");
    expect(roleText(lines, "inserted")).toContain("added");
    expect(roleText(lines, "deleted")).toContain("removed");
  });
  it("keeps exact source across grammars, CRLF, empty lines, Unicode and final newlines", async () => {
    const code = "const a = `x${'y'}`; // z\r\n<div a=\"b\">{c}</div>\r\n\n\t\"\\\"\" 😀\n\n";
    for (const language of ["ts", "tsx", "markdown", "json", "yaml", "shell", "html", "env", "js"]) {
      expect(text(await highlight(code, language)).join("\n")).toBe(normalizeCode(code));
    }
    for (const source of ["", "\n", "a\nb\n", "a\n\n", "a\rb\rc", "a\rb\nc\r\nd\r\re", "x\r\n\ry\n\rz", "a\r\r"]) {
      expect(text(await highlight(source, "ts"))).toEqual(fileLines(source));
      expect(text(plainLines(normalizeCode(source)))).toEqual(fileLines(source));
    }
  });
  it("preserves source for all recognized languages, including boundary aliases",  async () => {
    for (const language of ["apache", "cmake", "cpp", "css", "diff", "dockerfile", "ejs", "env", "go", "html", "http", "js", "json", "jsx", "markdown", "mermaid", "nginx", "php", "python", "scheme", "shell", "sql", "svelte", "toml", "ts", "tsx", "vue", "yaml"]) {
      expect(text(await highlight("hello\n", language)).join("\n")).toBe("hello\n");
    }
  });
  it("leaves unsupported languages plain", async () => {
    expect(await highlight("x", "klingon")).toEqual([[{ text: "x", role: null }]]);
    // Shiki has no bundled EJS grammar: do not report successful coloring or throw a load error.
    expect(await highlight("<%= value %>", "ejs")).toEqual(plainLines("<%= value %>"));
  });
});

describe("compact runs and pure source helpers", () => {
  it("merges neighboring roles and covers the entire source", async () => {
    const source = "const a = 1;\nconst b = 2;\n\n";
    const runs = await highlightRuns(source, "ts");
    expect([...runs.lengths].reduce((sum, length) => sum + length, 0)).toBe(source.length);
    for (let i = 1; i < runs.roles.length; i++) expect(runs.roles[i]).not.toBe(runs.roles[i - 1]);
    expect(text(linesFromRuns(source, runs)).join("\n")).toBe(source);
    expect(linesFromRuns("", await highlightRuns("", "ts"))).toEqual([[]]);
  });
  it("leaves source beyond incomplete runs plain", async () => {
    expect(linesFromRuns("const x\ny", await highlightRuns("const", "ts"))).toEqual([[{ text: "const", role: "keyword" }, { text: " x", role: null }], [{ text: "y", role: null }]]);
  });
  it("extends streaming colors without mutating the previous lines", async () => {
    const lines = await highlight("const a", "ts");
    const extended = extendLines(lines, " = 1;\nlet b\n");
    expect(text(extended)).toEqual(["const a = 1;", "let b", ""]);
    expect(extended[0]![0]).toEqual({ text: "const", role: "keyword" });
    expect(extended[1]).toEqual([{ text: "let b", role: null }]);
    expect(text(lines)).toEqual(["const a"]);
    expect(extendLines(lines, "")).toBe(lines);
  });
  it("counts blank and trailing lines", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n\nb")).toBe(3);
    expect(countLines("\n".repeat(LINE_ELEMENT_LIMIT))).toBe(LINE_ELEMENT_LIMIT + 1);
  });
});

describe("CodeLines", () => {
  it("preserves whitespace and source offsets with a copy-free gutter", () => {
    const source = "  a\n\n\tb\n";
    const html = renderToStaticMarkup(createElement(CodeLines, { lines: plainLines(source), firstLine: 7, lineNumbers: true, wrap: true }));
    expect(html).toContain('data-line-numbers=""');
    expect(html).toContain('data-wrap=""');
    expect(html).toContain('<span class="hl-line" data-line="7" data-source-line="7">  a</span>\n<span class="hl-line" data-line="8" data-source-line="8"></span>');
    expect(html).toContain('<span class="hl-line" data-line="10" data-source-line="10"></span>');
    expect(html.replace(/<[^>]*>/g, "")).toBe(source);
  });
  it("renders too many lines as one exact text without a gutter", () => {
    const source = "\n".repeat(LINE_ELEMENT_LIMIT);
    const html = renderToStaticMarkup(createElement(CodeLines, { lines: plainLines(source), firstLine: 1, lineNumbers: true, wrap: true }));
    expect(html).not.toContain('class="hl-line"');
    expect(html).not.toContain("data-source-line");
    expect(html).not.toContain("data-line-numbers");
    expect(html).toContain(`<code>${source}</code>`);
    expect(html).toContain('data-wrap=""');
  });
});
