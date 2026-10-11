import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_FRAME_BYTES = 1_048_576;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export class RelayError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function digestToken(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function sameDigest(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateJoin(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new RelayError("BAD_JOIN", "invalid join frame");
  if (message.type !== "join" || message.protocolVersion !== 1) throw new RelayError("BAD_JOIN", "unsupported relay protocol");
  if (typeof message.roomId !== "string" || !ROOM_ID_RE.test(message.roomId)) throw new RelayError("BAD_JOIN", "invalid room id");
  if (typeof message.roomToken !== "string" || !TOKEN_RE.test(message.roomToken)) throw new RelayError("BAD_JOIN", "invalid room token");
  if (message.role !== "desktop" && message.role !== "mobile") throw new RelayError("BAD_JOIN", "invalid endpoint role");
  // The desktop alone holds the owner token: phones (which all share the room token) can't take its seat.
  if (message.role === "desktop" && (typeof message.ownerToken !== "string" || !TOKEN_RE.test(message.ownerToken))) {
    throw new RelayError("BAD_JOIN", "desktop must present the owner token");
  }
  return { roomId: message.roomId, roomToken: message.roomToken, ownerToken: message.role === "desktop" ? message.ownerToken : null, role: message.role };
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return MAX_FRAME_BYTES + 1;
  }
}

function validateOpaqueEnvelope(peer, envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new RelayError("BAD_ENVELOPE", "invalid relay envelope");
  if (envelope.type === "handshake") {
    if (typeof envelope.payload !== "string" || envelope.payload.length > 32_768 || !/^[A-Za-z0-9_-]+$/.test(envelope.payload)) {
      throw new RelayError("BAD_ENVELOPE", "invalid handshake payload");
    }
    return;
  }
  if (envelope.type !== "data") throw new RelayError("BAD_ENVELOPE", "unknown relay envelope type");
  const frame = envelope.frame;
  if (!frame || frame.version !== 1 || !/^[A-Za-z0-9_-]{8,128}$/.test(frame.sessionId ?? "")) throw new RelayError("BAD_FRAME", "invalid encrypted frame header");
  const direction = peer.role === "desktop" ? "desktop-to-mobile" : "mobile-to-desktop";
  if (frame.direction !== direction || !/^(0|[1-9][0-9]*)$/.test(frame.counter ?? "")) throw new RelayError("BAD_FRAME", "invalid encrypted frame direction or counter");
  if (typeof frame.ciphertext !== "string" || typeof frame.tag !== "string" || !/^[A-Za-z0-9_-]*$/.test(frame.ciphertext) || !/^[A-Za-z0-9_-]{22}$/.test(frame.tag)) {
    throw new RelayError("BAD_FRAME", "invalid encrypted frame encoding");
  }
}

/** In-memory router only: application frames are forwarded immediately and never queued or persisted. */
export class RoomHub {
  #rooms = new Map();
  #clock;
  #maxRooms;
  #idleTtlMs;

  #maxRoomsPerIp;

  /** maxRoomsPerIp: rooms one client address may have created and still hold, so nobody fills the relay. */
  constructor({ clock = Date.now, maxRooms = 10_000, idleTtlMs = 24 * 60 * 60 * 1000, maxRoomsPerIp = 4 } = {}) {
    this.#clock = clock;
    this.#maxRooms = maxRooms;
    this.#idleTtlMs = idleTtlMs;
    this.#maxRoomsPerIp = maxRoomsPerIp;
  }

  join(peer, input) {
    if (peer.roomId) throw new RelayError("ALREADY_JOINED", "connection already joined a room");
    const { roomId, roomToken, ownerToken, role } = validateJoin(input);
    let room = this.#rooms.get(roomId);
    if (!room) {
      if (role !== "desktop") throw new RelayError("ROOM_NOT_FOUND", "desktop is offline");
      if (this.#rooms.size >= this.#maxRooms) throw new RelayError("CAPACITY", "relay room capacity reached");
      const ip = peer.ip ?? "";
      let mine = 0;
      for (const r of this.#rooms.values()) if (r.creatorIp === ip) mine++;
      if (mine >= this.#maxRoomsPerIp) throw new RelayError("CAPACITY", "too many rooms from this address");
      room = { tokenHash: digestToken(roomToken), ownerHash: digestToken(ownerToken), creatorIp: ip, desktop: null, mobile: null, lastUsedAt: this.#clock() };
      this.#rooms.set(roomId, room);
    } else if (!sameDigest(room.tokenHash, digestToken(roomToken))) {
      throw new RelayError("AUTH_FAILED", "room authentication failed");
    } else if (role === "desktop" && !sameDigest(room.ownerHash, digestToken(ownerToken))) {
      throw new RelayError("AUTH_FAILED", "room authentication failed");
    }
    if (room[role]) throw new RelayError("ROLE_BUSY", "that endpoint role is already connected");
    peer.roomId = roomId;
    peer.role = role;
    room[role] = peer;
    room.lastUsedAt = this.#clock();
    const otherOnline = Boolean(room[role === "desktop" ? "mobile" : "desktop"]);
    peer.sendJson({ type: "joined", protocolVersion: 1, role, presence: { online: otherOnline } });
    const other = room[role === "desktop" ? "mobile" : "desktop"];
    other?.sendJson({ type: "presence", role, online: true, at: this.#clock() });
    return { roomId, role };
  }

  forward(peer, envelope) {
    if (!peer.roomId || !peer.role) throw new RelayError("NOT_JOINED", "join a room first");
    // The room's owner (desktop) may disconnect its phone: a revoked device or a failed handshake
    // shouldn't keep the room's only phone seat.
    if (envelope?.type === "kick") {
      if (peer.role !== "desktop") throw new RelayError("FORBIDDEN", "only the desktop can disconnect the phone");
      const room = this.#rooms.get(peer.roomId);
      const phone = room?.mobile;
      if (!phone) return false;
      phone.sendJson({ type: "error", code: "KICKED", message: "the desktop disconnected this phone" });
      phone.close?.(4001, "kicked");
      this.leave(phone);
      return true;
    }
    if (jsonBytes(envelope) > MAX_FRAME_BYTES) throw new RelayError("FRAME_TOO_LARGE", "frame exceeds 1 MiB");
    validateOpaqueEnvelope(peer, envelope);
    const room = this.#rooms.get(peer.roomId);
    if (!room || room[peer.role] !== peer) throw new RelayError("ROOM_CLOSED", "room is no longer available");
    room.lastUsedAt = this.#clock();
    const recipient = room[peer.role === "desktop" ? "mobile" : "desktop"];
    if (!recipient) return false;
    recipient.sendJson({ type: "forward", from: peer.role, envelope });
    return true;
  }

  leave(peer) {
    if (!peer.roomId || !peer.role) return;
    const roomId = peer.roomId;
    const role = peer.role;
    const room = this.#rooms.get(roomId);
    if (!room || room[role] !== peer) {
      peer.roomId = undefined;
      peer.role = undefined;
      return;
    }
    peer.roomId = undefined;
    peer.role = undefined;
    room[role] = null;
    room.lastUsedAt = this.#clock();
    const other = role === "desktop" ? room.mobile : room.desktop;
    other?.sendJson({ type: "presence", role, online: false, at: this.#clock() });
  }

  sweep() {
    const now = this.#clock();
    let removed = 0;
    for (const [roomId, room] of this.#rooms) {
      if (!room.desktop && !room.mobile && now - room.lastUsedAt >= this.#idleTtlMs) {
        this.#rooms.delete(roomId);
        removed++;
      }
    }
    return removed;
  }

  get roomCount() { return this.#rooms.size; }
}
