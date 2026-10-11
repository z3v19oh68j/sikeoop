// A pretend network for the download tests: answers by address, remembers what was asked.
import type { HttpRequest } from "../../src/main/papers/net-download.ts";

export type Init = Parameters<HttpRequest>[1];
export type Route = (init: Init, url: string) => Response | Promise<Response>;

export interface FakeNet {
  request: HttpRequest;
  calls: { url: string; method: string; range?: string }[];
  routes: Record<string, Route>;
}

export function fakeNet(routes: Record<string, Route>): FakeNet {
  const calls: FakeNet["calls"] = [];
  const request: HttpRequest = async (url, init) => {
    calls.push({ url, method: init.method ?? "GET", ...(init.headers?.Range ? { range: init.headers.Range } : {}) });
    if (init.signal?.aborted) throw new Error("aborted");
    const route = routes[url];
    return route ? route(init, url) : new Response("not found", { status: 404 });
  };
  return { request, calls, routes };
}

export const redirect = (to: string, status = 302): Route => () => new Response(null, { status, headers: { location: to } });
export const json = (value: unknown): Route => () => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

export interface ServeOptions {
  /** Answers 200 with the whole file even when a part was asked for. */
  ignoreRange?: boolean;
  /** The connection breaks after this many bytes of the answer. */
  breakAfter?: number;
  /** The answer just ends after this many bytes, without an error. */
  endAfter?: number;
  /** After this many bytes nothing more comes and the answer never ends. */
  hangAfter?: number;
}

/** A file server that understands "Range: bytes=N-". Options apply to every answer until changed. */
export function serve(data: Buffer, options: ServeOptions = {}): Route {
  return (init) => {
    if (init.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(data.length) } });
    const asked = /^bytes=(\d+)-$/.exec(init.headers?.Range ?? "");
    const start = asked && !options.ignoreRange ? Number(asked[1]) : 0;
    if (asked && !options.ignoreRange && start >= data.length) return new Response(null, { status: 416, headers: { "content-range": `bytes */${data.length}` } });
    const rest = data.subarray(start);
    const stop = options.breakAfter ?? options.endAfter ?? options.hangAfter;
    const body =
      stop === undefined
        ? new Uint8Array(rest)
        : new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new Uint8Array(rest.subarray(0, stop)));
              if (options.endAfter !== undefined) c.close();
            },
            pull(c) {
              if (options.breakAfter !== undefined) c.error(new Error("socket hang up"));
              // hangAfter: nothing more, ever.
              return options.hangAfter !== undefined ? new Promise<void>(() => undefined) : undefined;
            },
          });
    const headers: Record<string, string> = start ? { "content-range": `bytes ${start}-${data.length - 1}/${data.length}` } : { "content-length": String(data.length) };
    return new Response(body, { status: start ? 206 : 200, headers });
  };
}
