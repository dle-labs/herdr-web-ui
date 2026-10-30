import type { DirectoryListing, GitChangedFile } from "../../shared/protocol.ts";

export function workspaceChildPath(root: string, path: string): string {
  return `${root.replace(/[\\/]$/, "")}/${path}`;
}

/** Merge Git's inventory into a lazy directory page, keeping paths absent on disk. */
export function workspaceTreeEntries(listing: DirectoryListing | null, files: readonly GitChangedFile[], relative: string, inheritedIgnored = false) {
  const entries = new Map<string, { directory: boolean; ignored?: boolean; containsChanges?: boolean; status?: GitChangedFile["status"] }>();
  const ignoredDirectories = new Set(listing?.ignored_directories ?? []);
  for (const name of listing?.directories ?? []) entries.set(name, {
    directory: true, ...(inheritedIgnored || ignoredDirectories.has(name) ? { ignored: true } : {}),
  });
  for (const file of listing?.files ?? []) entries.set(file.name, {
    directory: false, ...(inheritedIgnored ? { ignored: true } : {}),
  });
  const prefix = relative ? `${relative}/` : "";
  for (const file of files) {
    if (!file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const name = slash < 0 ? rest : rest.slice(0, slash);
    const previous = entries.get(name);
    const directory = previous?.directory || slash >= 0;
    entries.set(name, {
      directory,
      ...(previous?.ignored || inheritedIgnored || (directory && ignoredDirectories.has(name)) ? { ignored: true } : {}),
      // A folder aggregates every descendant, never the status of the last file.
      ...(directory ? { containsChanges: true } : { status: file.status }),
    });
  }
  return [...entries].sort(([a, av], [b, bv]) => Number(bv.directory) - Number(av.directory) || a.localeCompare(b));
}
