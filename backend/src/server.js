const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const LOCAL_DEV_PORT = 3000;
const isLocalDev = process.env.npm_lifecycle_event === 'dev';
const PORT = isLocalDev ? LOCAL_DEV_PORT : process.env.PORT || LOCAL_DEV_PORT;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:4200,http://127.0.0.1:4200';
const allowedOrigins = CLIENT_ORIGIN.split(',').map((origin) => origin.trim());

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST'],
};

app.use(cors(corsOptions));
app.use(express.json());

const gameState = {
  rooms: new Map(),
  players: new Map(),
};

const PRESENCE_CHECK_MS = 6000;

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (gameState.rooms.has(code));

  return code;
}

function toLobby(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      joinedAt: player.joinedAt,
      active: player.active,
      ready: player.ready,
    })),
    createdAt: room.createdAt,
  };
}

function getHostPlayer(room) {
  return room.players.get(room.hostId);
}

function askHostForBannedPlayers(room) {
  const hostPlayer = getHostPlayer(room);

  if (!hostPlayer?.socketId) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    io.to(hostPlayer.socketId)
      .timeout(2500)
      .emit('room:get-banned-players', { code: room.code }, (error, responses) => {
        if (error || !responses?.[0]?.ok) {
          resolve(null);
          return;
        }

        resolve(Array.isArray(responses[0].bannedPlayerIds) ? responses[0].bannedPlayerIds : []);
      });
  });
}

function broadcastLobby(room) {
  io.to(room.code).emit('room:lobby-updated', toLobby(room));
}

function upsertPlayer(room, socket, playerId, playerName) {
  const now = Date.now();
  const existingPlayer = room.players.get(playerId);

  if (existingPlayer) {
    existingPlayer.name = playerName;
    existingPlayer.socketId = socket.id;
    existingPlayer.lastSeen = now;
    existingPlayer.missedPresenceChecks = 0;
    existingPlayer.inLobby = true;
    existingPlayer.active = true;
    return existingPlayer;
  }

  const player = {
    id: playerId,
    socketId: socket.id,
    name: playerName,
      joinedAt: new Date().toISOString(),
    lastSeen: now,
    missedPresenceChecks: 0,
    currentUrl: '',
    inLobby: true,
    active: true,
    ready: false,
  };

  room.players.set(playerId, player);
  return player;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/state-preview', (_req, res) => {
  res.json({
    rooms: gameState.rooms.size,
    players: gameState.players.size,
  });
});

const io = new Server(server, {
  cors: corsOptions,
});

