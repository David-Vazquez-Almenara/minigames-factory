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
const HOST_RECONNECT_WAIT_MS = 60000;
const COUNTDOWN_MS = 3000;
const IMAGE_SELECTION_MS = 60000;
const FALLBACK_THEMES = [
  'Espacial',
  'Fantasia',
  'Evento historico',
  'Misterio',
  'Aventura',
  'Ciencia',
  'Deportes',
  'Musica',
];
const FALLBACK_CHARACTER_TYPES = [
  'Personaje real',
  'Objeto',
  'Criatura imaginaria',
  'Heroe',
  'Villano',
  'Invento',
  'Lugar',
  'Profesional',
];

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

function toMatchState(room) {
  if (!room.match) {
    return null;
  }

  const phase =
    room.match.phase === 'countdown' && Date.now() >= room.match.countdownEndsAt
      ? 'image-selection'
      : room.match.phase;

  return {
    lobbyId: room.code,
    phase,
    assignments: Array.from(room.match.assignments.values()),
    readySelections: Array.from(room.match.selections.values()).map((selection) => ({
      playerId: selection.playerId,
      targetPlayerId: selection.targetPlayerId,
      imageUrl: selection.imageUrl,
      theme: selection.theme,
      characterType: selection.characterType,
    })),
    readyCount: room.match.selections.size,
    totalPlayers: room.players.size,
    hostPaused: room.match.hostPaused,
    hostPauseDeadline: room.match.hostPauseDeadline,
    countdownEndsAt: room.match.countdownEndsAt,
    imageSelectionEndsAt: room.match.imageSelectionEndsAt,
    waitingPlayerIds: Array.from(room.match.excludedPlayers?.keys() || []),
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

function broadcastImageSelectionUpdate(room) {
  if (!room.match) {
    return;
  }

  io.to(room.code).emit('match:image-selection-updated', {
    lobbyId: room.code,
    readyPlayerIds: Array.from(room.match.selections.keys()),
    readyCount: room.match.selections.size,
    totalPlayers: room.players.size,
    imageSelectionEndsAt: room.match.imageSelectionEndsAt,
  });
}

function getUnconfirmedPlayers(room) {
  if (!room.match) {
    return [];
  }

  const failedIds = room.match.lastVerificationFailedPlayerIds || new Set();

  return Array.from(room.players.values()).filter(
    (player) => !room.match.selections.has(player.id) || failedIds.has(player.id),
  );
}

function resetImageSelectionTimer(room) {
  if (!room.match || room.match.phase === 'image-selection-complete') {
    return;
  }

  room.match.phase = 'image-selection';
  for (const playerId of room.match.lastVerificationFailedPlayerIds || []) {
    room.match.selections.delete(playerId);
  }
  room.match.lastVerificationFailedPlayerIds = new Set();
  room.match.imageSelectionEndsAt = Date.now() + IMAGE_SELECTION_MS;

  io.to(room.code).emit('match:timer-reset', {
    lobbyId: room.code,
    imageSelectionEndsAt: room.match.imageSelectionEndsAt,
  });
  broadcastImageSelectionUpdate(room);
}

function emitAllImagesReadyIfComplete(room) {
  if (!room.match || room.match.phase === 'image-selection-complete' || room.match.phase === 'game-started') {
    return;
  }

  if (getUnconfirmedPlayers(room).length > 0) {
    return;
  }

  room.match.phase = 'game-started';
  const selectedImages = Array.from(room.match.selections.values()).map((selection) => ({
    playerId: selection.targetPlayerId,
    imageUrl: selection.imageUrl,
    theme: selection.theme,
    characterType: selection.characterType,
  }));

  io.to(room.code).emit('match:all-images-ready', {
    lobbyId: room.code,
    selectedImages,
  });
  io.to(room.code).emit('match:game-started', {
    lobbyId: room.code,
  });
}

function buildAssignments(room) {
  const players = Array.from(room.players.values());
  const shuffledTargets = [...players];

  for (let attempt = 0; attempt < 80; attempt += 1) {
    for (let index = shuffledTargets.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [shuffledTargets[index], shuffledTargets[randomIndex]] = [shuffledTargets[randomIndex], shuffledTargets[index]];
    }

    if (players.every((player, index) => player.id !== shuffledTargets[index].id)) {
      break;
    }
  }

  if (players.some((player, index) => player.id === shuffledTargets[index].id)) {
    for (let index = 0; index < players.length; index += 1) {
      shuffledTargets[index] = players[(index + 1) % players.length];
    }
  }

  const assignments = new Map();
  const settings = room.settings || {};

  players.forEach((player, index) => {
    const theme = settings.randomThemePerPlayer
      ? FALLBACK_THEMES[Math.floor(Math.random() * FALLBACK_THEMES.length)]
      : settings.themeCategories?.[index % settings.themeCategories.length] || FALLBACK_THEMES[index % FALLBACK_THEMES.length];
    const characterType = settings.randomCharacterTypePerPlayer
      ? FALLBACK_CHARACTER_TYPES[Math.floor(Math.random() * FALLBACK_CHARACTER_TYPES.length)]
      : settings.characterTypes?.[index % settings.characterTypes.length] ||
        FALLBACK_CHARACTER_TYPES[index % FALLBACK_CHARACTER_TYPES.length];

    assignments.set(player.id, {
      playerId: player.id,
      targetPlayerId: shuffledTargets[index].id,
      targetPlayerName: shuffledTargets[index].name,
      theme,
      characterType,
    });
  });

  return assignments;
}

function startHostPause(room) {
  if (!room.match || room.match.hostPaused) {
    return;
  }

  room.match.hostPaused = true;
  room.match.hostPauseStartedAt = Date.now();
  room.match.hostPauseDeadline = room.match.hostPauseStartedAt + HOST_RECONNECT_WAIT_MS;

  io.to(room.code).emit('match:host-paused', {
    lobbyId: room.code,
    deadline: room.match.hostPauseDeadline,
  });
}

function resumeHostPause(room) {
  if (!room.match?.hostPaused) {
    return;
  }

  room.match.hostPaused = false;
  room.match.hostPauseStartedAt = null;
  room.match.hostPauseDeadline = null;

  io.to(room.code).emit('match:host-resumed', {
    lobbyId: room.code,
    imageSelectionEndsAt: room.match.imageSelectionEndsAt,
  });

  resetImageSelectionTimer(room);
}

function closeMatchRoom(room, reason) {
  io.to(room.code).emit('match:closed', { lobbyId: room.code, reason });
  io.to(room.code).emit('room:closed', { code: room.code, reason });
  gameState.rooms.delete(room.code);
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
    existingPlayer.ready = room.match ? false : existingPlayer.ready;
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

    if (room.match?.excludedPlayers?.has(playerId)) {
      socket.join(code);
      socket.emit('match:started', toMatchState(room));
      socket.emit('match:waiting-next-round', {
        lobbyId: code,
        reason: 'No seleccionaste imagen a tiempo. Espera a la siguiente ronda.',
      });
      callback?.({
        ok: true,
        lobby: toLobby(room),
        match: toMatchState(room),
        waitingNextRound: true,
      });
      return;
    }

    const playerWasInactive = room.players.has(playerId) && !room.players.get(playerId).active;
    upsertPlayer(room, socket, playerId, playerName);
    socket.join(code);

    if (isHostRejoining && room.match?.hostPaused) {
      resumeHostPause(room);
    }

    if (room.match && room.match.phase !== 'image-selection-complete') {
      room.match.selections.delete(playerId);

      if (!isHostRejoining || playerWasInactive) {
        resetImageSelectionTimer(room);
      }
    }

    broadcastLobby(room);

    if (room.match && room.match.phase !== 'lobby') {
      socket.emit('match:started', toMatchState(room));
      broadcastImageSelectionUpdate(room);
    }

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

    const wasInactive = !player.active;
    player.socketId = socket.id;
    player.lastSeen = Date.now();
    player.missedPresenceChecks = 0;
    player.active = true;

    if (room.match && wasInactive) {
      player.ready = false;
      room.match.selections.delete(playerId);

      if (playerId === room.hostId && room.match.hostPaused) {
        resumeHostPause(room);
      } else {
        resetImageSelectionTimer(room);
      }

      broadcastLobby(room);
      broadcastImageSelectionUpdate(room);
    }
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
      closeMatchRoom(room, 'El host ha cerrado el lobby.');
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

  socket.on('match:start', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room) {
      callback?.({ ok: false, reason: 'No existe una sala con ese codigo.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede iniciar la partida.' });
      return;
    }

    const players = Array.from(room.players.values());

    if (players.length < 2) {
      callback?.({ ok: false, reason: 'Se necesitan al menos 2 jugadores para iniciar.' });
      return;
    }

    const guestsReady = players.filter((player) => player.id !== room.hostId).every((player) => player.ready);

    if (!guestsReady) {
      callback?.({ ok: false, reason: 'Todos los jugadores deben estar listos antes de iniciar.' });
      return;
    }

    room.match = {
      phase: 'countdown',
      assignments: buildAssignments(room),
      selections: new Map(),
      hostPaused: false,
      hostPauseStartedAt: null,
      hostPauseDeadline: null,
      startedAt: Date.now(),
      countdownEndsAt: Date.now() + COUNTDOWN_MS,
      imageSelectionEndsAt: Date.now() + COUNTDOWN_MS + IMAGE_SELECTION_MS,
      excludedPlayers: new Map(),
      lastVerificationFailedPlayerIds: new Set(),
    };

    const matchState = toMatchState(room);
    io.to(code).emit('match:started', matchState);
    callback?.({ ok: true, lobby: toLobby(room), match: matchState });
  });

  socket.on('match:image-selection-ready', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const imageUrl = String(payload.imageUrl || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);
    const assignment = room?.match?.assignments.get(playerId);

    if (!room || !player || !room.match || !assignment) {
      callback?.({ ok: false, reason: 'No estas en una seleccion de personaje activa.' });
      return;
    }

    if (room.match.hostPaused) {
      callback?.({ ok: false, reason: 'La partida esta pausada esperando al host.' });
      return;
    }

    room.match.phase = 'image-selection';
    room.match.selections.set(playerId, {
      playerId,
      targetPlayerId: assignment.targetPlayerId,
      imageUrl,
      theme: assignment.theme,
      characterType: assignment.characterType,
    });
    room.match.lastVerificationFailedPlayerIds?.delete(playerId);

    broadcastImageSelectionUpdate(room);

    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('match:player-reconnected-selection', (payload = {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);

    if (!room || !player || !room.match || room.match.phase === 'image-selection-complete') {
      return;
    }

    socket.join(code);
    player.socketId = socket.id;
    player.active = true;
    player.lastSeen = Date.now();
    player.missedPresenceChecks = 0;
    room.match.selections.delete(playerId);
    room.match.lastVerificationFailedPlayerIds?.delete(playerId);
    resetImageSelectionTimer(room);
    broadcastLobby(room);
    broadcastImageSelectionUpdate(room);
    socket.emit('match:started', toMatchState(room));
  });

  socket.on('match:extend-image-selection', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room || !room.match) {
      callback?.({ ok: false, reason: 'No hay una seleccion de imagen activa.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede ampliar el tiempo.' });
      return;
    }

    resetImageSelectionTimer(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:verify-image-selection-ready', async (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room || !room.match) {
      callback?.({ ok: false, reason: 'No hay una seleccion de imagen activa.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede verificar la seleccion.' });
      return;
    }

    const failedPlayers = [];

    for (const player of room.players.values()) {
      if (!room.match.selections.has(player.id)) {
        failedPlayers.push(player);
        continue;
      }

      if (!player.socketId || !player.active) {
        failedPlayers.push(player);
        continue;
      }

      const confirmed = await new Promise((resolve) => {
        io.to(player.socketId)
          .timeout(2500)
          .emit('match:confirm-image-ready', { lobbyId: code, playerId: player.id }, (error, responses) => {
            if (error || !responses?.[0]?.ok || !responses[0].ready) {
              resolve(false);
              return;
            }

            resolve(true);
          });
      });

      if (!confirmed) {
        failedPlayers.push(player);
      }
    }

    room.match.lastVerificationFailedPlayerIds = new Set(failedPlayers.map((player) => player.id));

    if (failedPlayers.length) {
      callback?.({
        ok: false,
        reason: 'Hay jugadores que no confirmaron que estan listos.',
        lobby: toLobby(room),
        match: toMatchState(room),
        unreadyPlayers: failedPlayers.map((player) => ({
          playerId: player.id,
          name: player.name,
          round: 1,
          reason: 'image-selection-verification-failed',
        })),
      });
      return;
    }

    emitAllImagesReadyIfComplete(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:exclude-unready-players', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room || !room.match) {
      callback?.({ ok: false, reason: 'No hay una seleccion de imagen activa.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede sacar jugadores.' });
      return;
    }

    const unreadyPlayers = getUnconfirmedPlayers(room).filter((player) => player.id !== room.hostId);

    if (!unreadyPlayers.length) {
      callback?.({ ok: false, reason: 'No hay jugadores invitados sin imagen para sacar.' });
      return;
    }

    for (const player of unreadyPlayers) {
      room.match.excludedPlayers.set(player.id, {
        playerId: player.id,
        name: player.name,
        round: 1,
        reason: 'image-selection-timeout',
      });
      io.to(player.socketId).emit('match:waiting-next-round', {
        lobbyId: code,
        reason: 'No seleccionaste imagen a tiempo. Espera a la siguiente ronda.',
      });
      room.players.delete(player.id);
    }

    broadcastLobby(room);
    broadcastImageSelectionUpdate(room);
    emitAllImagesReadyIfComplete(room);

    callback?.({
      ok: true,
      lobby: toLobby(room),
      match: toMatchState(room),
      excludedPlayers: unreadyPlayers.map((player) => ({
        playerId: player.id,
        name: player.name,
        round: 1,
        reason: 'image-selection-timeout',
      })),
    });
  });

  socket.on('disconnect', () => {
    gameState.players.delete(socket.id);
  });
});

