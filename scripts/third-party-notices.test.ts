import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

it("includes the bundled highlighter's complete installed license in the distributed notices", () => {
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const license = readFileSync(new URL("../node_modules/shiki/LICENSE", import.meta.url), "utf8");
  const bundled = readFileSync(new URL("../public/licenses/git-diff.txt", import.meta.url), "utf8");
  expect(notices).toContain("Shiki");
  expect(notices).toContain("licenses/git-diff.txt");
  expect(bundled).toContain(license.trim());
});