io.on('connection', (socket) => {
  gameState.players.set(socket.id, {
    id: socket.id,
    connectedAt: new Date().toISOString(),
  });

  socket.emit('server:ready', {
    socketId: socket.id,
    message: 'Socket conectado. Listo para futuras salas.',
  });

  socket.on('room:create', (payload = {}, callback) => {
    const playerName = String(payload.playerName || '').trim();
    const playerId = String(payload.playerId || '').trim();

    if (!playerName) {
      callback?.({ ok: false, reason: 'El nombre de usuario es obligatorio.' });
      return;
    }

    if (!playerId) {
      callback?.({ ok: false, reason: 'El identificador de jugador es obligatorio.' });
      return;
    }

    const code = generateRoomCode();
    const room = {
      code,
      hostId: playerId,
      settings: payload.settings || {},
      players: new Map(),
      bannedPlayerIds: new Set(),
      createdAt: new Date().toISOString(),
    };

    upsertPlayer(room, socket, playerId, playerName);
    gameState.rooms.set(code, room);
    socket.join(code);

    callback?.({
      ok: true,
      lobby: toLobby(room),
    });
  });

  socket.on('room:join', async (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerName = String(payload.playerName || '').trim();
    const playerId = String(payload.playerId || '').trim();
    const room = gameState.rooms.get(code);

    if (!playerName) {
      callback?.({ ok: false, reason: 'El nombre de usuario es obligatorio.' });
      return;
    }

    if (!room) {
      callback?.({ ok: false, reason: 'No existe una sala con ese codigo.' });
      return;
    }

    if (!playerId) {
      callback?.({ ok: false, reason: 'El identificador de jugador es obligatorio.' });
      return;
    }

    const hostPlayer = getHostPlayer(room);
    const isHostRejoining = playerId === room.hostId;

    if (!isHostRejoining && !hostPlayer?.active) {
      callback?.({ ok: false, reason: 'El host no esta presente en el lobby.' });
      return;
    }

    if (!isHostRejoining) {
      const bannedPlayerIds = await askHostForBannedPlayers(room);
      const serverBannedPlayerIds = room.bannedPlayerIds || new Set();

      if (!bannedPlayerIds) {
        callback?.({ ok: false, reason: 'No se pudo validar la lista de expulsados con el host.' });
        return;
      }

      if (bannedPlayerIds.includes(playerId) || serverBannedPlayerIds.has(playerId)) {
        callback?.({ ok: false, reason: 'Has sido expulsado de este lobby.' });
        return;
      }
    }

    upsertPlayer(room, socket, playerId, playerName);
    socket.join(code);
    broadcastLobby(room);

    callback?.({
      ok: true,
      lobby: toLobby(room),
    });
  });

  socket.on('room:heartbeat', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);

    if (!room || !player) {
      return;
    }

    player.socketId = socket.id;
    player.lastSeen = Date.now();
    player.missedPresenceChecks = 0;
    player.active = true;
  });

  socket.on('room:presence-response', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);

    if (!room || !player) {
      return;
    }

    player.currentUrl = String(payload.currentUrl || '');
    player.inLobby = Boolean(payload.inLobby);
    player.lastSeen = Date.now();
    player.missedPresenceChecks = payload.inLobby ? 0 : player.missedPresenceChecks + 1;
    player.active = payload.inLobby;
  });

  socket.on('room:set-ready', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);

    if (!room || !player) {
      callback?.({ ok: false, reason: 'No estas en este lobby.' });
      return;
    }

    if (playerId === room.hostId) {
      callback?.({ ok: false, reason: 'El host no necesita marcarse como listo.' });
      return;
    }

    player.ready = Boolean(payload.ready);
    broadcastLobby(room);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('room:update-settings', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room) {
      callback?.({ ok: false, reason: 'No existe una sala con ese codigo.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede editar la configuracion.' });
      return;
    }

    room.settings = payload.settings || room.settings;
    broadcastLobby(room);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('room:leave', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room) {
      callback?.({ ok: true });
      return;
    }

    if (playerId === room.hostId) {
      io.to(code).emit('room:closed', { code, reason: 'El host ha cerrado el lobby.' });
      gameState.rooms.delete(code);
      callback?.({ ok: true });
      return;
    }

    room.players.delete(playerId);
    socket.leave(code);
    broadcastLobby(room);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('room:kick-player', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const targetPlayerId = String(payload.targetPlayerId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room) {
      callback?.({ ok: false, reason: 'No existe una sala con ese codigo.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede expulsar jugadores.' });
      return;
    }

    if (targetPlayerId === room.hostId) {
      callback?.({ ok: false, reason: 'El host no puede expulsarse a si mismo.' });
      return;
    }

    room.bannedPlayerIds = new Set([...(room.bannedPlayerIds || []), targetPlayerId]);
    const targetPlayer = room.players.get(targetPlayerId);

    if (!targetPlayer) {
      callback?.({ ok: false, reason: 'Ese jugador ya no esta en el lobby.' });
      return;
    }

    room.players.delete(targetPlayerId);
    io.to(targetPlayer.socketId).emit('room:kicked', { code });
    broadcastLobby(room);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('disconnect', () => {
    gameState.players.delete(socket.id);
  });
});

setInterval(() => {
  for (const room of gameState.rooms.values()) {
    const hostPlayer = getHostPlayer(room);

    if (!hostPlayer) {
      io.to(room.code).emit('room:closed', { code: room.code, reason: 'El host ya no esta presente.' });
      gameState.rooms.delete(room.code);
      continue;
    }

    for (const [playerId, player] of room.players.entries()) {
      player.missedPresenceChecks += 1;
      io.to(player.socketId).emit('room:presence-check', { code: room.code, playerId });

      if (player.missedPresenceChecks < 2) {
        continue;
      }

      room.players.delete(playerId);
      broadcastLobby(room);
    }
  }
}, PRESENCE_CHECK_MS);

server.listen(PORT, () => {
  console.log(`Backend escuchando en http://localhost:${PORT}`);
});
