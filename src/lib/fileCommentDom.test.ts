import { describe, expect, it } from "bun:test";
import { clickedLineElements, columnUnit, lineLookup, trimSeparators, unfoldAt, unitsColumn, unitsText } from "./fileCommentDom.ts";
import type { LineRange } from "./fileComments.ts";

describe("file comment columns", () => {
  const units = ["a", { sep: " | " }, "bc", { sep: " | " }, "d"];
  it("reads a row with its cell separators", () => expect(unitsText(units)).toBe("a | bc | d"));
  it("counts separators in a column", () => expect(unitsColumn(units, 2, 1)).toBe(5));
  it("maps a column back, snapping out of a separator", () => {
    expect(columnUnit(units, 5, false)).toEqual({ unit: 2, offset: 1 });
    expect(columnUnit(units, 2, false)).toEqual({ unit: 2, offset: 0 });
    expect(columnUnit(units, 2, true)).toEqual({ unit: 0, offset: 1 });
    expect(columnUnit(units, 99, true)).toBeNull();
  });

  it("drops the separators at a line's ends, so its quote and its columns start at its text", () => {
    // a table row: a separator before its first cell; a paragraph line: the <br> that closes it
    const row = [{ sep: " | " }, "a", { sep: " | " }, "bc", { sep: "\n" }];
    const line = trimSeparators(row);
    expect(unitsText(line)).toBe("a | bc");
    expect(unitsColumn(line, 2, 0)).toBe(4);
    expect(columnUnit(line, 0, false)).toEqual({ unit: 0, offset: 0 });
    expect(columnUnit(line, 6, true)).toEqual({ unit: 2, offset: 2 });
    expect(trimSeparators([{ sep: "\n" }, { sep: " | " }])).toEqual([]);
    expect(trimSeparators(units)).toEqual(units);
  });
});

describe("lineLookup", () => {
  // a heading on line 1, a paragraph over lines 3–5 (data-source-end), a table row on 7, a block over 8–10
  const items: { name: string; span: LineRange }[] = [
    { name: "heading", span: [1, 1] },
    { name: "paragraph", span: [3, 5] },
    { name: "row", span: [7, 7] },
    { name: "block", span: [8, 10] },
  ];
  const on = lineLookup(items, (item) => item.span);
  const names = (lines: LineRange) => on(lines).map((item) => item.name);

  it("finds an item spanning several lines from any line it covers", () => {
    for (const line of [3, 4, 5]) expect(names([line, line])).toEqual(["paragraph"]);
    for (const line of [8, 9, 10]) expect(names([line, line])).toEqual(["block"]);
  });
  it("gives every item a range meets once, in document order", () => {
    expect(names([4, 9])).toEqual(["paragraph", "row", "block"]);
    expect(names([1, 10])).toEqual(["heading", "paragraph", "row", "block"]);
    expect(names([0, 99])).toEqual(["heading", "paragraph", "row", "block"]);
  });
  it("finds nothing between or past the items", () => {
    expect(names([2, 2])).toEqual([]);
    expect(names([6, 6])).toEqual([]);
    expect(names([11, 20])).toEqual([]);
  });
  it("never finds an item without a finite span", () => {
    const lookup = lineLookup([{ span: [Number.NaN, Number.NaN] as LineRange }, { span: [2, 2] as LineRange }], (item) => item.span);
    expect(lookup([1, 3])).toHaveLength(1);
  });
});

/**
 * A stand-in element for the DOM-light helpers: a tag, classes and attributes, its children, and the few element
 * methods they read. A selector is one compound selector (`p`, `.a.b`, `[x]`, `.a[x='1'][y]`).
 */
