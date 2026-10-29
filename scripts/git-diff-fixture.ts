import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Fictional workspace fixtures shared by Files browser checks; no live API access. */
export function installGitDiffFixture(app: string): void {
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n<script src="./regression-patch.js"></script>\n<script type="module"'));
  // Extend only fictional demo fixtures with readable files, ignored folders and
  // a long added file for real scrolling. Never use herdr.
  writeFileSync(join(app, "regression-patch.js"), `(() => {
    const demoFetch = window.fetch;
    window.gitRequests = []; window.gitSent = [];
    const markdownFiles = [
      { path: "docs/untracked.md", status: "untracked", heading: "Untracked guide" },
      { path: "docs/added.md", status: "added", heading: "Added guide" },
      { path: "docs/modified.md", status: "modified", heading: "Modified guide" },
    ];
    const markdownBody = (file) => "# " + file.heading + "\\n\\nCurrent **Markdown** content.\\n";
    const DemoWorker = window.Worker;
    window.Worker = class extends DemoWorker {
      constructor(url, options) { super(url, options); this.markdownPreview = String(url).includes("markdownPreview"); }
      postMessage(message, ...rest) {
        if (window.gitMarkdownRefuse && this.markdownPreview) {
          window.gitMarkdownRefusals = (window.gitMarkdownRefusals || 0) + 1;
          queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, result: null } })));
        } else super.postMessage(message, ...rest);
      }
    };
    window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
    const DemoSocket = window.WebSocket;
    window.WebSocket = function(...args) {
      const socket = new DemoSocket(...args), send = socket.send.bind(socket);
      socket.send = (raw) => { const message = JSON.parse(raw); if (message.type === "submit") window.gitSent.push(message); return send(raw); };
      return socket;
    };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.fetch = async (input, init) => {
      const url = String(typeof input === "string" ? input : input.url ?? input);
      if (url.includes("/workspace/changes") || url.includes("/workspace/diff")) window.gitRequests.push(url);
      if (url.includes("/pane/send") && init?.body) window.gitSent.push(JSON.parse(init.body));
      const parsed = new URL(url, location.href);
      if (window.gitDiffFailure && parsed.pathname.endsWith("/workspace/diff") && parsed.searchParams.get("path") === "docs/modified.md") return Response.json({ error: { code: "git_too_large", message: "Fixture diff unavailable" } }, { status: 413 });
      if (window.gitMarkdownCase) {
        const path = parsed.searchParams.get("path") || "";
        const markdown = markdownFiles.find(file => path === file.path || path.endsWith("/" + file.path));
        if (parsed.pathname.endsWith("/workspace/diff") && markdown) {
          const changesUrl = new URL(parsed); changesUrl.pathname = changesUrl.pathname.replace(/diff$/, "changes");
          const changes = await (await demoFetch(changesUrl.href)).json();
          const body = markdownBody(markdown), modified = markdown.status === "modified";
          const old = "# " + markdown.heading + "\\n\\nPrevious Markdown content.\\n";
          return Response.json({ root: changes.root, revision: changes.revision + "-markdown", path: markdown.path, binary: false,
            old_file: modified ? { name: markdown.path, contents: old } : null,
            new_file: { name: markdown.path, contents: body },
            patch: "diff --git a/" + markdown.path + " b/" + markdown.path + "\\n" +
              (modified ? "--- a/" + markdown.path : "new file mode 100644\\n--- /dev/null") + "\\n+++ b/" + markdown.path + "\\n" +
              (modified ? "@@ -1,3 +1,3 @@\\n # " + markdown.heading + "\\n \\n-Previous Markdown content.\\n+Current **Markdown** content.\\n"
                : "@@ -0,0 +1,3 @@\\n" + body.trimEnd().split("\\n").map(line => "+" + line).join("\\n") + "\\n") });
        }
        if (markdown && parsed.pathname.endsWith("/fs/stat")) return Response.json({ path, name: markdown.path.split("/").pop(), size: markdownBody(markdown).length, modified: "2026-01-01T00:00:00.000Z", mime: "text/markdown", kind: "text" });
        if (markdown && parsed.pathname.endsWith("/fs/file")) return new Response(markdownBody(markdown), { headers: { "content-type": "text/markdown" } });
      }
      const response = await demoFetch(input, init);
      if (window.gitManyCommitResults && parsed.pathname.endsWith("/workspace/commits") && response.ok) {
        const data = await response.json();
        data.commits = Array.from({ length: 12 }, (_, i) => ({ id: (i + 1).toString(16).padStart(40, "0"), subject: "Overlay commit " + i + " with a long fictional subject", author: "Fictional author", date: "2026-01-01" }));
        data.truncated = false;
        return Response.json(data);
      }
      if (window.gitManySearchResults && parsed.pathname.endsWith("/workspace/files") && response.ok) {
        const data = await response.json();
        data.files = Array.from({ length: 12 }, (_, i) => "src/nested/long-search-result-path-" + String(i).padStart(2, "0") + ".ts");
        data.truncated = false;
        return Response.json(data);
      }
      if (parsed.pathname === "/api/voice" && response.ok) {
        const data = await response.json(); data.configured = !!window.gitVoiceConfigured; return Response.json(data);
      }
      if (url.includes("/workspace/directories") && response.ok) {
        const data = await response.json();
        if (window.gitMarkdownCase && data.path.endsWith("/docs")) {
          data.directories = []; data.ignored_directories = [];
          data.files = markdownFiles.map(file => ({ name: file.path.split("/").pop(), size: markdownBody(file).length }));
          return Response.json(data);
        }
        if (window.gitScrollCase) {
          data.directories = []; data.ignored_directories = [];
          data.files = Array.from({ length: 80 }, (_, i) => ({ name: "scroll-" + String(i).padStart(3, "0") + ".ts", size: 8000 }));
          return Response.json(data);
        }
        const source = data.path.endsWith("/src"), ignored = data.path.endsWith("/ignored"), nested = data.path.endsWith("/ignored/nested");
        data.directories = source || nested ? [] : ignored ? ["nested"] : ["src", "ignored"];
        if (window.gitMarkdownCase && !source && !ignored && !nested) data.directories.push("docs");
        data.ignored_directories = source || ignored || nested ? [] : ["ignored"];
        data.files = source ? [{ name: "greeting.ts", size: 90 }, { name: "new.ts", size: 3000 }]
          : ignored || nested ? [{ name: "hidden.txt", size: 35 }]
          : [{ name: "unchanged.ts", size: 35 }, { name: "notes.md", size: 35 }, { name: "picture.png", size: 35 }];
        return Response.json(data);
      }
      if (parsed.pathname.endsWith("/fs/stat")) return Response.json({ path: parsed.searchParams.get("path"), name: "unchanged.ts", size: window.gitScrollVirtual ? 600000 : 35, modified: "2026-01-01T00:00:00.000Z", mime: "text/plain", kind: "text" });
      if (parsed.pathname.endsWith("/fs/file")) return new Response(window.gitScrollCase
        ? Array.from({ length: window.gitScrollVirtual ? 2500 : 200 }, (_, i) => "export const scrollLine" + i + " = '" + "wide source ".repeat(12) + "';").join("\\n") + "\\n"
        : "export const unchanged = true;\\n", { headers: { "content-type": "text/plain" } });
      if ((url.includes("/workspace/changes") || url.includes("/workspace/diff")) && response.ok) {
        const data = await response.json();
        if (window.gitMarkdownCase && url.includes("/workspace/changes")) {
          data.files = markdownFiles.map(({ path, status }) => ({ path, status }));
          data.revision += "-markdown";
          window.gitMarkdownRoot = data.root;
        }
        if (window.gitNested && url.includes("/workspace/changes")) data.files.push({ path: "deep/inside/nested/changed.ts", status: "modified" });
        if (window.gitRevision) data.revision += "-follow-" + window.gitRevision;
        if (window.gitLongContext) {
          data.revision += "-long-context";
          if (data.path === "src/greeting.ts") {
            const oldLines = Array.from({ length: 240 }, (_, i) => "export const context" + (i + 1) + " = " + i + ";");
            const newLines = oldLines.slice();
            for (const line of [70, 180]) newLines[line - 1] = "export const context" + line + " = updated;";
            data.old_file.contents = oldLines.join("\\n") + "\\n";
            data.new_file.contents = newLines.join("\\n") + "\\n";
            data.patch = "diff --git a/src/greeting.ts b/src/greeting.ts\\n--- a/src/greeting.ts\\n+++ b/src/greeting.ts\\n" + [70, 180].map(line => {
              const start = line - 23, end = line + 23;
              return "@@ -" + start + ",47 +" + start + ",47 @@\\n" + oldLines.slice(start - 1, end).map((text, i) => start + i === line ? "-" + text + "\\n+" + newLines[line - 1] : " " + text).join("\\n") + "\\n";
            }).join("");
          }
        }
        if (url.includes("/workspace/changes") && window.gitEmpty) data.files = [];
        if (data.path === "src/new.ts") {
          data.new_file.contents = Array.from({ length: 90 }, (_, i) => "export const line" + i + " = " + (i + (window.gitRevision || 0)) + ";").join("\\n") + "\\n";
          data.patch = "diff --git a/src/new.ts b/src/new.ts\\nnew file mode 100644\\n--- /dev/null\\n+++ b/src/new.ts\\n@@ -0,0 +1,90 @@\\n" + data.new_file.contents.trimEnd().split("\\n").map(line => "+" + line).join("\\n") + "\\n";
        }
        return Response.json(data);
      }
      return response;
    };
  })();`);
}
