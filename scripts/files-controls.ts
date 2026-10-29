import type { Locator } from "playwright-core";

/** A secondary Files action lives in More on phones and in the header on desktop. */
export async function fileAction(files: Locator, name: string): Promise<Locator> {
  const action = files.getByRole("button", { name, exact: true });
  if (!await action.isVisible() && await files.locator(".files-mobile-header").count()) {
    await files.locator(".files-mobile-header").getByRole("button", { name: "More", exact: true }).click();
  }
  await action.waitFor();
  return action;
}

export async function fileView(files: Locator, mode: "preview" | "source" | "diff"): Promise<void> {
  const select = files.getByRole("combobox", { name: "File view", exact: true });
  if (await select.count()) { await select.selectOption(mode); return; }
  await files.getByRole("button", { name: mode === "source" ? "Show source" : mode === "preview" ? "Preview" : "Diff", exact: true }).click();
}

export async function fileViewSelected(files: Locator, mode: "preview" | "source" | "diff"): Promise<string> {
  const select = files.getByRole("combobox", { name: "File view", exact: true });
  if (await select.count()) return String(await select.inputValue() === mode);
  return (await files.getByRole("group", { name: "Markdown view", exact: true }).getByRole("button", { name: mode === "preview" ? "Preview" : "Diff", exact: true }).getAttribute("aria-pressed"))!;
}
