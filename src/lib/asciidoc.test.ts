import { describe, expect, it } from "bun:test";

import { parseMarkdownWithLines } from "../../shared/markdown.ts";
import { asciidocInline, asciidocToMarkdown } from "./asciidoc.ts";

const DOCUMENT = `= Project Guide
:toc:
:imagesdir: images
:product: Ovis

// a comment
== Getting started

Install *{product}* with _care_ and read \`README.adoc\`.
See https://example.com[the site] or xref:other.adoc[Other page].

NOTE: This is a note.

.Example title
[source,ts]
----
const a = *b*;
----

* one
** nested
* two
//
. first
. second

image::shot.png[Screenshot]

[cols="1,2"]
|===
|Name |Value

|alpha |1
|beta |2
|===

[WARNING]
====
Careful here.
====

Term:: Its definition
'''
////
hidden
////
The end.`;

describe("asciidocToMarkdown", () => {
  it("keeps the file's line count, so every block keeps the lines it came from", () => {
    const markdown = asciidocToMarkdown(DOCUMENT);
    expect(markdown.split("\n")).toHaveLength(DOCUMENT.split("\n").length);
    const blocks = parseMarkdownWithLines(markdown);
    const heading = blocks.find((block) => block.type === "heading" && block.level === 2);
    expect(heading?.source?.[0]).toBe(DOCUMENT.split("\n").indexOf("== Getting started") + 1);
    const code = blocks.find((block) => block.type === "code");
    expect(code).toMatchObject({ type: "code", language: "ts", value: "const a = *b*;" });
    expect(code?.source?.[0]).toBe(DOCUMENT.split("\n").indexOf("----") + 1);
    const table = blocks.find((block) => block.type === "table");
    expect(table?.type === "table" && table.rows.length).toBe(2);
    expect(blocks.some((block) => block.type === "blockquote")).toBe(true);
    expect(blocks.some((block) => block.type === "list")).toBe(true);
    expect(blocks.some((block) => block.type === "hr")).toBe(true);
  });

  it("rewrites the common block syntax line for line", () => {
    const lines = asciidocToMarkdown(DOCUMENT).split("\n");
    expect(lines[0]).toBe("# Project Guide");
    expect(lines[1]).toBe("");
    expect(lines[5]).toBe("");
    expect(lines[8]).toBe("Install **Ovis** with *care* and read `README.adoc`.");
    expect(lines[9]).toBe("See [the site](https://example.com) or [Other page](other.adoc).");
    expect(lines[11]).toBe("> **Note:** This is a note.");
    expect(lines[13]).toBe("**Example title**");
    expect(lines.slice(15, 18)).toEqual(["```ts", "const a = *b*;", "```"]);
    expect(lines.slice(19, 22)).toEqual(["- one", "  - nested", "- two"]);
    expect(lines.slice(23, 25)).toEqual(["1. first", "1. second"]);
    expect(lines[26]).toBe("![Screenshot](images/shot.png)");
    expect(lines.slice(29, 33)).toEqual(["| Name | Value |", "| --- | --- |", "| alpha | 1 |", "| beta | 2 |"]);
    expect(lines.slice(37, 40)).toEqual(["> **Warning**", "> Careful here.", ""]);
    expect(lines[41]).toBe("**Term** — Its definition");
    expect(lines[42]).toBe("---");
    expect(lines.slice(43, 46)).toEqual(["", "", ""]);
    expect(lines[46]).toBe("The end.");
  });

  it("shows a passthrough block as code, never as HTML", () => {
    const markdown = asciidocToMarkdown("++++\n<script>alert(1)</script>\n++++");
    expect(markdown).toBe("```html\n<script>alert(1)</script>\n```");
  });

  it("leaves code untouched and an unclosed block open to the end", () => {
    expect(asciidocToMarkdown("....\n*not bold* _x_\n")).toBe("```\n*not bold* _x_\n");
  });
});

describe("asciidocInline", () => {
  it("keeps code spans, words with underscores and plain asterisks as written", () => {
    expect(asciidocInline("`*x*` snake_case_name a * b")).toBe("`*x*` snake_case_name a * b");
    expect(asciidocInline("**bold** and __it__")).toBe("**bold** and *it*");
    expect(asciidocInline("kbd:[Ctrl+C] then btn:[OK]")).toBe("`Ctrl+C` then **OK**");
    expect(asciidocInline("see <<intro,the intro>> and <<setup>>")).toBe("see the intro and setup");
    expect(asciidocInline("line +")).toBe("line");
    expect(asciidocToMarkdown("|===\n|a \\| b |c\n|===").split("\n")[2]).toBe("| a \\| b | c |");
  });
});
