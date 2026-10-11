import type { DirectoryListing, GitChangedFile } from "../../shared/protocol.ts";

export function workspaceChildPath(root: string, path: string): string {
  return `${root.replace(/[\\/]$/, "")}/${path}`;
}

/** Merge Git's inventory into a lazy directory page, keeping paths absent on disk. */
export function workspaceTreeEntries(listing: DirectoryListing | null, files: readonly GitChangedFile[], relative: string) {
  const entries = new Map<string, { directory: boolean; status?: GitChangedFile["status"] }>();
  for (const name of listing?.directories ?? []) entries.set(name, { directory: true });
  for (const file of listing?.files ?? []) entries.set(file.name, { directory: false });
  const prefix = relative ? `${relative}/` : "";
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    entries.set(name, { directory: slash >= 0, status: file.status });
  }
  return [...entries].sort(([a, av], [b, bv]) => Number(bv.directory) - Number(av.directory) || a.localeCompare(b));
}
