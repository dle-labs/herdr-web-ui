import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** Execute the demo's actual boundary wrappers without its fixture timers or a browser. */
it("demo blocks direct speech fetches and sockets regardless of stale applied settings", async () => {
  const source = readFileSync(new URL("../site/demo/transport.ts", import.meta.url), "utf8");
  const fetchCode = source.slice(source.indexOf("const realFetch ="), source.indexOf("// ---- SSE"));
  const socketCode = source.slice(source.indexOf("const RealWebSocket ="), source.indexOf("// ---- the turn in progress"));
  let requests = 0;
  let sockets = 0;
  const window = {
    fetch: async () => { requests++; return new Response("asset"); },
    WebSocket: class { constructor() { sockets++; } },
  };
  const location = { href: "https://demo.example/demo/", origin: "https://demo.example" };
  const context = { window, location, URL, Request, Response, DOMException, DemoSocket: class {}, route: async () => Response.json({ enabled: false, allowed_origins: [] }) };
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  runInNewContext(transpiler.transformSync(fetchCode + socketCode), context);
  const wrappedFetch = window.fetch as unknown as typeof fetch;
  for (const target of ["https://private.example/v1/models", "https://private.example/v1/audio/transcriptions", "https://private.example/api/dictation/config", "/v1/models", "/v1/audio/transcriptions"]) {
    await expect(wrappedFetch(target)).rejects.toThrow();
  }
  await expect(wrappedFetch(new Request("https://private.example/v1/models"))).rejects.toThrow();
  await expect(wrappedFetch("/v1/audio/transcriptions", { method: "POST", body: "audio" })).rejects.toThrow();
  for (const target of ["wss://private.example/v1/realtime", "wss://private.example/ws", "wss://demo.example/v1/realtime"]) {
    expect(() => new (window.WebSocket as unknown as typeof WebSocket)(target)).toThrow();
  }
  expect(requests).toBe(0);
  expect(sockets).toBe(0);
  expect(await (await wrappedFetch("/api/dictation/config")).json()).toEqual({ enabled: false, allowed_origins: [] });
  await wrappedFetch("/assets/example.js");
  expect(requests).toBe(1);
  expect(() => new (window.WebSocket as unknown as typeof WebSocket)("wss://demo.example/ws")).not.toThrow();
  expect(sockets).toBe(0);
  expect(source).toContain('if (path === "/api/dictation/config") return json({ enabled: false, allowed_origins: [] } satisfies DictationConfigResponse');
});
