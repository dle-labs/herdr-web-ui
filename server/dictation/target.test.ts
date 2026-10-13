import { describe, expect, it } from "bun:test";
import { dictationPolicy } from "../dictation.ts";
import { dictationFetch, resolveDictationTarget } from "./target.ts";
import { createDictationTransport } from "./speaches-http.ts";

it("pins production HTTPS lookups and safely rejects malformed upstream statuses", () => {
  // Isolate core-module mocks from the rest of the unit suite; no provider is contacted.
  const script = `
    import { spyOn } from "bun:test";
    import dns from "node:dns/promises";
    import https from "node:https";
    import { Readable } from "node:stream";
    let status = 200, lookups = 0, requests = 0, privateTarget = false;
    spyOn(dns, "lookup").mockImplementation(async () => {
      lookups++;
      if (privateTarget) return [{ address: "127.0.0.1", family: 4 }];
      return [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
    });
    spyOn(https, "request").mockImplementation((url, options, receive) => {
      requests++;
      if (url.hostname !== "speech.example.com" || options.agent !== false || !options.autoSelectFamily)
        throw new Error("Connection must retain hostname verification and use a fresh connection");
      options.lookup(url.hostname, { all: true }, (error, addresses) => {
        const expected = privateTarget ? "127.0.0.1" : "8.8.8.8";
        if (error || addresses[0].address !== expected) throw new Error("Unpinned lookup");
      });
      return { on() {}, end(body) {
        if (body.toString() !== "audio") throw new Error("Missing request body");
        queueMicrotask(() => {
          const res = Readable.from([Buffer.from("response")]);
          res.statusCode = status; res.headers = {};
          receive(res);
        });
      }};
    });
    const { dictationFetch } = await import(${JSON.stringify(new URL("./target.ts", import.meta.url).href)});
    const options = { method: "POST", body: "audio" };
    const response = await dictationFetch("https://speech.example.com/v1/models", options);
    if (await response.text() !== "response") throw new Error("Lost response stream");
    status = 600;
    let rejected = false;
    try { await dictationFetch("https://speech.example.com/v1/models", options); }
    catch { rejected = true; }
    if (!rejected || lookups !== 2) throw new Error("Unsafe status or repeated DNS lookup");
    privateTarget = true; status = 200;
    const localResponse = await dictationFetch("https://speech.example.com/v1/models", options);
    if (await localResponse.text() !== "response" || requests !== 3 || lookups !== 3)
      throw new Error("Private DNS answers must be usable");
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], { timeout: 5000 });
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
});

it("uses real loopback HTTP with bodies, headers, no redirects and cancellation", async () => {
  let calls = 0;
  let started!: () => void;
  const received = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    const path = new URL(request.url).pathname;
    if (path === "/hang") { started(); await waiting; return new Response("late"); }
    if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "/unexpected" } });
    return Response.json({ path, method: request.method, key: request.headers.get("authorization"), body: await request.text() });
  } });
  try {
    for (const host of ["localhost", "127.0.0.1"]) {
      const response = await dictationFetch(`http://${host}:${server.port}/v1/audio/transcriptions`, {
        method: "POST", headers: { authorization: "Bearer fixture-key" }, body: "fixture-audio", signal: AbortSignal.timeout(2000),
      });
      expect(await response.json()).toEqual({ path: "/v1/audio/transcriptions", method: "POST", key: "Bearer fixture-key", body: "fixture-audio" });
    }
    const response = await dictationFetch(`http://localhost:${server.port}/redirect`, { signal: AbortSignal.timeout(2000) });
    expect(response.status).toBe(302);
    expect(calls).toBe(3);
    const controller = new AbortController();
    const pending = dictationFetch(`http://localhost:${server.port}/hang`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]) });
    await received;
    controller.abort();
    await expect(pending).rejects.toThrow();
    for (const scheme of ["ftp", "file", "ws", "wss"])
      await expect(dictationFetch(`${scheme}://localhost:${server.port}/v1/models`)).rejects.toThrow();
    expect(calls).toBe(4);
  } finally { release(); await server.stop(true); }
});

