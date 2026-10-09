import { describe, expect, it } from "bun:test";
import { memoizeLast } from "./memoizeLast.ts";

describe("memoizeLast", () => {
  it("returns the last result for the same arguments without running again", () => {
    let runs = 0;
    const twice = memoizeLast((text: string, times: number) => { runs += 1; return { value: text.repeat(times) }; });
    const first = twice("ab", 2);
    expect(twice("ab", 2)).toBe(first);
    expect(runs).toBe(1);
  });

  it("runs again for other arguments and remembers only the last call", () => {
    let runs = 0;
    const length = memoizeLast((text: string) => { runs += 1; return [text.length]; });
    const a = length("a");
    length("bb");
    expect(length("a")).not.toBe(a);
    expect(runs).toBe(3);
  });
});
