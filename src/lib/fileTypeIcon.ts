/** File categories only; the tree maps them to Lucide components, without React here. */
export type FileIconCategory = "code" | "config" | "json" | "markdown" | "text" | "image" | "audio" | "video" | "pdf" | "archive" | "shell" | "database" | "font" | "lock" | "git" | "file";

const extensions = new Map<string, FileIconCategory>();
for (const [category, suffixes] of Object.entries({
  code: "ts tsx js jsx mjs cjs mts cts py pyw rb rs go java kt kts swift c h cpp hpp cc cs fs fsx php vue svelte html htm css scss sass less xml xsl sql lua r dart ex exs erl hs clj cljs scala pl proto graphql gql wasm ipynb",
  config: "yaml yml toml ini conf cfg properties env rc editorconfig",
  json: "json jsonc json5",
  markdown: "md mdx markdown rst adoc",
  text: "txt text log csv tsv diff patch",
  image: "png jpg jpeg gif webp avif svg ico bmp tiff tif heic psd",
  audio: "mp3 wav ogg opus flac aac m4a aiff mid midi",
  video: "mp4 webm mov mkv avi m4v mpeg mpg",
  pdf: "pdf",
  archive: "zip gz tgz bz2 xz zst tar rar 7z br jar war",
  shell: "sh bash zsh fish bat cmd ps1",
  database: "db sqlite sqlite3",
  font: "woff woff2 ttf otf eot",
  lock: "lock lockb",
})) {
  for (const extension of suffixes.split(" ")) extensions.set(extension, category as FileIconCategory);
}

/** Match basenames first (including extensionless/dotfile conventions), then extensions. */
export function fileIconCategory(path: string): FileIconCategory {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (/^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|(?:bun|yarn|pnpm|cargo|composer|gemfile|poetry|pdm|uv)\.lock(?:b)?|.*\.lock)$/.test(name)) return "lock";
  if (/^\.git(?:ignore|attributes|modules|config|keep)$/.test(name)) return "git";
  if (/^\.env(?:\..*)?$/.test(name)) return "config";
  if (/^(?:dockerfile|containerfile)(?:\..*)?$/.test(name)
    || /^(?:\.editorconfig|\.(?:npm|yarn|babel|eslint|prettier|stylelint)rc(?:\..*)?)$/.test(name)) return "config";
  if (/^(?:makefile|gnumakefile|justfile|procfile|\.bashrc|\.bash_profile|\.zshrc|\.profile)$/.test(name)) return "shell";
  if (/^(?:readme|changelog|contributing|authors|license|licence|copying|notice)$/.test(name)) return "text";
  const extension = name.includes(".") ? name.split(".").at(-1)! : "";
  return extensions.get(extension) ?? "file";
}