it("preserves generated multipart headers and audio through the production adapter", async () => {
  const received: Array<{ path: string; type: string | null; key: string | null; model: unknown; language: unknown; format: unknown; name: string; bytes: number[] }> = [];
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const form = await request.formData();
    const file = form.get("file") as File;
    received.push({ path: new URL(request.url).pathname, type: request.headers.get("content-type"),
      key: request.headers.get("authorization"), model: form.get("model"), language: form.get("language"),
      format: form.get("response_format"), name: file.name, bytes: [...new Uint8Array(await file.arrayBuffer())] });
    return Response.json({ text: "fixture transcript" });
  } });
  try {
    for (const apiKey of [undefined, "fixture-key"]) {
      const service = createDictationTransport(dictationPolicy(`http://127.0.0.1:${server.port}/v1`, apiKey));
      expect(await service.transcribe(new File([bytes], "dictation.webm", { type: "audio/webm" }),
        "fixture/model", AbortSignal.timeout(2000), "en")).toBe("fixture transcript");
    }
    expect(received).toHaveLength(2);
    for (const [index, request] of received.entries()) {
      expect(request.type).toMatch(/^multipart\/form-data;.*boundary=/);
      expect(request).toMatchObject({ path: "/v1/audio/transcriptions", key: index ? "Bearer fixture-key" : null,
        model: "fixture/model", language: "en", format: "json", name: "dictation.webm", bytes: [...bytes] });
    }
  } finally { await server.stop(true); }
});

const resolver = (addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("administrator-selected dictation targets", () => {
  for (const host of ["localhost.", "speech.localhost", "speech", "speech.local", "speech.internal", "speech.lan", "speech.home", "10.0.0.1", "100.100.100.200", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "[::ffff:127.0.0.1]", "[fc00::1]", "[fe80::1]", "[2001:db8::1]", "[2002:7f00:1::]"]) {
    it(`accepts ${host} without destination policy restrictions`, () => {
      expect(dictationPolicy(`https://${host}/custom/api`).enabled).toBe(true);
    });
  }
  it("uses literal addresses without resolving them", async () => {
    const noDns = async () => { throw new Error("Must not resolve local targets"); };
    for (const address of ["127.0.0.1", "10.0.0.1", "::1", "fc00::1"]) {
      expect(await resolveDictationTarget(address, noDns)).toEqual([{ address, family: address.includes(":") ? 6 : 4 }]);
    }
    // URL parsing canonicalizes numeric IPv4 spellings before checking the address.
    for (const host of ["127.1", "2130706433", "0x7f000001"])
      expect(dictationPolicy(`http://${host}`).baseUrl).toBe("http://127.0.0.1");
  });
  it("permits public addresses and DNS names", async () => {
    expect(await resolveDictationTarget("speech.example.com", resolver(["2606:4700:4700::1111", "8.8.8.8"]))).toEqual([
      { address: "2606:4700:4700::1111", family: 6 }, { address: "8.8.8.8", family: 4 },
    ]);
  });
  it("bounds DNS validation by the caller's abort signal", async () => {
    const controller = new AbortController();
    const pending = resolveDictationTarget("speech.example.com", () => new Promise(() => {}), controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });
  it("accepts internal names and private, mapped or mixed DNS answers", async () => {
    for (const host of ["speech", "speech.internal", "speech.example.com", "localhost"]) {
      for (const addresses of [["10.0.0.1"], ["127.0.0.1"], ["::1"], ["::ffff:8.8.8.8"], ["8.8.8.8", "127.0.0.1"], ["2606:4700:4700::1111", "fe80::1"]])
        expect(await resolveDictationTarget(host, resolver(addresses))).toEqual(await resolver(addresses)());
    }
    await expect(resolveDictationTarget("speech", resolver([]))).rejects.toThrow("no addresses");
  });
});
