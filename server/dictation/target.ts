import dns from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import http from "node:http";
import https, { type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** Administrators choose the destination, including internal services. Resolve once per
 * request and use those addresses directly, without proxies or automatic redirects. */
export async function resolveDictationTarget(hostname: string, resolve: (host: string, options: LookupAllOptions) => Promise<LookupAddress[]> = dns.lookup, signal?: AbortSignal) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  signal?.throwIfAborted();
  const addresses = family ? [{ address: host, family }] : await new Promise<LookupAddress[]>((yes, no) => {
    const abort = () => no(signal!.reason);
    signal?.addEventListener("abort", abort, { once: true });
    void resolve(host, { all: true }).then(yes, no).finally(() => signal?.removeEventListener("abort", abort));
  });
  if (!addresses.length) throw new Error("Speech service hostname has no addresses");
  return addresses;
}

/** Production-only fetch adapter. Injected test transports never contact a provider. */
export const dictationFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const outgoing = new Request(input, init);
  const url = new URL(outgoing.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Expected an HTTP or HTTPS URL");
  const targets = await resolveDictationTarget(url.hostname, dns.lookup, outgoing.signal);
  const target = targets[0]!;
  outgoing.signal.throwIfAborted();
  // Bun generates multipart Content-Type lazily. Materialize it before consuming
  // the body, or the boundary header can disappear while the bytes remain valid.
  const headers = Object.fromEntries(outgoing.headers);
  const body = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined;
  return await new Promise<Response>((resolve, reject) => {
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      method: outgoing.method, headers, signal: outgoing.signal,
      // A fresh connection resolves DNS each time and keeps normal HTTPS hostname verification.
      agent: false, autoSelectFamily: true,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, targets);
        else callback(null, target.address, target.family);
      },
    };
    const request = url.protocol === "https:" ? https.request : http.request;
    const req = request(url, options, (res) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
          else if (value !== undefined) headers.set(name, value);
        }
        const status = res.statusCode ?? 502;
        const noBody = [204, 205, 304].includes(status);
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, { status, headers }));
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on("error", reject);
    req.end(body);
  });
}) as typeof fetch;
