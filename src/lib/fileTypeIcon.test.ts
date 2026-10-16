import { describe, expect, test } from "bun:test";
import { fileIconCategory, type FileIconCategory } from "./fileTypeIcon.ts";

describe("file icon categories", () => {
  const examples: [FileIconCategory, string[]][] = [
    ["code", ["main.ts", "Component.tsx", "script.py", "style.css", "page.html", "query.sql"]],
    ["config", ["settings.yaml", "Cargo.toml", ".env", ".env.local", ".editorconfig", ".npmrc", ".eslintrc.json", "Dockerfile", "Dockerfile.dev", "Containerfile"]],
    ["json", ["package.json", "tsconfig.jsonc", "data.json5"]],
    ["markdown", ["README.md", "notes.mdx", "guide.markdown"]],
    ["text", ["README", "LICENSE", "COPYING", "NOTICE", "notes.txt", "output.log", "data.csv"]],
    ["image", ["photo.jpeg", "icon.svg", "image.avif"]],
    ["audio", ["song.mp3", "voice.ogg", "music.flac"]],
    ["video", ["movie.mp4", "clip.webm", "recording.mov"]],
    ["pdf", ["manual.pdf"]],
    ["archive", ["backup.tar.gz", "files.zip", "archive.7z", "bundle.zst"]],
    ["shell", ["run.sh", "script.ps1", "Makefile", "Justfile", ".bashrc", ".zshrc"]],
    ["database", ["cache.db", "data.sqlite3"]],
    ["font", ["font.woff2", "face.ttf"]],
    ["lock", ["package-lock.json", "npm-shrinkwrap.json", "bun.lockb", "bun.lock", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "Gemfile.lock"]],
    ["git", [".gitignore", ".gitattributes", ".gitmodules", ".gitkeep"]],
    ["file", ["", "unknown", "data.bin", ".hidden", "file.constructor", "file.toString"]],
  ];
  for (const [category, names] of examples) {
    test(`${category} filenames`, () => {
      for (const name of names) expect(fileIconCategory(name)).toBe(category);
    });
  }
  test("matching is case insensitive and only considers the basename", () => {
    expect(fileIconCategory("src.json/MAIN.TSX")).toBe("code");
    expect(fileIconCategory("C:\\repo\\README.MD")).toBe("markdown");
    expect(fileIconCategory("folder.ts/unknown")).toBe("file");
    expect(fileIconCategory("/repo/.env.production")).toBe("config");
  });
});
