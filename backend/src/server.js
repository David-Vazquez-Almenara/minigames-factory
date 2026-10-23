const express = require('express');
const cors = require('cors');
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const { Server } = require('socket.io');

/* ------------------------------------------------------------------ */
/* Configuracion por variables de entorno                              */
/* ------------------------------------------------------------------ */
// En local se leen de backend/.env. En Render solo cuentan las variables de su panel: un .env subido por
// error nunca llega a produccion (Render define RENDER=true en sus servicios).
const isRender = process.env.RENDER === 'true';
const isProduction = isRender || process.env.NODE_ENV === 'production';

if (!isRender) {
  require('dotenv').config();
}

const LOCAL_CLIENT_ORIGINS = 'http://localhost:4200,http://127.0.0.1:4200';
const PORT = Number(process.env.PORT) || 3000;
// URL(s) del frontend que pueden conectarse (CORS de HTTP y de Socket.IO), separadas por comas.
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || (isProduction ? '' : LOCAL_CLIENT_ORIGINS);

if (!CLIENT_ORIGIN) {
  console.error('[config] Falta CLIENT_ORIGIN (URL del frontend, p. ej. https://tu-sitio.netlify.app). Definela en Render > Environment.');
  process.exit(1);
}

// Se normalizan para que una barra final ("https://sitio.netlify.app/") no rompa la comparacion del CORS.
const allowedOrigins = CLIENT_ORIGIN.split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const IMPOSTOR_WORDS = require('./data/impostor-words.json').entries;

const app = express();
const server = http.createServer(app);

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
const TIMER_GRACE_MS = 1500;
const ROULETTE_LEAD_MS = 900;
const ROULETTE_SPIN_MS = 6400;
const ROULETTE_REVEAL_MS = 2600;
const PAINT_DRAWING_MS = 60000;
const PAINT_VOTING_MS = 20000;
const IMPOSTOR_MAX_ROUNDS = 5;
const IMPOSTOR_VOTE_MS = 90000;
// Cubre en el cliente la revelacion de votos (3,2 s) y la animacion de "nadie fue expulsado" (7 s).
const IMPOSTOR_NO_EJECTION_MS = 10500;
const TEN_BUT_SPIN_MS = 5200;
const TEN_BUT_REVEAL_MS = 2600;
const TEN_BUT_ANSWER_MS = 75000;
// Margen para la intro y la explicacion del minijuego en los clientes antes de que empiece a correr el tiempo.
const MINIGAME_INTRO_MS = 7000;
// El portavoz no tiene que pulsar nada: su cliente gira la ruleta 1 s despues de mostrarla y, si no lo hace
// (desconexion), el servidor la gira solo poco despues como respaldo.
const TEN_BUT_AUTO_SPIN_MS = MINIGAME_INTRO_MS + 2500;
const PINTURILLO_DRAW_MS = 90000;
const PINTURILLO_FRAME_MIN_GAP_MS = 150;
const PINTURILLO_MAX_FRAME_LENGTH = 450000;
const PINTURILLO_CHAT_HISTORY = 80;
const POGO_COUNTDOWN_MS = 3000;
const POGO_RACE_MS = 60000;
const POGO_GOAL = 30;
const POGO_MIN_JUMP_GAP_MS = 450;
const PLAYER_COLORS = [
  'red',
  'blue',
  'green',
  'pink',
  'orange',
  'yellow',
  'black',
  'white',
  'purple',
  'brown',
  'cyan',
  'lime',
  'maroon',
  'rose',
  'banana',
  'gray',
  'tan',
  'coral',
];

// Registro unico de minijuegos. Para anadir uno nuevo basta con registrarlo aqui, dejar su imagen en
// frontend/public/assets/minigames y crear su componente: la ruleta se construye a partir de esta lista.
const MINIGAMES = [
  {
    id: 'math-operations',
    title: 'Operaciones matematicas',
    description:
      'Resuelve las mismas operaciones que el resto. Cuantas mas aciertes y mas rapido termines, mas puntos podras ganar.',
    image: 'assets/minigames/math-operations.png',
    accent: '#d9f4ff',
    minPlayers: 1,
  },
  {
    id: 'paint',
    title: 'A Pintar',
    description:
      'Dibuja el objeto secreto y vota despues por la obra que mas se parezca. El mas votado gana mas puntos.',
    image: 'assets/minigames/paint.png',
    accent: '#fff4b8',
    minPlayers: 2,
  },
  {
    id: 'impostor',
    title: 'El Impostor',
    description:
      'Todos conocen la palabra secreta menos uno, que solo sabe la categoria. Por turnos, decid en voz alta algo relacionado y votad para expulsar al impostor.',
    image: 'assets/minigames/impostor.png',
    accent: '#ffb3b3',
    minPlayers: 3,
  },
  {
    id: 'ten-but',
    title: 'Es un 10, pero...',
    description:
      'El portavoz gira una ruleta del 1 al 10 y describe su numero con una frase del tipo "es un 10, pero...". El resto tiene que adivinarlo.',
    image: 'assets/minigames/ten-but.png',
    accent: '#b9f7a7',
    minPlayers: 2,
  },
  {
    id: 'pinturillo',
    title: 'Pinturillo',
    description:
      'Un jugador dibuja una palabra secreta y el resto la adivina por el chat. Cuanto antes la aciertes, mas puntos. Tienes 90 segundos.',
    image: 'assets/minigames/pinturillo.png',
    accent: '#ffb3b3',
    minPlayers: 2,
  },
  {
    id: 'pogo',
    title: 'Carrera en pogo',
    description:
      'Pulsa ESPACIO (o el boton) cuando la aguja pase por la zona marcada para saltar. La zona blanca pequena vale doble. Llega el primero a la meta.',
    image: 'assets/minigames/pogo.png',
    accent: '#d9f4ff',
    minPlayers: 2,
  },
];
const MINIGAME_IDS = MINIGAMES.map((minigame) => minigame.id);

function randomItem(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function shuffle(values) {
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }

  return copy;
}

function randomLandingOffset() {
  // Fraccion del ancho de la tarjeta en la que la ruleta frena antes de recolocarse en el centro.
  return Number(((Math.random() - 0.5) * 0.56).toFixed(3));
}

function toPublicMinigame(minigame) {
  return {
    id: minigame.id,
    title: minigame.title,
    description: minigame.description,
    image: minigame.image,
    accent: minigame.accent,
    minPlayers: minigame.minPlayers,
  };
}

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (gameState.rooms.has(code));

  return code;
}

function normalizeRoomSettings(settings = {}) {
  const rounds = Math.min(30, Math.max(1, Math.trunc(Number(settings.rounds) || 5)));
  const enabledMinigames = Array.isArray(settings.enabledMinigames)
    ? settings.enabledMinigames.map(String).filter((id, index, ids) => MINIGAME_IDS.includes(id) && ids.indexOf(id) === index)
    : [...MINIGAME_IDS];

  return {
    rounds,
    enabledMinigames: enabledMinigames.length ? enabledMinigames : [...MINIGAME_IDS],
  };
}

function getRoomFromPayload(payload) {
  return gameState.rooms.get(String(payload.code || payload.lobbyId || '').trim().toUpperCase());
}

// Cada cliente guarda un secreto local junto a su playerId. Los ids se comparten con todos los jugadores,
// asi que el secreto es lo que impide que otro cliente se haga pasar por alguien y lea su rol privado.
function isAuthorizedPlayer(player, payload) {
  return Boolean(player) && (!player.secret || player.secret === String(payload.playerSecret || ''));
}

function getRequestPlayer(room, payload) {
  const player = room?.players.get(String(payload.playerId || '').trim());
  return isAuthorizedPlayer(player, payload) ? player : null;
}

function isHostRequest(room, payload) {
  const hostId = String(payload.hostId || payload.playerId || '').trim();

  if (!room || room.hostId !== hostId) {
    return false;
  }

  const hostPlayer = room.players.get(hostId);
  return !hostPlayer || isAuthorizedPlayer(hostPlayer, payload);
}

// Imagen de perfil elegida por el jugador: solo URLs http(s) y de longitud razonable.
function sanitizeAvatarUrl(value) {
  const url = String(value || '').trim().slice(0, 800);
  return /^https?:\/\/\S+$/i.test(url) ? url : '';
}

function assignPlayerColor(room) {
  const usedColors = new Set(Array.from(room.players.values()).map((player) => player.color));
  return PLAYER_COLORS.find((color) => !usedColors.has(color)) || randomItem(PLAYER_COLORS);
}

function toLobby(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    settings: room.settings,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      avatarUrl: player.avatarUrl || '',
      color: player.color,
      joinedAt: player.joinedAt,
      active: player.active,
      ready: player.ready,
    })),
    createdAt: room.createdAt,
  };
}

/* ------------------------------------------------------------------ */
/* Temporizadores de sala: una unica infraestructura para todas las    */
/* fases. Se pausan con el host y se limpian al cambiar de fase.       */
/* ------------------------------------------------------------------ */

function setRoomTimer(room, key, fireAt, callback) {
  clearRoomTimer(room, key);
  room.timers = room.timers || new Map();
  const entry = { fireAt, callback, handle: null };
  room.timers.set(key, entry);

  if (!room.match?.hostPaused) {
    armRoomTimer(room, key, entry);
  }
}

function armRoomTimer(room, key, entry) {
  entry.handle = setTimeout(() => {
    if (room.timers?.get(key) !== entry || !gameState.rooms.has(room.code)) {
      return;
    }

    room.timers.delete(key);
    entry.callback();
  }, Math.max(0, entry.fireAt - Date.now()));
}

function clearRoomTimer(room, key) {
  const entry = room.timers?.get(key);

  if (!entry) {
    return;
  }

  clearTimeout(entry.handle);
  room.timers.delete(key);
}

function clearAllRoomTimers(room) {
  for (const entry of room.timers?.values() || []) {
    clearTimeout(entry.handle);
  }

  room.timers = new Map();
}

function pauseRoomTimers(room) {
  for (const entry of room.timers?.values() || []) {
    clearTimeout(entry.handle);
    entry.handle = null;
  }
}

function resumeRoomTimers(room, shiftMs) {
  for (const [key, entry] of room.timers?.entries() || []) {
    entry.fireAt += shiftMs;
    armRoomTimer(room, key, entry);
  }
}

