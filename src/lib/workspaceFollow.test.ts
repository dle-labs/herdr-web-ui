import { expect, test } from "bun:test";
import type { GitFileDiffResponse } from "../../shared/protocol.ts";
import { firstEditedLine } from "./workspaceFollow.ts";

function file(contents: string, revision = "one"): GitFileDiffResponse {
  return { root: "/repo", path: "file.ts", revision, binary: false, patch: "", old_file: { name: "file.ts", contents: "base" }, new_file: { name: "file.ts", contents } };
}
test("a repository-only revision does not count as an edit to this file", () => {
  expect(firstEditedLine(file("same"), file("same", "two"))).toBeNull();
});
test("follow targets the first content difference, including changes beyond the viewport", () => {
  const prefix = "same\n".repeat(1000);
  expect(firstEditedLine(file(`${prefix}before`), file(`${prefix}after`))).toBe(1001);
});
test("deleted trailing lines clamp to a surviving line", () => {
  expect(firstEditedLine(file("one\ntwo\nthree"), file("one"))).toBe(1);
});
test("deletion and staged-side changes are edits too", () => {
  const before = file("base");
  expect(firstEditedLine(before, { ...before, new_file: null })).toBe(1);
  expect(firstEditedLine(before, { ...before, old_file: { name: "file.ts", contents: "different" } })).toBe(1);
});