setInterval(() => {
  for (const room of gameState.rooms.values()) {
    const hostPlayer = getHostPlayer(room);

    if (room.match?.hostPaused && room.match.hostPauseDeadline && Date.now() >= room.match.hostPauseDeadline) {
      closeMatchRoom(room, 'La sala se ha cerrado porque el host no volvio a tiempo.');
      continue;
    }

    if (!hostPlayer) {
      if (room.match && room.match.phase !== 'lobby') {
        startHostPause(room);
        continue;
      }

      closeMatchRoom(room, 'El host ya no esta presente.');
      continue;
    }

    for (const [playerId, player] of room.players.entries()) {
      player.missedPresenceChecks += 1;
      io.to(player.socketId).emit('room:presence-check', { code: room.code, playerId });

      if (player.missedPresenceChecks < 2) {
        continue;
      }

      if (playerId === room.hostId && room.match && room.match.phase !== 'lobby') {
        player.active = false;
        player.ready = false;
        room.match.selections.delete(playerId);
        broadcastImageSelectionUpdate(room);
        startHostPause(room);
        continue;
      }

      if (room.match && room.match.phase !== 'lobby') {
        player.active = false;
        player.ready = false;
        room.match.selections.delete(playerId);
        broadcastLobby(room);
        broadcastImageSelectionUpdate(room);
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