function shiftMatchDeadlines(room, shiftMs) {
  const specialRound = room.match?.specialRound;

  if (!specialRound || !shiftMs) {
    return;
  }

  for (const key of ['paintEndsAt', 'paintVoteEndsAt']) {
    if (specialRound[key]) {
      specialRound[key] += shiftMs;
    }
  }

  if (specialRound.impostor?.voteEndsAt) {
    specialRound.impostor.voteEndsAt += shiftMs;
  }

  if (specialRound.tenBut?.answerEndsAt) {
    specialRound.tenBut.answerEndsAt += shiftMs;
  }

  if (specialRound.tenBut?.spinDeadline) {
    specialRound.tenBut.spinDeadline += shiftMs;
  }

  if (specialRound.pinturillo) {
    specialRound.pinturillo.startsAt += shiftMs;
    specialRound.pinturillo.endsAt += shiftMs;
  }

  if (specialRound.pogo) {
    specialRound.pogo.raceStartsAt += shiftMs;
    specialRound.pogo.raceEndsAt += shiftMs;
  }
}

/* ------------------------------------------------------------------ */
/* Estado publico                                                      */
/* ------------------------------------------------------------------ */

function toMatchState(room) {
  if (!room.match) {
    return null;
  }

  return {
    lobbyId: room.code,
    phase: room.match.phase,
    roundNumber: room.match.roundNumber,
    totalRounds: room.match.totalRounds,
    totalPlayers: getActivePlayers(room).length,
    hostPaused: room.match.hostPaused,
    hostPauseDeadline: room.match.hostPauseDeadline,
    countdownEndsAt: room.match.countdownEndsAt,
    roulette: room.match.roulette,
    scoreboard: room.match.scoreboard || null,
    scoreboardRequest: room.match.scoreboardRequest || null,
    finalStandings: room.match.finalStandings || null,
    specialRound: toPublicSpecialRound(room.match.specialRound),
    serverTime: Date.now(),
  };
}

function toPublicPaintSubmissions(specialRound) {
  return specialRound?.paintSubmissions
    ? Array.from(specialRound.paintSubmissions.values()).map((submission) => ({
        playerId: submission.playerId,
        playerName: submission.playerName,
        imageDataUrl: submission.imageDataUrl,
        submittedAt: submission.submittedAt,
      }))
    : [];
}

function toPublicPaintVotes(specialRound) {
  return specialRound?.paintVotes
    ? Array.from(specialRound.paintVotes.entries()).map(([voterPlayerId, targetPlayerId]) => ({
        voterPlayerId,
        targetPlayerId,
      }))
    : [];
}

// Lista blanca explicita: nada secreto (impostor, palabra, numero, votos o respuestas sin resolver) sale de aqui.
function toPublicSpecialRound(specialRound) {
  if (!specialRound) {
    return null;
  }

  return {
    roundNumber: specialRound.roundNumber,
    minigameId: specialRound.minigameId,
    title: specialRound.title,
    description: specialRound.description,
    participantIds: specialRound.participantIds,
    hasResults: Boolean(specialRound.hasResults),
    preparedByHost: specialRound.preparedByHost,
    operations: Array.isArray(specialRound.operations)
      ? specialRound.operations.map((operation) => ({
          id: String(operation.id || ''),
          prompt: String(operation.prompt || ''),
          answer: Number(operation.answer),
        }))
      : [],
    submittedPlayerIds: specialRound.submissions ? Array.from(specialRound.submissions.keys()) : [],
    paintTarget: specialRound.paintTarget || null,
    paintPhase: specialRound.paintPhase || null,
    paintEndsAt: specialRound.paintEndsAt || null,
    paintVoteEndsAt: specialRound.paintVoteEndsAt || null,
    paintSubmissions: toPublicPaintSubmissions(specialRound),
    paintVotes: toPublicPaintVotes(specialRound),
    progress: specialRound.progress
      ? Array.from(specialRound.progress.values()).map((entry) => ({
          playerId: entry.playerId,
          playerName: entry.playerName,
          correctCount: entry.correctCount,
          answeredCount: entry.answers?.length || 0,
          completed: Boolean(entry.completed),
          finishedAt: entry.finishedAt || null,
        }))
      : [],
    results: Array.isArray(specialRound.results) ? specialRound.results : [],
    impostor: toPublicImpostor(specialRound.impostor),
    tenBut: toPublicTenBut(specialRound.tenBut),
    pinturillo: toPublicPinturillo(specialRound.pinturillo),
    pogo: toPublicPogo(specialRound.pogo),
  };
}

function toPublicImpostor(impostor) {
  if (!impostor) {
    return null;
  }

  return {
    stage: impostor.stage,
    wordRound: impostor.wordRound,
    maxRounds: IMPOSTOR_MAX_ROUNDS,
    blankVoteAllowed: impostor.wordRound < IMPOSTOR_MAX_ROUNDS,
    turnOrder: impostor.turnOrder,
    turnIndex: impostor.turnIndex,
    currentTurnPlayerId: impostor.stage === 'turns' ? impostor.turnOrder[impostor.turnIndex] || null : null,
    completedTurnIds: impostor.completedTurnIds,
    votedPlayerIds: Array.from(impostor.votes.keys()),
    voteEndsAt: impostor.voteEndsAt,
    stageStartedAt: impostor.stageStartedAt,
    lastRoundResult: impostor.lastRoundResult,
    outcome: impostor.outcome,
  };
}

function toPublicTenBut(tenBut) {
  if (!tenBut) {
    return null;
  }

  return {
    stage: tenBut.stage,
    speakerId: tenBut.speakerId,
    spinDeadline: tenBut.spinDeadline,
    spinStartsAt: tenBut.spinStartsAt,
    spinDurationMs: tenBut.spinDurationMs,
    answerEndsAt: tenBut.answerEndsAt,
    answeredPlayerIds: Array.from(tenBut.answers.keys()),
    outcome: tenBut.outcome,
  };
}

// Informacion privada de un jugador concreto. Solo se envia al socket de ese jugador.
function buildPrivateState(room, playerId) {
  const specialRound = room.match?.specialRound;
  const base = {
    lobbyId: room.code,
    roundKey: specialRound ? `${room.match.roundNumber}:${specialRound.minigameId}` : null,
    minigameId: specialRound?.minigameId || null,
    impostor: null,
    tenBut: null,
    pinturillo: null,
  };

  if (!specialRound || !specialRound.participantIds.includes(playerId)) {
    return base;
  }

  if (specialRound.pinturillo) {
    base.pinturillo =
      specialRound.pinturillo.drawerId === playerId
        ? { role: 'drawer', word: specialRound.pinturillo.word, category: specialRound.pinturillo.category }
        : { role: 'guesser' };
  }

  if (specialRound.impostor) {
    const isImpostor = specialRound.impostor.impostorId === playerId;
    base.impostor = isImpostor
      ? { role: 'impostor', category: specialRound.impostor.wordEntry.category }
      : { role: 'innocent', word: specialRound.impostor.wordEntry.word };
  }

  if (specialRound.tenBut?.speakerId === playerId && specialRound.tenBut.secretNumber) {
    base.tenBut = {
      role: 'speaker',
      secretNumber: specialRound.tenBut.secretNumber,
      landingOffset: specialRound.tenBut.landingOffset,
    };
  } else if (specialRound.tenBut) {
    const ownAnswer = specialRound.tenBut.answers.get(playerId);
    base.tenBut = {
      role: specialRound.tenBut.speakerId === playerId ? 'speaker' : 'guesser',
      submittedAnswer: ownAnswer || null,
    };
  }

  return base;
}

function sendPrivateState(room, player) {
  if (player?.socketId) {
    io.to(player.socketId).emit('match:private-state', buildPrivateState(room, player.id));
  }
}

function sendPrivateStates(room) {
  for (const player of room.players.values()) {
    sendPrivateState(room, player);
  }
}

function getHostPlayer(room) {
  return room.players.get(room.hostId);
}

function getActivePlayers(room) {
  return Array.from(room.players.values()).filter((player) => player.active);
}

