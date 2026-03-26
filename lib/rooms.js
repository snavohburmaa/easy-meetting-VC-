/** In-memory rooms: code -> { hostId, participants:Set, meta: Map<socketId, {email,name}> } */
const rooms = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

function createRoom(hostSocketId) {
  let code = randomCode();
  while (rooms.has(code)) {
    code = randomCode();
  }
  const room = {
    hostId: hostSocketId,
    participants: new Set([hostSocketId]),
    meta: new Map(),
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return code;
}

function getRoom(code) {
  if (!code || typeof code !== "string") return undefined;
  return rooms.get(code.trim().toUpperCase());
}

function joinRoom(code, socketId) {
  const room = getRoom(code);
  if (!room) return { ok: false };
  room.participants.add(socketId);
  return { ok: true, room };
}

function setParticipantMeta(code, socketId, user) {
  const room = getRoom(code);
  if (!room) return;
  room.meta.set(socketId, { email: user.email, name: user.name });
}

function removeParticipant(socketId) {
  for (const [code, room] of rooms.entries()) {
    if (!room.participants.has(socketId)) continue;
    room.participants.delete(socketId);
    room.meta.delete(socketId);
    const hostLeft = room.hostId === socketId;
    const empty = room.participants.size === 0;
    if (hostLeft || empty) {
      rooms.delete(code);
      return { code, ended: true, reason: hostLeft ? "host_left" : "empty" };
    }
    return { code, ended: false, leftId: socketId };
  }
  return null;
}

function endRoomByHost(code, requesterSocketId) {
  const room = getRoom(code);
  if (!room || room.hostId !== requesterSocketId) return false;
  rooms.delete(code);
  return true;
}

function listPeers(code, exceptSocketId) {
  const room = getRoom(code);
  if (!room) return [];
  return [...room.participants]
    .filter((id) => id !== exceptSocketId)
    .map((id) => ({
      id,
      name: room.meta.get(id)?.name || "Guest",
    }));
}

function isHost(code, socketId) {
  const room = getRoom(code);
  return !!(room && room.hostId === socketId);
}

/** Get all participant metadata (email, name) + host email for a room. */
function getParticipantsMeta(code) {
  const room = getRoom(code);
  if (!room) return { hostEmail: "", participants: [] };
  const hostMeta = room.meta.get(room.hostId);
  const participants = [];
  for (const [, meta] of room.meta) {
    if (meta && meta.email) participants.push({ email: meta.email, name: meta.name || "" });
  }
  return { hostEmail: hostMeta?.email || "", participants };
}

export {
  rooms,
  createRoom,
  getRoom,
  joinRoom,
  setParticipantMeta,
  removeParticipant,
  endRoomByHost,
  listPeers,
  isHost,
  getParticipantsMeta,
};
