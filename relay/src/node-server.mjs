import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { RoomHub, MAX_FRAME_BYTES, RelayError } from "./room-hub.mjs";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const encoder = new TextEncoder();

function serverFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

class WebSocketPeer {
  #socket;
  #hub;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #rate = { since: Date.now(), frames: 0, bytes: 0 };
  /** Last time anything arrived (frames, pongs): the heartbeat closes peers silent for too long. */
  lastSeen = Date.now();

  constructor(socket, hub, { joinTimeoutMs = 10_000 } = {}) {
    this.#socket = socket;
    this.#hub = hub;
    socket.setNoDelay(true);
    // A connection that never joins a room only holds a slot: drop it.
    const joinTimer = setTimeout(() => {
      if (!this.roomId) this.#protocolError("JOIN_TIMEOUT", "join a room first");
    }, joinTimeoutMs);
    joinTimer.unref?.();
    socket.on("close", () => clearTimeout(joinTimer));
    socket.on("data", (chunk) => {
      this.lastSeen = Date.now();
      this.#onData(chunk);
    });
    socket.on("close", () => this.#finish());
    socket.on("error", () => this.#finish());
  }

  sendJson(value) {
    if (this.#closed || this.#socket.destroyed) return;
    this.#socket.write(serverFrame(0x1, Buffer.from(JSON.stringify(value), "utf8")));
  }

  ping() {
    if (!this.#closed && !this.#socket.destroyed) this.#socket.write(serverFrame(0x9, randomBytes(4)));
  }

  close(code = 1000, reason = "") {
    if (this.#closed) return;
    this.#closed = true;
    const reasonBytes = encoder.encode(reason).subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    Buffer.from(reasonBytes).copy(payload, 2);
    this.#socket.end(serverFrame(0x8, payload));
    this.#hub.leave(this);
  }

  #finish() {
    if (this.#closed) return;
    this.#closed = true;
    this.#hub.leave(this);
  }

  #protocolError(code, message) {
    this.sendJson({ type: "error", code, message });
    this.close(code === "FRAME_TOO_LARGE" ? 1009 : 1008, message);
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_FRAME_BYTES + 14) return this.#protocolError("FRAME_TOO_LARGE", "frame exceeds 1 MiB");
    while (this.#buffer.length >= 2 && !this.#closed) {
      const first = this.#buffer[0];
      const second = this.#buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      const rsv = first & 0x70;
      let length = second & 0x7f;
      let offset = 2;
      if (rsv || !fin || !masked) return this.#protocolError("BAD_WEBSOCKET_FRAME", "invalid WebSocket frame");
      if (length === 126) {
        if (this.#buffer.length < offset + 2) return;
        length = this.#buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.#buffer.length < offset + 8) return;
        const size = this.#buffer.readBigUInt64BE(offset);
        if (size > BigInt(MAX_FRAME_BYTES)) return this.#protocolError("FRAME_TOO_LARGE", "frame exceeds 1 MiB");
        length = Number(size);
        offset += 8;
      }
      if (length > MAX_FRAME_BYTES) return this.#protocolError("FRAME_TOO_LARGE", "frame exceeds 1 MiB");
      if (opcode >= 0x8 && length > 125) return this.#protocolError("BAD_WEBSOCKET_FRAME", "invalid control frame");
      if (this.#buffer.length < offset + 4 + length) return;
      const mask = this.#buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.#buffer.subarray(offset, offset + length));
      this.#buffer = this.#buffer.subarray(offset + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

      if (opcode === 0x8) return this.close(1000, "peer closed");
      if (opcode === 0x9) {
        this.#socket.write(serverFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode !== 0x1) return this.#protocolError("BAD_WEBSOCKET_FRAME", "text JSON frames required");
      if (!this.#allowRate(payload.length)) return this.#protocolError("RATE_LIMIT", "relay rate limit exceeded");
      let message;
      try {
        message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
      } catch {
        return this.#protocolError("BAD_JSON", "invalid JSON frame");
      }
      try {
        if (!this.roomId) {
          this.#hub.join(this, message);
        } else {
          if (message?.type === "join") throw new RelayError("ALREADY_JOINED", "connection already joined a room");
          this.#hub.forward(this, message);
        }
      } catch (error) {
        const relayError = error instanceof RelayError ? error : new RelayError("INTERNAL", "relay rejected frame");
        this.#protocolError(relayError.code, relayError.message);
      }
    }
  }

  #allowRate(bytes) {
    const now = Date.now();
    if (now - this.#rate.since >= 1000) this.#rate = { since: now, frames: 0, bytes: 0 };
    this.#rate.frames++;
    this.#rate.bytes += bytes;
    return this.#rate.frames <= 100 && this.#rate.bytes <= 4 * MAX_FRAME_BYTES;
  }
}

/**
 * trustProxy: behind a reverse proxy on this machine (nginx), take the client address from
 * X-Real-IP — only when the TCP peer itself is loopback, so the header can't be forged from outside.
 */
export function createRelayServer({
  host = "127.0.0.1",
  port = 8787,
  hub = new RoomHub(),
  trustProxy = false,
  maxPerIp = 20,
  maxPeers = 2000,
  idleMs = 90_000,
  joinTimeoutMs = 10_000,
} = {}) {
  const peers = new Set();
  const perIp = new Map();
  const clientIp = (request) => {
    const direct = request.socket.remoteAddress ?? "";
    const loopback = direct === "127.0.0.1" || direct === "::1" || direct === "::ffff:127.0.0.1";
    const forwarded = request.headers["x-real-ip"];
    return trustProxy && loopback && typeof forwarded === "string" && forwarded.length < 64 ? forwarded : direct;
  };
  const server = createServer((request, response) => {
    if (request.method === "GET" && new URL(request.url ?? "/", "http://localhost").pathname === "/healthz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, protocolVersion: 1 }));
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end("not found\n");
  });

  server.on("upgrade", (request, socket) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const key = request.headers["sec-websocket-key"];
    if (pathname !== "/v1/relay" || request.headers.upgrade?.toLowerCase() !== "websocket" || request.headers["sec-websocket-version"] !== "13" || typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ip = clientIp(request);
    if (peers.size >= maxPeers || (perIp.get(ip) ?? 0) >= maxPerIp) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"));
    const peer = new WebSocketPeer(socket, hub, { joinTimeoutMs });
    peer.ip = ip;
    peers.add(peer);
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let gone = false;
    const release = () => {
      if (gone) return;
      gone = true;
      peers.delete(peer);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n > 0) perIp.set(ip, n);
      else perIp.delete(ip);
    };
    socket.on("close", release);
    socket.on("error", release);
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const peer of peers) {
      // Clients answer pings (a pong counts as traffic); silent ones are dead connections.
      if (now - peer.lastSeen > idleMs) peer.close(1001, "idle");
      else peer.ping();
    }
    hub.sweep();
  }, 30_000);
  heartbeat.unref();

  return {
    server,
    hub,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const peer of peers) peer.close(1001, "relay shutdown");
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be in 0..65535");
  // TRUST_PROXY=1 behind nginx on the same host (see relay/deploy/).
  const relay = createRelayServer({ host, port, trustProxy: process.env.TRUST_PROXY === "1" });
  const address = await relay.listen();
  process.stdout.write(`Local relay listening at http://${address.address}:${address.port} (WebSocket /v1/relay)\n`);
  const shutdown = () => relay.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
