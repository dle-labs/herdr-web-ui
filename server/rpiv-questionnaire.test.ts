import { describe, expect, test } from "bun:test";
import { parseRpivQuestionnaire } from "./rpiv-questionnaire.ts";
import { answerKeys, modelListWaits, parseInteractivePrompt } from "./prompt.ts";

// Synthetic fixtures following installed 2.12.0 DialogView, MultiSelectView and
// TabBar. They are not live captures and do not attest to default keybindings.
export const rpivScreen = (cursor = 0, multi = false): string => [
  "─".repeat(120), "", "Store", "", "Which store?", "",
  `${cursor === 0 ? "❯ " : "  "}1. ${multi ? "[✔] " : ""}Memory`,
  `${cursor === 1 ? "❯ " : "  "}2. ${multi ? "[ ] " : ""}Redis`,
  `${cursor === 2 ? "❯ " : "  "}3. ${multi ? "[ ] " : ""}Type something.`,
  ...(multi ? [`${cursor === 3 ? "❯ " : "  "}Submit`] : []),
  "", "─".repeat(120), "",
  ` Enter to select · ↑/↓ to navigate · ${multi ? "Space to toggle · " : ""}n to add notes · Esc to cancel · Ctrl+] to collapse`,
].join("\n");

describe("RPIV screen-only safety boundary", () => {
  test("recognizes independently of manually moved cursor and checkbox state", () => {
    for (const multi of [false, true]) for (const cursor of multi ? [0, 1, 2, 3] : [0, 1, 2]) {
      const screen = rpivScreen(cursor, multi);
      expect(parseRpivQuestionnaire(screen)?.state).toBe("question");
      expect(parseRpivQuestionnaire(screen.replace("[✔]", "[ ]"))?.state).toBe("question");
      const prompt = parseInteractivePrompt("pi", screen)!;
      expect(prompt).toMatchObject({ terminal_only: true, options: [], custom_option_index: null });
      expect(modelListWaits("pi", screen)).toBe(true);
      for (const answer of [{ option_index: 0 }, { option_indices: [0, 1] }, { option_indices: [] }, { custom_text: "typed answer" }]) {
        expect(() => answerKeys(prompt, answer)).toThrow("live keybindings are not verified");
      }
    }
  });

  test("notes, input, clipped and overflow states stay terminal-only", () => {
    const input = rpivScreen(2).replace("3. Type something.", "3. draft")
      .replace(" · n to add notes", "") + " · Shift+Enter for newline · Ctrl+U to clear";
    const notes = rpivScreen().replace("\n\n" + "─".repeat(120) + "\n", "\nNotes:\nprivate draft\n\n" + "─".repeat(120) + "\n")
      .replace(" · n to add notes", "") + " · Shift+Enter for newline";
    const overflow = rpivScreen().replace("❯ 1. Memory", "↑").replace("3. Type something.", "↓");
    const clipped = rpivScreen().replace(/ · n to add notes.*$/, "…");
    const narrow = rpivScreen().replace(/Enter to select.*$/, "Enter to select · ↑/…");
    const missingCursor = rpivScreen().replace("❯", " ");
    const chromeOnly = ["─".repeat(40), "", "─".repeat(40), "", "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel"].join("\n");
    for (const screen of [input, notes, overflow, clipped, narrow, missingCursor, chromeOnly]) {
      expect(parseInteractivePrompt("pi", screen)?.terminal_only).toBe(true);
      expect(modelListWaits("pi", screen)).toBe(true);
    }
  });

  test("partial review does not offer Submit or Cancel", () => {
    const screen = ["─".repeat(80), " ← □ Store  ■ Region   ✓ Submit  →", "", "Review your answers", "", " ● Region", "   → Europe", "", "─".repeat(80), "", "⚠ Answer remaining questions before submitting: Store", "❯ Submit", "  Cancel", " Enter to select · ↑/↓ to navigate · n to add a note · Esc to cancel"].join("\n");
    expect(parseRpivQuestionnaire(screen)?.state).toBe("review");
    expect(parseInteractivePrompt("pi", screen)?.options).toEqual([]);
  });

  test("collapsed hint holds input; completely invisible overlays cannot be inferred", () => {
    expect(parseRpivQuestionnaire("Ctrl+] to expand · Esc to cancel")?.state).toBe("collapsed");
    expect(parseRpivQuestionnaire("ordinary Pi transcript\n> ")).toBeNull();
  });

  test("requires active tail and corroboration, not a quoted footer", () => {
    expect(parseRpivQuestionnaire("Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel")).toBeNull();
    expect(parseRpivQuestionnaire(rpivScreen() + "\nLater output\n> ")).toBeNull();
    expect(parseRpivQuestionnaire(rpivScreen().replaceAll("─".repeat(120), ""))).toBeNull();
    expect(modelListWaits("codex", rpivScreen())).toBe(false);
    expect(parseRpivQuestionnaire("\u001b[32m" + rpivScreen() + "\u001b[0m")?.state).toBe("question");
  });
});