function getActiveParticipantIds(room, specialRound) {
  return (specialRound?.participantIds || []).filter((playerId) => room.players.get(playerId)?.active);
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

function emitMatchState(room) {
  io.to(room.code).emit('match:state', toMatchState(room));
}

/* ------------------------------------------------------------------ */
/* Ciclo principal: cuenta atras -> ruleta -> minijuego -> marcador     */
/* ------------------------------------------------------------------ */

function getAvailableMinigames(room) {
  const playerCount = getActivePlayers(room).length;
  const enabledIds = room.settings.enabledMinigames || MINIGAME_IDS;
  const enabled = MINIGAMES.filter((minigame) => enabledIds.includes(minigame.id) && minigame.minPlayers <= playerCount);

  return enabled.length ? enabled : MINIGAMES.filter((minigame) => minigame.minPlayers <= playerCount);
}

function chooseMinigame(room, candidates) {
  const previousMinigameId = room.match?.lastMinigameId || '';
  const pool = candidates.length > 1 ? candidates.filter((minigame) => minigame.id !== previousMinigameId) : candidates;
  return randomItem(pool) || candidates[0];
}

function startRoulette(room) {
  if (!room.match) {
    return;
  }

  const options = getAvailableMinigames(room);

  if (!options.length) {
    finishMatch(room);
    return;
  }

  // La seleccion se decide aqui, una sola vez. Los clientes solo animan la tira hasta este ganador.
  const winner = chooseMinigame(room, options);
  const spinStartsAt = Date.now() + ROULETTE_LEAD_MS;

  room.match.roundNumber += 1;
  room.match.phase = 'roulette';
  room.match.specialRound = null;
  room.match.scoreboard = null;
  room.match.scoreboardRequest = null;
  room.match.lastMinigameId = winner.id;
  room.match.roulette = {
    roundNumber: room.match.roundNumber,
    options: options.map(toPublicMinigame),
    winnerId: winner.id,
    winnerIndex: options.indexOf(winner),
    spinStartsAt,
    spinDurationMs: ROULETTE_SPIN_MS,
    landingOffset: randomLandingOffset(),
  };

  setRoomTimer(room, 'phase', spinStartsAt + ROULETTE_SPIN_MS + ROULETTE_REVEAL_MS, () => startSpecialRound(room, winner.id));
  emitMatchState(room);
}

function startSpecialRound(room, minigameId) {
  if (!room.match) {
    return;
  }

  const minigame = MINIGAMES.find((entry) => entry.id === minigameId) || MINIGAMES[0];
  const participantIds = getActivePlayers(room).map((player) => player.id);

  room.match.phase = 'special-round';
  room.match.roulette = null;
  room.match.specialRound = {
    roundNumber: room.match.roundNumber,
    minigameId: minigame.id,
    title: minigame.title,
    description: minigame.description,
    participantIds,
    hasResults: false,
    preparedByHost: false,
    operations: [],
    submissions: new Map(),
    progress: new Map(),
    results: [],
    paintTarget: null,
    paintPhase: minigame.id === 'paint' ? 'preparing' : null,
    paintEndsAt: null,
    paintVoteEndsAt: null,
    paintSubmissions: new Map(),
    paintVotes: new Map(),
    impostor: null,
    tenBut: null,
    pinturillo: null,
    pogo: null,
  };

  if (minigame.id === 'impostor') {
    setupImpostor(room);
  } else if (minigame.id === 'ten-but') {
    setupTenBut(room);
  } else if (minigame.id === 'pinturillo') {
    setupPinturillo(room);
  } else if (minigame.id === 'pogo') {
    setupPogo(room);
  }

  io.to(room.code).emit('match:special-round-started', {
    lobbyId: room.code,
    specialRound: toPublicSpecialRound(room.match.specialRound),
  });
  emitMatchState(room);
  sendPrivateStates(room);
}

function enterMinigameScoreboard(room) {
  const specialRound = room.match?.specialRound;

  if (!room.match || !specialRound || room.match.phase === 'scoreboard') {
    return;
  }

  clearAllRoomTimers(room);
  room.match.phase = 'scoreboard';
  room.match.scoreboard = null;
  room.match.scoreboardRequest = {
    lobbyId: room.code,
    roundNumber: room.match.roundNumber,
    source: 'minigame',
    results: specialRound.results || [],
    previousScores: room.match.lastScoreboard?.scores || [],
  };

  io.to(room.code).emit('match:scoreboard-calculate', room.match.scoreboardRequest);
  emitMatchState(room);
}

function advanceToNextRound(room) {
  if (!room.match) {
    return;
  }

  if (room.match.roundNumber >= room.match.totalRounds) {
    finishMatch(room);
  } else {
    startRoulette(room);
  }
}

function finishMatch(room) {
  clearAllRoomTimers(room);
  room.match.phase = 'finished';
  room.match.roulette = null;
  // Si no se llego a puntuar ninguna ronda (todas saltadas), el podio muestra a todos con 0 puntos.
  room.match.finalStandings = room.match.lastScoreboard?.scores?.length
    ? room.match.lastScoreboard.scores
    : Array.from(room.players.values()).map((player, index) => ({
        playerId: player.id,
        playerName: player.name,
        score: 0,
        position: index + 1,
      }));
  emitMatchState(room);
}

/* ------------------------------------------------------------------ */
/* Minijuegos existentes                                               */
/* ------------------------------------------------------------------ */

function calculateMathMinigameResults(room) {
  const specialRound = room.match?.specialRound;

  if (!specialRound || !Array.isArray(specialRound.operations)) {
    return [];
  }

  return getActivePlayers(room).map((player) => {
    const progress = specialRound.progress?.get(player.id);

    return {
      playerId: player.id,
      playerName: player.name,
      correctCount: progress?.correctCount || 0,
      answeredCount: progress?.answers?.length || 0,
      finishedAt: progress?.finishedAt || null,
      submitted: Boolean(progress?.answers?.length),
    };
  });
}

function startMinigameScoreboardPhase(room) {
  if (!room.match?.specialRound || room.match.phase === 'scoreboard') {
    return;
  }

  room.match.specialRound.results = calculateMathMinigameResults(room);
  enterMinigameScoreboard(room);
}

function startPaintVotingPhase(room) {
  const specialRound = room.match?.specialRound;

  if (!room.match || !specialRound || specialRound.minigameId !== 'paint' || specialRound.paintPhase !== 'drawing') {
    return;
  }

  specialRound.paintPhase = 'voting';
  specialRound.paintVoteEndsAt = Date.now() + PAINT_VOTING_MS;
  setRoomTimer(room, 'paint', specialRound.paintVoteEndsAt + TIMER_GRACE_MS, () => startPaintScoreboardPhase(room));
  io.to(room.code).emit('match:paint-voting-started', {
    lobbyId: room.code,
    specialRound: toPublicSpecialRound(specialRound),
  });
  emitMatchState(room);
}

function calculatePaintResults(room) {
  const specialRound = room.match?.specialRound;

  if (!specialRound) {
    return [];
  }

  const votesByPlayer = new Map();
  for (const targetPlayerId of specialRound.paintVotes?.values() || []) {
    votesByPlayer.set(targetPlayerId, (votesByPlayer.get(targetPlayerId) || 0) + 1);
  }

  return getActivePlayers(room).map((player) => ({
    playerId: player.id,
    playerName: player.name,
    votesReceived: votesByPlayer.get(player.id) || 0,
    correctCount: votesByPlayer.get(player.id) || 0,
    answeredCount: specialRound.paintSubmissions?.has(player.id) ? 1 : 0,
    finishedAt: specialRound.paintSubmissions?.get(player.id)?.submittedAt || null,
    submitted: Boolean(specialRound.paintSubmissions?.has(player.id)),
  }));
}

function startPaintScoreboardPhase(room) {
  const specialRound = room.match?.specialRound;

  if (!room.match || !specialRound || specialRound.minigameId !== 'paint' || room.match.phase === 'scoreboard') {
    return;
  }

  specialRound.results = calculatePaintResults(room);
  specialRound.paintPhase = 'finished';

  io.to(room.code).emit('match:paint-results-ready', {
    lobbyId: room.code,
    specialRound: toPublicSpecialRound(specialRound),
  });
  enterMinigameScoreboard(room);
}

/* ------------------------------------------------------------------ */
/* El Impostor                                                         */
/* ------------------------------------------------------------------ */

function setupImpostor(room) {
  const specialRound = room.match.specialRound;

  specialRound.impostor = {
    impostorId: randomItem(specialRound.participantIds),
    wordEntry: randomItem(IMPOSTOR_WORDS),
    stage: 'turns',
    wordRound: 0,
    turnOrder: [],
    turnIndex: 0,
    completedTurnIds: [],
    votes: new Map(),
    voteEndsAt: null,
    stageStartedAt: Date.now(),
    lastRoundResult: null,
    outcome: null,
  };

  startImpostorWordRound(room, 1, false);
}

function startImpostorWordRound(room, wordRound, emit = true) {
  const impostor = room.match?.specialRound?.impostor;

  if (!impostor) {
    return;
  }

  const participantIds = room.match.specialRound.participantIds.filter((playerId) => room.players.has(playerId));
  impostor.wordRound = wordRound;
  impostor.stage = 'turns';
  impostor.turnOrder = shuffle(participantIds);
  impostor.turnIndex = 0;
  impostor.completedTurnIds = [];
  impostor.votes = new Map();
  impostor.voteEndsAt = null;
  impostor.stageStartedAt = Date.now();

  if (emit) {
    emitMatchState(room);
  }
}

function startImpostorVoting(room) {
  const impostor = room.match?.specialRound?.impostor;

  if (!impostor || impostor.stage !== 'turns') {
    return;
  }

  impostor.stage = 'voting';
  impostor.votes = new Map();
  impostor.voteEndsAt = Date.now() + IMPOSTOR_VOTE_MS;
  impostor.stageStartedAt = Date.now();
  setRoomTimer(room, 'impostor', impostor.voteEndsAt + 300, () => resolveImpostorVote(room));
  emitMatchState(room);
}

function maybeResolveImpostorVote(room) {
  const specialRound = room.match?.specialRound;
  const impostor = specialRound?.impostor;

  if (!impostor || impostor.stage !== 'voting') {
    return;
  }

  const expectedVoterIds = getActiveParticipantIds(room, specialRound);

  if (expectedVoterIds.every((playerId) => impostor.votes.has(playerId))) {
    resolveImpostorVote(room);
  }
}

function resolveImpostorVote(room) {
  const impostor = room.match?.specialRound?.impostor;

  if (!impostor || impostor.stage !== 'voting') {
    return;
  }

  clearRoomTimer(room, 'impostor');
  const isLastRound = impostor.wordRound >= IMPOSTOR_MAX_ROUNDS;
  const tally = new Map();
  let skipCount = 0;

  for (const targetId of impostor.votes.values()) {
    if (targetId === 'skip') {
      skipCount += 1;
    } else {
      tally.set(targetId, (tally.get(targetId) || 0) + 1);
    }
  }

  const ranking = Array.from(tally.entries()).sort((first, second) => second[1] - first[1]);
  const [top, second] = ranking;
  let ejectedId = null;
  let reason = 'ejected';

  if (!top) {
    reason = skipCount ? 'skip' : 'no-votes';
  } else if (second && second[1] === top[1]) {
    reason = 'tie';
  } else if (!isLastRound && skipCount >= top[1]) {
    reason = 'skip';
  } else {
    ejectedId = top[0];
  }

  const roundResult = {
    wordRound: impostor.wordRound,
    reason,
    ejectedId,
    skipCount,
    tally: ranking.map(([playerId, votes]) => ({ playerId, votes })),
    votes: Array.from(impostor.votes.entries()).map(([voterId, targetId]) => ({ voterId, targetId })),
  };
  impostor.lastRoundResult = roundResult;

  if (ejectedId || isLastRound) {
    finishImpostor(room, roundResult);
    return;
  }

  impostor.stage = 'no-ejection';
  impostor.stageStartedAt = Date.now();
  setRoomTimer(room, 'impostor', Date.now() + IMPOSTOR_NO_EJECTION_MS, () =>
    startImpostorWordRound(room, impostor.wordRound + 1),
  );
  emitMatchState(room);
}

function finishImpostor(room, roundResult, abandoned = false) {
  const specialRound = room.match?.specialRound;
  const impostor = specialRound?.impostor;

  if (!impostor || impostor.outcome) {
    return;
  }

  clearRoomTimer(room, 'impostor');
  const winner = abandoned ? 'innocents' : roundResult?.ejectedId === impostor.impostorId ? 'innocents' : 'impostor';
  const roundsPlayed = Math.max(1, impostor.wordRound);
  const extraRounds = roundsPlayed - 1;
  const impostorPoints = winner === 'impostor' ? 20 + 10 * extraRounds : 0;
  const impostorPlayer = room.players.get(impostor.impostorId);

  impostor.stage = 'reveal';
  impostor.stageStartedAt = Date.now();
  impostor.outcome = {
    winner,
    abandoned,
    reason: roundResult?.reason || 'abandoned',
    ejectedId: roundResult?.ejectedId || null,
    ejectedWasImpostor: Boolean(roundResult?.ejectedId && roundResult.ejectedId === impostor.impostorId),
    impostorId: impostor.impostorId,
    impostorName: impostorPlayer?.name || 'Jugador desconectado',
    word: impostor.wordEntry.word,
    category: impostor.wordEntry.category,
    roundsPlayed,
    extraRounds,
    impostorPoints,
    tally: roundResult?.tally || [],
    skipCount: roundResult?.skipCount || 0,
    votes: roundResult?.votes || [],
  };

  // La puntuacion se fija una unica vez aqui; el marcador global solo la suma.
  specialRound.results = specialRound.participantIds.map((playerId) => ({
    playerId,
    playerName: room.players.get(playerId)?.name || '',
    points: playerId === impostor.impostorId ? impostorPoints : 0,
    correctCount: 0,
    answeredCount: 0,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

/* ------------------------------------------------------------------ */
/* Es un 10, pero...                                                   */
/* ------------------------------------------------------------------ */

function setupTenBut(room) {
  const specialRound = room.match.specialRound;
  const spinDeadline = Date.now() + TEN_BUT_AUTO_SPIN_MS;

  specialRound.tenBut = {
    stage: 'waiting-spin',
    speakerId: randomItem(specialRound.participantIds),
    secretNumber: null,
    landingOffset: randomLandingOffset(),
    spinDeadline,
    spinStartsAt: null,
    spinDurationMs: TEN_BUT_SPIN_MS,
    answers: new Map(),
    answerEndsAt: null,
    outcome: null,
  };

  // Si el portavoz no gira (desconexion o despiste), la ruleta gira sola para no bloquear la partida.
  setRoomTimer(room, 'ten-but', spinDeadline, () => startTenButSpin(room));
}

function startTenButSpin(room) {
  const tenBut = room.match?.specialRound?.tenBut;

  if (!tenBut || tenBut.stage !== 'waiting-spin') {
    return;
  }

  // El numero se decide antes de animar: la ruleta del portavoz frena exactamente sobre el.
  tenBut.secretNumber = 1 + Math.floor(Math.random() * 10);
  tenBut.stage = 'spinning';
  tenBut.spinDeadline = null;
  tenBut.spinStartsAt = Date.now() + 400;
  setRoomTimer(room, 'ten-but', tenBut.spinStartsAt + tenBut.spinDurationMs + TEN_BUT_REVEAL_MS, () =>
    startTenButAnswering(room),
  );
  sendPrivateState(room, room.players.get(tenBut.speakerId));
  emitMatchState(room);
}

function startTenButAnswering(room) {
  const tenBut = room.match?.specialRound?.tenBut;

  if (!tenBut || tenBut.stage !== 'spinning') {
    return;
  }

  tenBut.stage = 'answering';
  tenBut.answerEndsAt = Date.now() + TEN_BUT_ANSWER_MS;
  setRoomTimer(room, 'ten-but', tenBut.answerEndsAt + 300, () => resolveTenBut(room));
  emitMatchState(room);
}

function maybeResolveTenBut(room) {
  const specialRound = room.match?.specialRound;
  const tenBut = specialRound?.tenBut;

  if (!tenBut || tenBut.stage !== 'answering') {
    return;
  }

  const expectedIds = getActiveParticipantIds(room, specialRound).filter((playerId) => playerId !== tenBut.speakerId);

  if (expectedIds.every((playerId) => tenBut.answers.has(playerId))) {
    resolveTenBut(room);
  }
}

function getTenButPointsForDiff(diff) {
  if (diff === 0) {
    return 10;
  }

  return diff === 1 ? 5 : 0;
}

function resolveTenBut(room) {
  const specialRound = room.match?.specialRound;
  const tenBut = specialRound?.tenBut;

  if (!tenBut || tenBut.stage !== 'answering') {
    return;
  }

  clearRoomTimer(room, 'ten-but');
  const guesserIds = specialRound.participantIds.filter((playerId) => playerId !== tenBut.speakerId);
  const answers = guesserIds.map((playerId) => {
    const number = tenBut.answers.get(playerId) || null;
    const diff = number ? Math.abs(number - tenBut.secretNumber) : null;

    return {
      playerId,
      playerName: room.players.get(playerId)?.name || '',
      number,
      diff,
      points: diff === null ? 0 : getTenButPointsForDiff(diff),
      valid: diff !== null && diff <= 1,
    };
  });
  const validCount = answers.filter((answer) => answer.valid).length;
  // Las respuestas no enviadas tampoco son validas: el portavoz no consiguio que esa persona acertara.
  const invalidCount = answers.length - validCount;
  const penaltyCap = specialRound.participantIds.length > 3 ? 10 : 5;
  const speakerPositive = Math.min(15, 5 * validCount);
  const speakerPenalty = validCount === 0 ? penaltyCap : Math.min(penaltyCap, 5 * invalidCount);
  const speakerTotal = speakerPositive - speakerPenalty;

  tenBut.stage = 'results';
  tenBut.answerEndsAt = null;
  tenBut.outcome = {
    secretNumber: tenBut.secretNumber,
    speakerId: tenBut.speakerId,
    speakerName: room.players.get(tenBut.speakerId)?.name || '',
    answers,
    validCount,
    invalidCount,
    penaltyCap,
    speakerPositive,
    speakerPenalty,
    speakerTotal,
  };

  specialRound.results = specialRound.participantIds.map((playerId) => ({
    playerId,
    playerName: room.players.get(playerId)?.name || '',
    points: playerId === tenBut.speakerId ? speakerTotal : answers.find((answer) => answer.playerId === playerId)?.points || 0,
    correctCount: 0,
    answeredCount: 0,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

/* ------------------------------------------------------------------ */
/* Puntuacion por orden de llegada (Pinturillo y Pogo)                 */
/* ------------------------------------------------------------------ */

// Reparte de 30 hacia abajo en multiplos de 5 entre `scoringSlots` puestos: 2 -> 30/15, 3 -> 30/20/10, 4 -> 30/25/15/10.
function rankLadderPoints(position, scoringSlots, maxPoints = 30) {
  if (position < 0 || position >= scoringSlots) {
    return 0;
  }

  if (scoringSlots <= 1) {
    return maxPoints;
  }

  return Math.max(5, Math.round((maxPoints * (1 - position / scoringSlots)) / 5) * 5);
}

/* ------------------------------------------------------------------ */
/* Pinturillo                                                          */
/* ------------------------------------------------------------------ */

const PINTURILLO_CATEGORIES = new Set([
  'Animales domésticos',
  'Animales salvajes',
  'Animales marinos',
  'Animales de granja',
  'Insectos y bichos',
  'Aves',
  'Frutas',
  'Verduras y hortalizas',
  'Comida internacional',
  'Dulces y postres',
  'Objetos de cocina',
  'Objetos del baño',
  'Objetos de casa',
  'Material escolar',
  'Herramientas',
  'Ropa',
  'Calzado y complementos',
  'Profesiones',
  'Deportes',
  'Objetos deportivos',
  'Transporte',
  'Instrumentos musicales',
  'Naturaleza y clima',
  'Espacio y astronomía',
  'Fantasía y mitología',
  'Partes del cuerpo',
  'Juguetes',
  'Lugares cotidianos',
]);
// Reutiliza el banco de El Impostor, quedandose con categorias dibujables y palabras de longitud razonable.
// Solo palabras sueltas (sin espacios, guiones ni simbolos) para que adivinar sea mas llevadero.
const PINTURILLO_WORDS = IMPOSTOR_WORDS.filter(
  (entry) => PINTURILLO_CATEGORIES.has(entry.category) && /^\p{L}{3,14}$/u.test(entry.word),
);

function normalizeGuess(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLetter(character) {
  return /[a-z0-9]/i.test(normalizeGuess(character));
}

function isCloseGuess(guess, target) {
  if (target.length < 4 || Math.abs(guess.length - target.length) > 1) {
    return false;
  }

  // Distancia de Levenshtein <= 1 ("casi").
  const previous = Array.from({ length: target.length + 1 }, (_unused, index) => index);

  for (let row = 1; row <= guess.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;

    for (let column = 1; column <= target.length; column += 1) {
      const temp = previous[column];
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (guess[row - 1] === target[column - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }

  return previous[target.length] <= 1;
}

function setupPinturillo(room) {
  const specialRound = room.match.specialRound;
  const entry = randomItem(PINTURILLO_WORDS);
  const startsAt = Date.now() + MINIGAME_INTRO_MS;
  const letterIndexes = [...entry.word].map((character, index) => (isLetter(character) ? index : -1)).filter((index) => index >= 0);
  // Como maximo se descubre la mitad de las letras: 4 -> 2, 6 -> 3, 10 -> 5.
  const maxReveals = Math.floor(letterIndexes.length / 2);

  specialRound.pinturillo = {
    stage: 'drawing',
    drawerId: randomItem(specialRound.participantIds),
    word: entry.word,
    normalizedWord: normalizeGuess(entry.word),
    category: entry.category,
    startsAt,
    endsAt: startsAt + PINTURILLO_DRAW_MS,
    revealOrder: shuffle(letterIndexes).slice(0, maxReveals),
    revealedIndexes: [],
    guesses: [],
    chat: [],
    lastFrame: null,
    lastFrameAt: 0,
    lastMessageAt: new Map(),
    outcome: null,
  };

  // Pistas repartidas entre el 25 % y el 90 % del tiempo.
  specialRound.pinturillo.revealOrder.forEach((letterIndex, order) => {
    const fireAt = startsAt + PINTURILLO_DRAW_MS * (0.25 + (0.65 * order) / Math.max(1, maxReveals));
    setRoomTimer(room, `pinturillo-hint-${order}`, fireAt, () => revealPinturilloLetter(room, letterIndex));
  });
  setRoomTimer(room, 'pinturillo', specialRound.pinturillo.endsAt + 300, () => resolvePinturillo(room));
}

function revealPinturilloLetter(room, letterIndex) {
  const pinturillo = room.match?.specialRound?.pinturillo;

  if (!pinturillo || pinturillo.stage !== 'drawing' || pinturillo.revealedIndexes.includes(letterIndex)) {
    return;
  }

  pinturillo.revealedIndexes.push(letterIndex);
  emitMatchState(room);
}

function buildPinturilloHint(pinturillo) {
  const revealAll = pinturillo.stage !== 'drawing';

  return [...pinturillo.word].map((character, index) => {
    if (!isLetter(character)) {
      return character;
    }

    return revealAll || pinturillo.revealedIndexes.includes(index) ? character.toUpperCase() : '';
  });
}

function pushPinturilloMessage(room, message) {
  const pinturillo = room.match.specialRound.pinturillo;
  const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), ...message };
  pinturillo.chat.push(entry);
  pinturillo.chat = pinturillo.chat.slice(-PINTURILLO_CHAT_HISTORY);
  io.to(room.code).emit('match:pinturillo-chat', { lobbyId: room.code, message: entry });
}

function getPinturilloGuesserIds(room) {
  const specialRound = room.match.specialRound;
  return specialRound.participantIds.filter((playerId) => playerId !== specialRound.pinturillo.drawerId);
}

function maybeFinishPinturillo(room) {
  const pinturillo = room.match?.specialRound?.pinturillo;

  if (!pinturillo || pinturillo.stage !== 'drawing') {
    return;
  }

  if (!room.players.has(pinturillo.drawerId)) {
    resolvePinturillo(room, true);
    return;
  }

  const guesserIds = getPinturilloGuesserIds(room);
  const guessedIds = new Set(pinturillo.guesses.map((guess) => guess.playerId));
  const pendingActive = guesserIds.filter((playerId) => !guessedIds.has(playerId) && room.players.get(playerId)?.active);
  // Cuando solo queda una persona por acertar termina la ronda (con un unico adivino, cuando acierta).
  const allowedPending = guesserIds.length >= 2 ? 1 : 0;

  if (pendingActive.length <= allowedPending) {
    resolvePinturillo(room);
  }
}

function resolvePinturillo(room, drawerLeft = false) {
  const specialRound = room.match?.specialRound;
  const pinturillo = specialRound?.pinturillo;

  if (!pinturillo || pinturillo.stage !== 'drawing') {
    return;
  }

  for (const key of [...(room.timers?.keys() || [])]) {
    if (key.startsWith('pinturillo')) {
      clearRoomTimer(room, key);
    }
  }

  const guesserIds = getPinturilloGuesserIds(room);
  const scoringSlots = Math.max(1, guesserIds.length - 1);
  const correctCount = pinturillo.guesses.length;
  const penaltyCap = specialRound.participantIds.length <= 2 ? 5 : 10;
  let drawerPoints = 0;

  if (!drawerLeft) {
    drawerPoints = correctCount
      ? Math.min(30, Math.max(5, Math.round((30 * Math.min(correctCount, scoringSlots)) / scoringSlots / 5) * 5))
      : -penaltyCap;
  }

  pinturillo.stage = 'results';
  pinturillo.outcome = {
    word: pinturillo.word,
    category: pinturillo.category,
    drawerId: pinturillo.drawerId,
    drawerName: room.players.get(pinturillo.drawerId)?.name || 'Jugador desconectado',
    drawerLeft,
    guesses: pinturillo.guesses,
    correctCount,
    guesserCount: guesserIds.length,
    drawerPoints,
    penaltyCap,
    finalFrame: pinturillo.lastFrame,
  };

  const pointsByPlayer = new Map(pinturillo.guesses.map((guess) => [guess.playerId, guess.points]));
  pointsByPlayer.set(pinturillo.drawerId, drawerPoints);
  specialRound.results = specialRound.participantIds.map((playerId) => ({
    playerId,
    playerName: room.players.get(playerId)?.name || '',
    points: pointsByPlayer.get(playerId) || 0,
    correctCount: 0,
    answeredCount: 0,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  pushPinturilloMessage(room, { kind: 'system', text: `La palabra era «${pinturillo.word}».` });
  emitMatchState(room);
}

function toPublicPinturillo(pinturillo) {
  if (!pinturillo) {
    return null;
  }

  return {
    stage: pinturillo.stage,
    drawerId: pinturillo.drawerId,
    startsAt: pinturillo.startsAt,
    endsAt: pinturillo.endsAt,
    hint: buildPinturilloHint(pinturillo),
    guessedPlayerIds: pinturillo.guesses.map((guess) => guess.playerId),
    chat: pinturillo.chat,
    outcome: pinturillo.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Carrera en pogo                                                     */
/* ------------------------------------------------------------------ */

function setupPogo(room) {
  const specialRound = room.match.specialRound;
  const raceStartsAt = Date.now() + MINIGAME_INTRO_MS + POGO_COUNTDOWN_MS;

  specialRound.pogo = {
    stage: 'racing',
    goal: POGO_GOAL,
    raceStartsAt,
    raceEndsAt: raceStartsAt + POGO_RACE_MS,
    racers: new Map(
      specialRound.participantIds.map((playerId) => [
        playerId,
        { playerId, progress: 0, jumps: 0, perfects: 0, misses: 0, lastJumpAt: 0, finishedAt: null },
      ]),
    ),
    outcome: null,
  };

  setRoomTimer(room, 'pogo', specialRound.pogo.raceEndsAt + 300, () => resolvePogo(room));
}

function toPublicPogoRacers(pogo) {
  return Array.from(pogo.racers.values()).map((racer) => ({
    playerId: racer.playerId,
    progress: racer.progress,
    jumps: racer.jumps,
    perfects: racer.perfects,
    misses: racer.misses,
    finishedAt: racer.finishedAt,
  }));
}

function toPublicPogo(pogo) {
  if (!pogo) {
    return null;
  }

  return {
    stage: pogo.stage,
    goal: pogo.goal,
    raceStartsAt: pogo.raceStartsAt,
    raceEndsAt: pogo.raceEndsAt,
    racers: toPublicPogoRacers(pogo),
    outcome: pogo.outcome,
  };
}

function maybeFinishPogo(room) {
  const specialRound = room.match?.specialRound;
  const pogo = specialRound?.pogo;

  if (!pogo || pogo.stage !== 'racing') {
    return;
  }

  const activeIds = getActiveParticipantIds(room, specialRound);

  if (activeIds.length && activeIds.every((playerId) => pogo.racers.get(playerId)?.finishedAt)) {
    resolvePogo(room);
  }
}

function resolvePogo(room) {
  const specialRound = room.match?.specialRound;
  const pogo = specialRound?.pogo;

  if (!pogo || pogo.stage !== 'racing') {
    return;
  }

  clearRoomTimer(room, 'pogo');
  // Primero quien cruzo la meta (por orden de llegada); despues, por distancia recorrida.
  const ranking = Array.from(pogo.racers.values()).sort((first, second) => {
    if (first.finishedAt && second.finishedAt) return first.finishedAt - second.finishedAt;
    if (first.finishedAt) return -1;
    if (second.finishedAt) return 1;
    if (second.progress !== first.progress) return second.progress - first.progress;
    return (first.lastJumpAt || Infinity) - (second.lastJumpAt || Infinity);
  });
  const scoringSlots = Math.max(1, ranking.length - 1);

  pogo.stage = 'results';
  pogo.outcome = {
    ranking: ranking.map((racer, index) => ({
      playerId: racer.playerId,
      playerName: room.players.get(racer.playerId)?.name || '',
      position: index + 1,
      progress: racer.progress,
      finished: Boolean(racer.finishedAt),
      timeMs: racer.finishedAt ? racer.finishedAt - pogo.raceStartsAt : null,
      jumps: racer.jumps,
      perfects: racer.perfects,
      points: rankLadderPoints(index, scoringSlots),
    })),
  };
  specialRound.results = pogo.outcome.ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: 0,
    answeredCount: 0,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

// Revisa si una desconexion o salida desbloquea (o invalida) la fase actual de un minijuego.
function reevaluateActiveMinigame(room) {
  const specialRound = room.match?.specialRound;

  if (!specialRound || room.match.phase !== 'special-round' || room.match.hostPaused) {
    return;
  }

  const impostor = specialRound.impostor;

  if (impostor && !impostor.outcome && !room.players.has(impostor.impostorId)) {
    finishImpostor(room, null, true);
    return;
  }

  maybeResolveImpostorVote(room);
  maybeResolveTenBut(room);
  maybeFinishPinturillo(room);
  maybeFinishPogo(room);
}

/* ------------------------------------------------------------------ */
/* Pausa del host                                                      */
/* ------------------------------------------------------------------ */

function startHostPause(room) {
  if (!room.match || room.match.hostPaused) {
    return;
  }

  room.match.hostPaused = true;
  room.match.hostPauseStartedAt = Date.now();
  room.match.hostPauseDeadline = room.match.hostPauseStartedAt + HOST_RECONNECT_WAIT_MS;
  pauseRoomTimers(room);

  io.to(room.code).emit('match:host-paused', {
    lobbyId: room.code,
    deadline: room.match.hostPauseDeadline,
  });
}

function resumeHostPause(room) {
  if (!room.match?.hostPaused) {
    return;
  }

  const pausedDuration = room.match.hostPauseStartedAt ? Date.now() - room.match.hostPauseStartedAt : 0;
  room.match.hostPaused = false;
  room.match.hostPauseStartedAt = null;
  room.match.hostPauseDeadline = null;
  shiftMatchDeadlines(room, pausedDuration);
  resumeRoomTimers(room, pausedDuration);

  io.to(room.code).emit('match:host-resumed', { lobbyId: room.code });
  emitMatchState(room);
  reevaluateActiveMinigame(room);
}

function closeMatchRoom(room, reason) {
  clearAllRoomTimers(room);
  io.to(room.code).emit('match:closed', { lobbyId: room.code, reason });
  io.to(room.code).emit('room:closed', { code: room.code, reason });
  gameState.rooms.delete(room.code);
}

function upsertPlayer(room, socket, playerId, playerName, playerSecret, avatarUrl = '') {
  const now = Date.now();
  const existingPlayer = room.players.get(playerId);

  if (existingPlayer) {
    existingPlayer.name = playerName;
    existingPlayer.avatarUrl = avatarUrl;
    existingPlayer.socketId = socket.id;
    existingPlayer.lastSeen = now;
    existingPlayer.missedPresenceChecks = 0;
    existingPlayer.inLobby = true;
    existingPlayer.active = true;
    existingPlayer.secret = existingPlayer.secret || playerSecret;
    return existingPlayer;
  }

  const player = {
    id: playerId,
    socketId: socket.id,
    secret: playerSecret,
    name: playerName,
    avatarUrl,
    color: assignPlayerColor(room),
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

function removePlayerFromRoom(room, playerId) {
  room.players.delete(playerId);
  broadcastLobby(room);

  if (room.match) {
    reevaluateActiveMinigame(room);
    emitMatchState(room);
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

/* ------------------------------------------------------------------ */
/* Proxy de fotos de perfil                                            */
/* ------------------------------------------------------------------ */
// Los personajes 3D usan la foto como textura WebGL, y eso exige cabeceras CORS que casi ninguna web da.
// El proxy solo sirve imagenes publicas: bloquea direcciones privadas/locales (SSRF) en cada redireccion.

const AVATAR_PROXY_MAX_BYTES = 3 * 1024 * 1024;
const AVATAR_PROXY_TIMEOUT_MS = 6000;

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  const normalized = address.toLowerCase();

  if (normalized.startsWith('::ffff:')) {
    return isPrivateAddress(normalized.slice(7));
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  );
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });

  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('host-not-allowed');
  }
}

async function readLimitedBody(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.length;

    if (total > AVATAR_PROXY_MAX_BYTES) {
      await reader.cancel();
      throw new Error('too-large');
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

app.get('/avatar-proxy', async (req, res) => {
  let current;

  try {
    current = new URL(String(req.query.url || ''));
  } catch {
    res.status(400).json({ error: 'URL no valida.' });
    return;
  }

  try {
    let response;

    for (let hop = 0; hop < 4; hop += 1) {
      if (!['http:', 'https:'].includes(current.protocol)) {
        throw new Error('protocol-not-allowed');
      }

      await assertPublicHost(current.hostname);
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(AVATAR_PROXY_TIMEOUT_MS),
        headers: { accept: 'image/*', 'user-agent': 'MinijuegosOnline-avatar-proxy/1.0' },
      });

      const location = response.headers.get('location');

      if (response.status >= 300 && response.status < 400 && location) {
        current = new URL(location, current);
        response = null;
        continue;
      }

      break;
    }

    const contentType = response?.headers.get('content-type') || '';

    if (!response?.ok || !contentType.startsWith('image/')) {
      res.status(502).json({ error: 'La URL no devuelve una imagen.' });
      return;
    }

    if (Number(response.headers.get('content-length') || 0) > AVATAR_PROXY_MAX_BYTES) {
      res.status(413).json({ error: 'Imagen demasiado grande.' });
      return;
    }

    const body = await readLimitedBody(response);
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(body);
  } catch (error) {
    res.status(error.message === 'too-large' ? 413 : 502).json({ error: 'No se pudo obtener la imagen.' });
  }
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
    message: 'Socket conectado. Listo para jugar.',
    minigames: MINIGAMES.map(toPublicMinigame),
  });

  socket.on('room:create', (payload = {}, callback) => {
    const playerName = String(payload.playerName || '').trim();
    const playerId = String(payload.playerId || '').trim();

    if (!playerName) {
      callback?.({ ok: false, reason: 'El nombre de usuario es obligatorio.' });
      return;
    }

    if (!sanitizeAvatarUrl(payload.avatarUrl)) {
      callback?.({ ok: false, reason: 'La foto de perfil es obligatoria (URL de una imagen).' });
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
      settings: normalizeRoomSettings(payload.settings || {}),
      players: new Map(),
      bannedPlayerIds: new Set(),
      timers: new Map(),
      createdAt: new Date().toISOString(),
    };

    upsertPlayer(room, socket, playerId, playerName, String(payload.playerSecret || ''), sanitizeAvatarUrl(payload.avatarUrl));
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

    if (!sanitizeAvatarUrl(payload.avatarUrl)) {
      callback?.({ ok: false, reason: 'La foto de perfil es obligatoria (URL de una imagen).' });
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

    const existingPlayer = room.players.get(playerId);

    if (existingPlayer && !isAuthorizedPlayer(existingPlayer, payload)) {
      callback?.({ ok: false, reason: 'Ese jugador ya esta en la sala desde otro dispositivo.' });
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

    const player = upsertPlayer(room, socket, playerId, playerName, String(payload.playerSecret || ''), sanitizeAvatarUrl(payload.avatarUrl));
    socket.join(code);

    if (isHostRejoining && room.match?.hostPaused) {
      resumeHostPause(room);
    }

    broadcastLobby(room);

    if (room.match) {
      socket.emit('match:started', toMatchState(room));
      sendPrivateState(room, player);
      emitMatchState(room);
    }

    callback?.({
      ok: true,
      lobby: toLobby(room),
      match: toMatchState(room),
    });
  });

  socket.on('room:heartbeat', (payload = {}) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);

    if (!room || !player) {
      return;
    }

    const wasInactive = !player.active;
    const socketChanged = player.socketId !== socket.id;
    player.socketId = socket.id;
    player.lastSeen = Date.now();
    player.missedPresenceChecks = 0;
    player.active = true;
    socket.join(room.code);

    if (room.match && (wasInactive || socketChanged)) {
      if (player.id === room.hostId && room.match.hostPaused) {
        resumeHostPause(room);
      }

      sendPrivateState(room, player);
    }

    if (wasInactive) {
      broadcastLobby(room);

      if (room.match) {
        emitMatchState(room);
      }
    }
  });

  socket.on('room:presence-response', (payload = {}) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);

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
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);

    if (!room || !player) {
      callback?.({ ok: false, reason: 'No estas en este lobby.' });
      return;
    }

    if (player.id === room.hostId) {
      callback?.({ ok: false, reason: 'El host no necesita marcarse como listo.' });
      return;
    }

    player.ready = Boolean(payload.ready);
    broadcastLobby(room);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('room:update-settings', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);

    if (!room) {
      callback?.({ ok: false, reason: 'No existe una sala con ese codigo.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede editar la configuracion.' });
      return;
    }

    room.settings = normalizeRoomSettings(payload.settings || room.settings);
    broadcastLobby(room);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('room:leave', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);

    if (!room || !player) {
      callback?.({ ok: true });
      return;
    }

    if (player.id === room.hostId) {
      closeMatchRoom(room, 'El host ha cerrado el lobby.');
      callback?.({ ok: true });
      return;
    }

    socket.leave(room.code);
    removePlayerFromRoom(room, player.id);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('room:kick-player', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const targetPlayerId = String(payload.targetPlayerId || '').trim();

    if (!room) {
      callback?.({ ok: false, reason: 'No existe una sala con ese codigo.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
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

    io.to(targetPlayer.socketId).emit('room:kicked', { code: room.code });
    removePlayerFromRoom(room, targetPlayerId);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('match:start', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);

    if (!room) {
      callback?.({ ok: false, reason: 'No existe una sala con ese codigo.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede iniciar la partida.' });
      return;
    }

    if (room.match) {
      callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
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

    clearAllRoomTimers(room);
    room.match = {
      phase: 'countdown',
      roundNumber: 0,
      totalRounds: room.settings.rounds,
      hostPaused: false,
      hostPauseStartedAt: null,
      hostPauseDeadline: null,
      startedAt: Date.now(),
      countdownEndsAt: Date.now() + COUNTDOWN_MS,
      roulette: null,
      specialRound: null,
      scoreboard: null,
      scoreboardRequest: null,
      lastScoreboard: null,
      finalStandings: null,
      lastMinigameId: '',
    };

    setRoomTimer(room, 'phase', room.match.countdownEndsAt, () => startRoulette(room));
    const matchState = toMatchState(room);
    io.to(room.code).emit('match:started', matchState);
    callback?.({ ok: true, lobby: toLobby(room), match: matchState });
  });

  socket.on('match:request-private-state', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);

    if (!room?.match || !player) {
      callback?.({ ok: false, reason: 'No hay una partida activa.' });
      return;
    }

    player.socketId = socket.id;
    callback?.({ ok: true, privateState: buildPrivateState(room, player.id) });
  });

  socket.on('match:scoreboard-updated', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const scores = Array.isArray(payload.scores) ? payload.scores : [];

    if (!room || !room.match || room.match.phase !== 'scoreboard') {
      callback?.({ ok: false, reason: 'No hay un scoreboard activo.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede sincronizar el scoreboard.' });
      return;
    }

    room.match.scoreboard = {
      lobbyId: room.code,
      roundNumber: room.match.roundNumber,
      previousScores: room.match.lastScoreboard?.scores || [],
      scores: scores
        .map((scoreEntry) => ({
          playerId: String(scoreEntry.playerId || ''),
          playerName: String(scoreEntry.playerName || ''),
          score: Number(scoreEntry.score || 0),
          roundPoints: Number(scoreEntry.roundPoints || 0),
          position: Number(scoreEntry.position || 0),
          minigameCorrectCount:
            scoreEntry.minigameCorrectCount === undefined ? undefined : Number(scoreEntry.minigameCorrectCount || 0),
          minigameAnsweredCount:
            scoreEntry.minigameAnsweredCount === undefined ? undefined : Number(scoreEntry.minigameAnsweredCount || 0),
          minigameVoteCount:
            scoreEntry.minigameVoteCount === undefined ? undefined : Number(scoreEntry.minigameVoteCount || 0),
        }))
        .filter((scoreEntry) => scoreEntry.playerId && scoreEntry.playerName && scoreEntry.position > 0),
    };
    room.match.scoreboardRequest = null;

    io.to(room.code).emit('match:scoreboard-sync', {
      lobbyId: room.code,
      scoreboard: room.match.scoreboard,
    });
    emitMatchState(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:scoreboard-continue', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);

    if (!room || !room.match || room.match.phase !== 'scoreboard' || !room.match.scoreboard) {
      callback?.({ ok: false, reason: 'No hay un scoreboard activo.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede continuar a la siguiente ronda.' });
      return;
    }

    room.match.lastScoreboard = room.match.scoreboard;
    advanceToNextRound(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:special-round-continue', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);

    if (!room || !room.match || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay un minijuego activo.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede abrir el marcador.' });
      return;
    }

    // Solo se avanza al marcador cuando el minijuego ya tiene resultados (ya no se pueden saltar minijuegos).
    if (!room.match.specialRound?.hasResults) {
      callback?.({ ok: false, reason: 'El minijuego todavia no ha terminado.' });
      return;
    }

    enterMinigameScoreboard(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:return-to-lobby', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);

    if (!room || !room.match) {
      callback?.({ ok: false, reason: 'No hay una partida activa.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede volver al lobby.' });
      return;
    }

    clearAllRoomTimers(room);
    room.match = null;

    for (const player of room.players.values()) {
      player.ready = false;
    }

    io.to(room.code).emit('match:returned-to-lobby', { lobbyId: room.code, lobby: toLobby(room) });
    broadcastLobby(room);
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('match:minigame-prepared', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const specialRound = room?.match?.specialRound;
    const operations = Array.isArray(payload.operations) ? payload.operations : [];

    if (!room || !room.match || room.match.phase !== 'special-round' || specialRound?.minigameId !== 'math-operations') {
      callback?.({ ok: false, reason: 'No hay un minijuego activo.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede preparar el minijuego.' });
      return;
    }

    if (specialRound.preparedByHost) {
      callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
      return;
    }

    const sanitizedOperations = operations
      .map((operation, index) => ({
        id: String(operation.id || `operation-${index + 1}`),
        prompt: String(operation.prompt || '').trim(),
        answer: Number(operation.answer),
      }))
      .filter((operation) => operation.id && operation.prompt && Number.isFinite(operation.answer))
      .slice(0, 7);

    if (sanitizedOperations.length < 5) {
      callback?.({ ok: false, reason: 'El minijuego necesita entre 5 y 7 operaciones validas.' });
      return;
    }

    specialRound.preparedByHost = true;
    specialRound.operations = sanitizedOperations;
    specialRound.submissions = new Map();
    specialRound.progress = new Map();
    specialRound.results = [];

    io.to(room.code).emit('match:minigame-prepared', {
      lobbyId: room.code,
      specialRound: toPublicSpecialRound(specialRound),
    });
    emitMatchState(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:minigame-answer', (payload = {}, callback) => {
    const answeredCount = Math.max(0, Number(payload.answeredCount || 0));
    const correctCount = Math.max(0, Number(payload.correctCount || 0));
    const completed = Boolean(payload.completed);
    const finishedAt = payload.finishedAt ? Number(payload.finishedAt) : null;
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const specialRound = room?.match?.specialRound;

    if (!room || !player || !room.match || room.match.phase !== 'special-round' || !specialRound) {
      callback?.({ ok: false, reason: 'No hay un minijuego activo.' });
      return;
    }

    if (!specialRound.preparedByHost || !Array.isArray(specialRound.operations) || !specialRound.operations.length) {
      callback?.({ ok: false, reason: 'El minijuego todavia se esta preparando.' });
      return;
    }

    if (!Number.isFinite(answeredCount) || !Number.isFinite(correctCount)) {
      callback?.({ ok: false, reason: 'Progreso de minijuego no valido.' });
      return;
    }

    specialRound.progress = specialRound.progress || new Map();
    const currentProgress = specialRound.progress.get(player.id) || {
      playerId: player.id,
      playerName: player.name,
      answers: [],
      correctCount: 0,
      completed: false,
      finishedAt: null,
    };

    if (currentProgress.completed) {
      callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
      return;
    }

    const clampedAnsweredCount = Math.min(answeredCount, specialRound.operations.length);
    const clampedCorrectCount = Math.min(correctCount, clampedAnsweredCount);
    currentProgress.answers = Array.from({ length: clampedAnsweredCount }, (_unused, index) => ({
      operationId: specialRound.operations[index]?.id || `operation-${index + 1}`,
      answer: null,
      correct: index < clampedCorrectCount,
    }));
    currentProgress.correctCount = clampedCorrectCount;
    currentProgress.completed = completed || clampedAnsweredCount >= specialRound.operations.length;
    currentProgress.finishedAt = currentProgress.completed ? finishedAt || Date.now() : null;

    specialRound.progress.set(player.id, currentProgress);

    io.to(room.code).emit('match:minigame-progress-updated', {
      lobbyId: room.code,
      progress: toPublicSpecialRound(specialRound).progress,
    });

    if (currentProgress.completed) {
      startMinigameScoreboardPhase(room);
    } else {
      emitMatchState(room);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:paint-prepared', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const specialRound = room?.match?.specialRound;
    const rawTarget = payload.paintTarget || {};
    const label = String(rawTarget.label || '').trim();

    if (!room || !room.match || room.match.phase !== 'special-round' || !specialRound || specialRound.minigameId !== 'paint') {
      callback?.({ ok: false, reason: 'No hay una ronda de dibujo activa.' });
      return;
    }

    if (!isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede preparar el minijuego.' });
      return;
    }

    if (specialRound.preparedByHost) {
      callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
      return;
    }

    if (!label) {
      callback?.({ ok: false, reason: 'El objeto para dibujar es obligatorio.' });
      return;
    }

    specialRound.preparedByHost = true;
    specialRound.paintTarget = {
      id: String(rawTarget.id || label.toLowerCase().replace(/\s+/g, '-')),
      label,
    };
    specialRound.paintPhase = 'drawing';
    specialRound.paintEndsAt = Date.now() + PAINT_DRAWING_MS;
    specialRound.paintVoteEndsAt = null;
    specialRound.paintSubmissions = new Map();
    specialRound.paintVotes = new Map();
    specialRound.results = [];
    // Margen para que lleguen los envios automaticos que hacen los clientes al agotarse el tiempo.
    setRoomTimer(room, 'paint', specialRound.paintEndsAt + TIMER_GRACE_MS, () => startPaintVotingPhase(room));

    io.to(room.code).emit('match:paint-prepared', {
      lobbyId: room.code,
      specialRound: toPublicSpecialRound(specialRound),
    });
    emitMatchState(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:paint-submit', (payload = {}, callback) => {
    const imageDataUrl = String(payload.imageDataUrl || '').trim();
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const specialRound = room?.match?.specialRound;

    if (!room || !player || !room.match || room.match.phase !== 'special-round' || !specialRound || specialRound.minigameId !== 'paint') {
      callback?.({ ok: false, reason: 'No hay una ronda de dibujo activa.' });
      return;
    }

    if (specialRound.paintPhase !== 'drawing') {
      callback?.({ ok: false, reason: 'La fase de dibujo ya no esta activa.' });
      return;
    }

    if (!imageDataUrl.startsWith('data:image/')) {
      callback?.({ ok: false, reason: 'El dibujo no tiene un formato valido.' });
      return;
    }

    specialRound.paintSubmissions = specialRound.paintSubmissions || new Map();
    specialRound.paintSubmissions.set(player.id, {
      playerId: player.id,
      playerName: player.name,
      imageDataUrl,
      submittedAt: Date.now(),
    });

    const activePlayerIds = getActivePlayers(room).map((activePlayer) => activePlayer.id);
    const allSubmitted =
      activePlayerIds.length > 0 && activePlayerIds.every((activePlayerId) => specialRound.paintSubmissions.has(activePlayerId));

    io.to(room.code).emit('match:paint-submission-updated', {
      lobbyId: room.code,
      specialRound: toPublicSpecialRound(specialRound),
    });

    if (allSubmitted) {
      startPaintVotingPhase(room);
    } else {
      emitMatchState(room);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:paint-vote', (payload = {}, callback) => {
    const targetPlayerId = String(payload.targetPlayerId || '').trim();
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const specialRound = room?.match?.specialRound;

    if (!room || !player || !room.match || room.match.phase !== 'special-round' || !specialRound || specialRound.minigameId !== 'paint') {
      callback?.({ ok: false, reason: 'No hay una votacion de dibujo activa.' });
      return;
    }

    if (specialRound.paintPhase !== 'voting') {
      callback?.({ ok: false, reason: 'La votacion todavia no esta activa.' });
      return;
    }

    if (player.id === targetPlayerId) {
      callback?.({ ok: false, reason: 'No puedes votar tu propio dibujo.' });
      return;
    }

    if (!specialRound.paintSubmissions?.has(targetPlayerId)) {
      callback?.({ ok: false, reason: 'Selecciona un dibujo valido.' });
      return;
    }

    specialRound.paintVotes = specialRound.paintVotes || new Map();
    specialRound.paintVotes.set(player.id, targetPlayerId);

    const expectedVoterIds = getActivePlayers(room)
      .map((activePlayer) => activePlayer.id)
      .filter((activePlayerId) =>
        Array.from(specialRound.paintSubmissions.keys()).some((targetId) => targetId !== activePlayerId),
      );
    const allVoted =
      expectedVoterIds.length > 0 && expectedVoterIds.every((activePlayerId) => specialRound.paintVotes.has(activePlayerId));

    emitMatchState(room);

    if (allVoted) {
      startPaintScoreboardPhase(room);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:impostor-advance-turn', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const impostor = room?.match?.specialRound?.impostor;
    const expectedTurnIndex = Number(payload.turnIndex);

    if (!room || !player || !impostor || room.match.phase !== 'special-round' || impostor.stage !== 'turns') {
      callback?.({ ok: false, reason: 'No hay un turno activo.' });
      return;
    }

    // El indice esperado evita que un doble clic o un reintento salten a un jugador.
    if (expectedTurnIndex !== impostor.turnIndex) {
      callback?.({ ok: true, match: toMatchState(room) });
      return;
    }

    const currentTurnPlayerId = impostor.turnOrder[impostor.turnIndex];
    const currentTurnPlayer = room.players.get(currentTurnPlayerId);
    const hostSkippingAbsentPlayer = isHostRequest(room, payload) && (!currentTurnPlayer || !currentTurnPlayer.active);

    if (player.id !== currentTurnPlayerId && !hostSkippingAbsentPlayer) {
      callback?.({ ok: false, reason: 'No es tu turno.' });
      return;
    }

    impostor.completedTurnIds.push(currentTurnPlayerId);
    impostor.turnIndex += 1;

    if (impostor.turnIndex >= impostor.turnOrder.length) {
      startImpostorVoting(room);
    } else {
      emitMatchState(room);
    }

    callback?.({ ok: true, match: toMatchState(room) });
  });

  socket.on('match:impostor-vote', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const specialRound = room?.match?.specialRound;
    const impostor = specialRound?.impostor;
    const targetId = String(payload.targetId || '').trim();

    if (!room || !player || !impostor || room.match.phase !== 'special-round' || impostor.stage !== 'voting') {
      callback?.({ ok: false, reason: 'No hay una votacion activa.' });
      return;
    }

    if (!specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'Esta ronda la estas viendo como espectador.' });
      return;
    }

    if (impostor.votes.has(player.id)) {
      callback?.({ ok: true, match: toMatchState(room) });
      return;
    }

    if (targetId === 'skip') {
      if (impostor.wordRound >= IMPOSTOR_MAX_ROUNDS) {
        callback?.({ ok: false, reason: 'Esta es la ultima ronda, hay que pulsar a alguien.' });
        return;
      }
    } else if (!specialRound.participantIds.includes(targetId) || !room.players.has(targetId) || targetId === player.id) {
      callback?.({ ok: false, reason: 'Selecciona a otro jugador valido.' });
      return;
    }

    impostor.votes.set(player.id, targetId);
    emitMatchState(room);
    maybeResolveImpostorVote(room);
    callback?.({ ok: true, match: toMatchState(room) });
  });

  socket.on('match:ten-but-spin', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const tenBut = room?.match?.specialRound?.tenBut;

    if (!room || !player || !tenBut || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay una ruleta activa.' });
      return;
    }

    if (tenBut.speakerId !== player.id) {
      callback?.({ ok: false, reason: 'Solo el portavoz puede girar la ruleta.' });
      return;
    }

    if (tenBut.stage === 'waiting-spin') {
      clearRoomTimer(room, 'ten-but');
      startTenButSpin(room);
    }

    callback?.({ ok: true, match: toMatchState(room) });
  });

  socket.on('match:ten-but-answer', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const specialRound = room?.match?.specialRound;
    const tenBut = specialRound?.tenBut;
    const answer = Math.trunc(Number(payload.answer));

    if (!room || !player || !tenBut || room.match.phase !== 'special-round' || tenBut.stage !== 'answering') {
      callback?.({ ok: false, reason: 'Ahora mismo no se pueden enviar respuestas.' });
      return;
    }

    if (player.id === tenBut.speakerId || !specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No puedes responder en esta ronda.' });
      return;
    }

    if (!Number.isFinite(answer) || answer < 1 || answer > 10) {
      callback?.({ ok: false, reason: 'Elige un numero del 1 al 10.' });
      return;
    }

    if (!tenBut.answers.has(player.id)) {
      tenBut.answers.set(player.id, answer);
      emitMatchState(room);
      maybeResolveTenBut(room);
    }

    callback?.({ ok: true, answer: tenBut.answers.get(player.id) });
  });

  socket.on('match:pinturillo-frame', (payload = {}) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const pinturillo = room?.match?.specialRound?.pinturillo;
    const imageDataUrl = String(payload.imageDataUrl || '');
    const now = Date.now();

    if (!room || !player || !pinturillo || pinturillo.stage !== 'drawing' || pinturillo.drawerId !== player.id) {
      return;
    }

    if (!imageDataUrl.startsWith('data:image/') || imageDataUrl.length > PINTURILLO_MAX_FRAME_LENGTH) {
      return;
    }

    if (now - pinturillo.lastFrameAt < PINTURILLO_FRAME_MIN_GAP_MS) {
      return;
    }

    pinturillo.lastFrame = imageDataUrl;
    pinturillo.lastFrameAt = now;
    // Se reenvia al resto de la sala sin pasar por el estado completo, que es mas pesado.
    socket.to(room.code).emit('match:pinturillo-frame', { lobbyId: room.code, imageDataUrl });
  });

  socket.on('match:pinturillo-request-frame', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const pinturillo = room?.match?.specialRound?.pinturillo;

    callback?.({ ok: Boolean(room && player && pinturillo), imageDataUrl: pinturillo?.lastFrame || null });
  });

  socket.on('match:pinturillo-guess', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const specialRound = room?.match?.specialRound;
    const pinturillo = specialRound?.pinturillo;
    const text = String(payload.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const now = Date.now();

    if (!room || !player || !pinturillo || room.match.phase !== 'special-round' || pinturillo.stage !== 'drawing') {
      callback?.({ ok: false, reason: 'La ronda de dibujo no esta activa.' });
      return;
    }

    if (now < pinturillo.startsAt) {
      callback?.({ ok: false, reason: 'Todavia no ha empezado la ronda.' });
      return;
    }

    if (player.id === pinturillo.drawerId) {
      callback?.({ ok: false, reason: 'Estas dibujando: no puedes escribir en el chat.' });
      return;
    }

    if (!specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'Esta ronda la estas viendo como espectador.' });
      return;
    }

    if (!text) {
      callback?.({ ok: false, reason: 'Escribe algo.' });
      return;
    }

    if (now - (pinturillo.lastMessageAt.get(player.id) || 0) < 300) {
      callback?.({ ok: false, reason: 'Vas demasiado rapido.' });
      return;
    }

    pinturillo.lastMessageAt.set(player.id, now);
    const alreadyGuessed = pinturillo.guesses.some((guess) => guess.playerId === player.id);
    const normalized = normalizeGuess(text);

    if (alreadyGuessed) {
      // Quien ya acerto solo puede hablar con el dibujante y con los que tambien acertaron, para no chivar la palabra.
      const audience = [pinturillo.drawerId, ...pinturillo.guesses.map((guess) => guess.playerId)];
      const message = { id: `${now}-${player.id}`, at: now, kind: 'guessed-chat', playerId: player.id, text };

      for (const playerId of audience) {
        const target = room.players.get(playerId);

        if (target?.socketId) {
          io.to(target.socketId).emit('match:pinturillo-chat', { lobbyId: room.code, message });
        }
      }

      callback?.({ ok: true });
      return;
    }

    // Un mensaje que contiene la palabra cuenta como acierto y nunca se muestra en el chat.
    if (normalized && (normalized === pinturillo.normalizedWord || ` ${normalized} `.includes(` ${pinturillo.normalizedWord} `))) {
      const guesserCount = getPinturilloGuesserIds(room).length;
      const order = pinturillo.guesses.length;
      const points = rankLadderPoints(order, Math.max(1, guesserCount - 1));

      pinturillo.guesses.push({ playerId: player.id, order: order + 1, points, at: now });
      pushPinturilloMessage(room, { kind: 'correct', playerId: player.id, points, order: order + 1 });
      emitMatchState(room);
      callback?.({ ok: true, correct: true, points });
      maybeFinishPinturillo(room);
      return;
    }

    pushPinturilloMessage(room, { kind: 'chat', playerId: player.id, text });
    callback?.({ ok: true, close: isCloseGuess(normalized, pinturillo.normalizedWord) });
  });

  socket.on('match:pogo-jump', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const pogo = room?.match?.specialRound?.pogo;
    const gain = Math.trunc(Number(payload.gain));
    const now = Date.now();
    const racer = pogo?.racers.get(player?.id);

    if (!room || !player || !pogo || !racer || room.match.phase !== 'special-round' || pogo.stage !== 'racing') {
      callback?.({ ok: false, reason: 'La carrera no esta activa.' });
      return;
    }

    // La comprobacion del salto se hace en el cliente para que sea instantanea; aqui se validan limites y ritmo.
    if (now < pogo.raceStartsAt - 200 || now > pogo.raceEndsAt + 300 || racer.finishedAt || ![0, 1, 2].includes(gain)) {
      callback?.({ ok: false, reason: 'Salto no valido.' });
      return;
    }

    if (now - racer.lastJumpAt < POGO_MIN_JUMP_GAP_MS) {
      callback?.({ ok: false, reason: 'Demasiado rapido.' });
      return;
    }

    racer.lastJumpAt = now;

    if (gain === 0) {
      racer.misses += 1;
    } else {
      racer.jumps += 1;
      racer.perfects += gain === 2 ? 1 : 0;
      racer.progress = Math.min(pogo.goal, racer.progress + gain);

      if (racer.progress >= pogo.goal) {
        racer.finishedAt = now;
      }
    }

    io.to(room.code).emit('match:pogo-progress', {
      lobbyId: room.code,
      racers: toPublicPogoRacers(pogo),
      jump: { playerId: player.id, gain },
    });
    callback?.({ ok: true, progress: racer.progress, finished: Boolean(racer.finishedAt) });
    maybeFinishPogo(room);
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
      if (room.match) {
        startHostPause(room);
        continue;
      }

      closeMatchRoom(room, 'El host ya no esta presente.');
      continue;
    }

    let presenceChanged = false;

    for (const [playerId, player] of room.players.entries()) {
      player.missedPresenceChecks += 1;
      io.to(player.socketId).emit('room:presence-check', { code: room.code, playerId });

      if (player.missedPresenceChecks < 2) {
        continue;
      }

      if (playerId === room.hostId && room.match) {
        player.active = false;
        startHostPause(room);
        continue;
      }

      if (room.match) {
        if (player.active) {
          player.active = false;
          presenceChanged = true;
        }
        continue;
      }

      room.players.delete(playerId);
      broadcastLobby(room);
    }

    if (presenceChanged) {
      broadcastLobby(room);
      emitMatchState(room);
      reevaluateActiveMinigame(room);
    }
  }
}, PRESENCE_CHECK_MS);

server.listen(PORT, () => {
  console.log(`Backend escuchando en el puerto ${PORT} (${isProduction ? 'produccion' : 'desarrollo'})`);
  console.log(`Frontend(s) permitido(s): ${allowedOrigins.join(', ')}`);
});