class Stand {
  parentElement: Stand | null = null;
  children: Stand[] = [];
  clicks = 0;
  constructor(readonly tag: string, readonly classes: string[] = [], readonly attributes: Record<string, string> = {}, children: Stand[] = []) {
    for (const child of children) { child.parentElement = this; this.children.push(child); }
  }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null; }
  matches(selector: string): boolean {
    const tag = /^[a-z]+/.exec(selector)?.[0];
    if (tag !== undefined && tag !== this.tag) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classes.includes(name!)) return false;
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:=['"]?([^'"\]]*)['"]?)?\]/g)) {
      const own = this.getAttribute(name!);
      if (own === null || (value !== undefined && own !== value)) return false;
    }
    return true;
  }
  closest(selector: string): Stand | null {
    for (let at: Stand | null = this; at !== null; at = at.parentElement) if (at.matches(selector)) return at;
    return null;
  }
  contains(other: Stand): boolean {
    for (let at: Stand | null = other; at !== null; at = at.parentElement) if (at === this) return true;
    return false;
  }
  querySelectorAll(selector: string): Stand[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): Stand | null { return this.querySelectorAll(selector)[0] ?? null; }
  click(): void { this.clicks += 1; }
}
const asElement = (stand: Stand): Element => stand as unknown as Element;
const spans = (stands: Element[]): string[] => stands.map((stand) => (stand as unknown as Stand).getAttribute("data-source-line")!);

describe("clickedLineElements", () => {
  const line3 = new Stand("span", [], { "data-source-line": "3" }, [new Stand("strong")]);
  const line4 = new Stand("span", [], { "data-source-line": "4" });
  const paragraph = new Stand("p", ["is-commentable"], {}, [line3, line4]);
  const row = new Stand("tr", [], { "data-source-line": "8" }, [new Stand("td")]);
  const item = new Stand("div", ["markdown-item"], { "data-source-line": "10", "data-source-end": "11" });
  const root = new Stand("div", ["markdown"], {}, [paragraph, new Stand("table", [], {}, [row]), item]);
  const outside = new Stand("p", [], {}, [new Stand("span", [], { "data-source-line": "1" })]);

  it("takes a paragraph whole, from a line in it or from beside its lines", () => {
    expect(spans(clickedLineElements(asElement(root), asElement(line3.children[0]!)))).toEqual(["3", "4"]);
    expect(spans(clickedLineElements(asElement(root), asElement(line4)))).toEqual(["3", "4"]);
    expect(spans(clickedLineElements(asElement(root), asElement(paragraph)))).toEqual(["3", "4"]);
  });
  it("takes any other line element alone", () => {
    expect(spans(clickedLineElements(asElement(root), asElement(row.children[0]!)))).toEqual(["8"]);
    expect(spans(clickedLineElements(asElement(root), asElement(item)))).toEqual(["10"]);
  });
  it("finds nothing outside the root's line elements", () => {
    expect(clickedLineElements(asElement(root), asElement(root))).toEqual([]);
    expect(clickedLineElements(asElement(root), asElement(outside.children[0]!))).toEqual([]);
    expect(clickedLineElements(asElement(root), asElement(outside))).toEqual([]);
  });
});

describe("unfoldAt", () => {
  /** A preview code block whose drawn lines are `first`… (`drawn` of them), folded or not, ending on `end`. */
  const block = (first: number, drawn: number, end: number, folded: boolean): { block: Stand; more: Stand } => {
    const lines = Array.from({ length: drawn }, (_, n) => new Stand("span", ["hl-line"], { "data-source-line": String(first + n) }));
    const more = new Stand("button", ["markdown-code-more"], { "aria-expanded": String(!folded), "data-fold-end": String(end) });
    return { block: new Stand("div", ["markdown-code"], {}, [new Stand("pre", [], {}, [new Stand("code", [], {}, lines)]), more]), more };
  };

  it("clicks Show all on the folded block that hides the line, and says it is not drawn yet", () => {
    const early = block(4, 20, 38, true);
    const late = block(50, 20, 90, true);
    const root = new Stand("div", ["markdown"], {}, [early.block, late.block]);
    expect(unfoldAt(asElement(root), 60)).toBe(true);
    expect(unfoldAt(asElement(root), 80)).toBe(false);
    expect([early.more.clicks, late.more.clicks]).toEqual([0, 1]);
  });
  it("leaves a line that is drawn, or outside every fold, as it is", () => {
    const folded = block(4, 20, 38, true);
    const open = block(50, 41, 90, false);
    const root = new Stand("div", ["markdown"], {}, [folded.block, open.block]);
    expect(unfoldAt(asElement(root), 10)).toBe(true);
    expect(unfoldAt(asElement(root), 3)).toBe(true);
    expect(unfoldAt(asElement(root), 39)).toBe(true);
    expect(unfoldAt(asElement(root), 85)).toBe(true);
    expect([folded.more.clicks, open.more.clicks]).toEqual([0, 0]);
  });
});
