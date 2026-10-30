import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, ParsedMarkdown } from "./Markdown.tsx";
import { BlockCommentContext, replyPart } from "../lib/blockComments.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { parseMarkdownWithLines } from "../../shared/markdown.ts";
import { SettingsProvider } from "../lib/settings.ts";

describe("Markdown reply commenting", () => {
  let languages: PropertyDescriptor | undefined;
  beforeEach(() => {
    languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  });
  it("leaves chat text, code copying and file links intact under a reply context", () => {
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children:
      createElement(BlockCommentContext.Provider, { value: replyPart("pane", null, 0, 0), children:
        createElement(OpenFileContext.Provider, { value: () => {}, children:
          createElement(Markdown, { children: "# Answer\n\nRead `src/main.ts`.\n\n- List item\n\n```ts\nconst a = 1;\n```" }),
        }),
      }),
    }));
    expect(html).toContain("Answer");
    expect(html).toContain("markdown-file");
    expect(html).toContain("markdown-code-copy");
    expect(html).toContain("data-comment-root");
    expect(html).toContain("is-commentable");
    expect(html).not.toContain("is-commented");
  });

  it("keeps source-line annotations used by file previews", () => {
    const html = renderToStaticMarkup(createElement(SettingsProvider, { children:
      createElement(ParsedMarkdown, { blocks: parseMarkdownWithLines("# Heading\n\nA line\nAnother line") }),
    }));
    expect(html).toContain('data-source-line="1"');
    expect(html).toContain('data-source-line="3"');
    expect(html).toContain('data-source-line="4"');
  });
});
