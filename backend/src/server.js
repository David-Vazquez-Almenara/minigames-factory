const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
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
// Intro del minijuego en los clientes ("Minijuego" + explicacion) antes de que empiece a correr el tiempo.
// La explicacion dura como minimo lo de siempre y se alarga con textos largos para que de tiempo a leerlos.
const MINIGAME_TITLE_MS = 1750;
const MINIGAME_INTRO_MS = 7000;
const MINIGAME_READING_MS_PER_CHAR = 60;
const MINIGAME_INTRO_MAX_MS = 20000;
// El portavoz no tiene que pulsar nada: su cliente gira la ruleta 1 s despues de mostrarla y, si no lo hace
// (desconexion), el servidor la gira solo poco despues como respaldo.
const TEN_BUT_AUTO_SPIN_EXTRA_MS = 2500;
// Vuelta al lobby al terminar: el host primero y el resto 1 s despues de que el host confirme su lobby.
const LOBBY_RETURN_DELAY_MS = 1000;
// Si el host no pulsa "Ver marcador" cuando el minijuego ya tiene resultados, se pulsa solo pasado este tiempo.
const AUTO_SCOREBOARD_MS = 7000;
// Un minijuego jugado no puede volver a tocar hasta que se hayan jugado este numero de minijuegos distintos.
const MINIGAME_COOLDOWN = 2;
const LOBBY_RETURN_FALLBACK_MS = 12000;
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
      'Resuelve las operaciones. Cuantas mas aciertes y mas rapido termines, mas puntos podras ganar.',
    image: 'assets/minigames/math-operations.png',
    accent: '#d9f4ff',
    minPlayers: 1,
  },
  {
    id: 'paint',
    title: 'A Pintar',
    description:
      'Dibuja el objeto y vota despues por la obra que mas se parezca.',
    image: 'assets/minigames/paint.png',
    accent: '#fff4b8',
    minPlayers: 2,
  },
  {
    id: 'impostor',
    title: 'El Impostor',
    description:
      'Todos conocen la palabra secreta menos uno. Por turnos, decid en voz alta algo relacionado y votad para expulsar al impostor.',
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
      'Un jugador dibuja y el resto la adivina por el chat. Cuanto antes la aciertes, mas puntos.',
    image: 'assets/minigames/pinturillo.png',
    accent: '#ffb3b3',
    minPlayers: 2,
  },
  {
    id: 'pogo',
    title: 'Carrera en pogo',
    description:
      'Pulsa ESPACIO (o el boton) cuando la aguja pase por la zona marcada para saltar. La zona blanca vale el doble. Llega el primero a la meta.',
    image: 'assets/minigames/pogo.png',
    accent: '#d9f4ff',
    minPlayers: 2,
  },
  {
    id: 'blackjack',
    title: 'Blackjack',
    description:
      'Mesa de casino con 300 fichas para 3 manos. Gana al crupier sin pasarte de 21. Gana quien acabe con mas fichas.',
    image: 'assets/minigames/blackjack.png',
    accent: '#b9f7a7',
    minPlayers: 2,
  },
  {
    id: 'barrels',
    title: 'Barriles',
    description:
      'Un barril cae sobre tu cabeza. Pulsa ESPACIO (O el boton) para pararlo lo mas cerca posible de tu cabeza... sin que te aplaste.',
    image: 'assets/minigames/barrels.png',
    accent: '#ffe891',
    minPlayers: 2,
  },
  {
    id: 'cups',
    title: 'Cubiletes',
    description:
      'El crupier esconde una bola bajo uno de los 4 cubiletes y los mezcla. Cuando paren, tienes 15 segundos para elegir donde esta la bola.',
    image: 'assets/minigames/cups.png',
    accent: '#fff0a8',
    minPlayers: 2,
  },
  {
    id: 'cars',
    title: 'Esquiva los coches',
    description:
      'Elige uno de los 4 carriles y cruza los dedos. Gana quien aguante mas rondas.',
    image: 'assets/minigames/cars.png',
    accent: '#d9f4ff',
    minPlayers: 2,
  },
  {
    id: 'balloon',
    title: 'Cuidado que explota',
    description:
      'Por turnos, sube al escenario y dale a la palanca para hinchar el globo hasta que explote. A quien le explote pierde 15 puntos; el resto gana 5 puntos.',
    image: 'assets/minigames/balloon.png',
    accent: '#ffc4dc',
    minPlayers: 2,
  },
];

/** Duracion de la intro de un minijuego: minimo la de siempre y mas tiempo de lectura si la explicacion es larga. */
function minigameIntroMs(description) {
  const reading = String(description || '').length * MINIGAME_READING_MS_PER_CHAR;
  return Math.min(MINIGAME_INTRO_MAX_MS, Math.max(MINIGAME_INTRO_MS, MINIGAME_TITLE_MS + reading));
}
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

  for (const key of ['paintEndsAt', 'paintVoteEndsAt', 'autoScoreboardAt']) {
    if (specialRound[key]) {
      specialRound[key] += shiftMs;
    }
  }

  // La intro solo se desplaza si la pausa empezo antes de que terminara (si ya habia acabado, no importa).
  const pausedAt = Date.now() - shiftMs;

  for (const key of ['titleEndsAt', 'introEndsAt']) {
    if (specialRound[key] > pausedAt) {
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

  if (specialRound.blackjack) {
    for (const key of ['betEndsAt', 'turnEndsAt', 'summaryEndsAt', 'dealStartedAt', 'groupChangeEndsAt']) {
      if (specialRound.blackjack[key]) {
        specialRound.blackjack[key] += shiftMs;
      }
    }
  }

  if (specialRound.barrels && specialRound.barrels.stage === 'falling') {
    specialRound.barrels.startsAt += shiftMs;
  }

  if (specialRound.balloon) {
    for (const key of ['turnStartsAt', 'turnEndsAt']) {
      if (specialRound.balloon[key]) {
        specialRound.balloon[key] += shiftMs;
      }
    }
  }

  if (specialRound.cups) {
    for (const key of ['placeStartsAt', 'shuffleStartsAt', 'shuffleEndsAt', 'voteEndsAt', 'revealAt', 'nextRoundAt']) {
      if (specialRound.cups[key]) {
        specialRound.cups[key] += shiftMs;
      }
    }
  }

  if (specialRound.cars) {
    for (const key of ['chooseEndsAt', 'hornAt', 'passStartsAt', 'impactAt', 'nextRoundAt']) {
      if (specialRound.cars[key]) {
        specialRound.cars[key] += shiftMs;
      }
    }
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
    startedAt: specialRound.startedAt,
    introMs: specialRound.introMs,
    titleEndsAt: specialRound.titleEndsAt,
    introEndsAt: specialRound.introEndsAt,
    participantIds: specialRound.participantIds,
    hasResults: Boolean(specialRound.hasResults),
    autoScoreboardAt: specialRound.autoScoreboardAt || null,
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
    blackjack: toPublicBlackjack(specialRound.blackjack),
    barrels: toPublicBarrels(specialRound.barrels),
    balloon: toPublicBalloon(specialRound.balloon),
    cups: toPublicCups(specialRound.cups),
    cars: toPublicCars(specialRound.cars),
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
  scheduleAutoScoreboard(room);
  io.to(room.code).emit('match:state', toMatchState(room));
}

/** En cuanto un minijuego tiene resultados empieza la cuenta: a los 7 s se abre el marcador aunque el host no pulse. */
function scheduleAutoScoreboard(room) {
  const specialRound = room.match?.specialRound;

  if (room.match?.phase !== 'special-round' || !specialRound?.hasResults || specialRound.autoScoreboardAt) {
    return;
  }

  specialRound.autoScoreboardAt = Date.now() + AUTO_SCOREBOARD_MS;
  setRoomTimer(room, 'auto-scoreboard', specialRound.autoScoreboardAt, () => enterMinigameScoreboard(room));
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

/**
 * Un minijuego no puede volver a tocar hasta que se hayan jugado otros dos distintos. Sigue apareciendo en la
 * ruleta (para que se vea variedad), pero no puede ser el ganador. Si hay pocos minijuegos activos y no queda
 * ninguno libre, la espera se acorta (con 2 minijuegos se alternan; con 1, se repite).
 */
function chooseMinigame(room, candidates) {
  const recent = room.match?.recentMinigameIds || [];

  for (let cooldown = MINIGAME_COOLDOWN; cooldown >= 0; cooldown -= 1) {
    const blocked = new Set(cooldown ? recent.slice(-cooldown) : []);
    const pool = candidates.filter((minigame) => !blocked.has(minigame.id));

    if (pool.length) {
      return randomItem(pool);
    }
  }

  return candidates[0];
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
  room.match.recentMinigameIds = [...(room.match.recentMinigameIds || []), winner.id].slice(-MINIGAME_COOLDOWN);
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
  const startedAt = Date.now();
  const introMs = minigameIntroMs(minigame.description);

  room.match.phase = 'special-round';
  room.match.roulette = null;
  room.match.specialRound = {
    roundNumber: room.match.roundNumber,
    minigameId: minigame.id,
    title: minigame.title,
    description: minigame.description,
    // Todos los clientes muestran el titulo y la explicacion con los mismos tiempos (reloj del servidor).
    startedAt,
    introMs,
    titleEndsAt: startedAt + MINIGAME_TITLE_MS,
    introEndsAt: startedAt + introMs,
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
    blackjack: null,
    barrels: null,
    balloon: null,
    cups: null,
    cars: null,
  };

  if (minigame.id === 'blackjack') {
    setupBlackjack(room);
  } else if (minigame.id === 'barrels') {
    setupBarrels(room);
  } else if (minigame.id === 'balloon') {
    setupBalloon(room);
  } else if (minigame.id === 'cups') {
    setupCups(room);
  } else if (minigame.id === 'cars') {
    setupCars(room);
  } else if (minigame.id === 'impostor') {
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

/** El resto de la sala sin el host (ya esta en el lobby y no debe recibir el aviso dos veces). */
function roomExceptHost(room) {
  const host = getHostPlayer(room);
  return host?.socketId ? io.to(room.code).except(host.socketId) : io.to(room.code);
}

/** Lleva al lobby a los jugadores que seguian en el podio, una sola vez. */
function bringPlayersToLobby(room) {
  clearRoomTimer(room, 'lobby-return');

  if (!room.lobbyReturn) {
    return;
  }

  room.lobbyReturn = null;
  roomExceptHost(room).emit('match:returned-to-lobby', { lobbyId: room.code, lobby: toLobby(room) });
  broadcastLobby(room);
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
  const spinDeadline = specialRound.introEndsAt + TEN_BUT_AUTO_SPIN_EXTRA_MS;

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
  const startsAt = specialRound.introEndsAt;
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
  const raceStartsAt = specialRound.introEndsAt + POGO_COUNTDOWN_MS;

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

/* ------------------------------------------------------------------ */
/* Blackjack                                                           */
/* ------------------------------------------------------------------ */
// Reglas de esta version:
// - 300 fichas por jugador para toda la partida, 3 manos. Apuesta minima 10; apostar 0 = no jugar esa mano.
// - Mesas de 4: con mas jugadores se juega por grupos de 4 (en orden de asiento). Cada grupo apuesta, recibe sus
//   cartas y juega sus turnos; despues se sienta el grupo siguiente. El crupier tiene una sola mano para toda la
//   ronda (se reparte con el primer grupo que apuesta) y la juega al final contra todos los grupos a la vez.
// - Pago 1:1 en victoria normal; blackjack natural del jugador paga 3:2 (redondeando hacia abajo); empate devuelve.
// - El crupier NUNCA tiene blackjack natural: si sus dos primeras cartas suman 21, la carta oculta vuelve al
//   mazo en una posicion aleatoria y roba otra (todo antes de mostrar nada a nadie).
// - El crupier pide carta con 16 o menos y se planta con 17 o mas (S17), y ademas deja de pedir en cuanto ya
//   supera a todas las manos que siguen vivas: si ya va ganando, no se arriesga a pasarse.
// - Acciones del jugador: pedir carta o plantarse. Con 21 se planta automaticamente.
// - Puntos: escalera por posicion segun las fichas finales; quien acaba sin fichas para apostar pierde 10.

const BLACKJACK_START_CHIPS = 300;
const BLACKJACK_HANDS = 3;
const BLACKJACK_MIN_BET = 10;
const BLACKJACK_TABLE_SIZE = 4;
const BLACKJACK_BET_MS = 30000;
const BLACKJACK_DEAL_INTERVAL_MS = 420;
const BLACKJACK_TURN_MS = 30000;
// Tras plantarse o pasarse, la mesa se queda un momento en ese jugador para que todos vean que ha pasado.
const BLACKJACK_RESULT_PAUSE_MS = 1800;
const BLACKJACK_GROUP_CHANGE_MS = 2600;
const BLACKJACK_DEALER_STEP_MS = 1000;
// Con varios grupos, al empezar el turno del crupier cada cliente vuelve a su mesa: se espera a que se vea.
const BLACKJACK_DEALER_INTRO_MS = 1700;
const BLACKJACK_SUMMARY_MS = 7000;
const BLACKJACK_BROKE_PENALTY = -10;
const BLACKJACK_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const BLACKJACK_SUITS = ['S', 'H', 'D', 'C'];

function secureShuffle(values) {
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = crypto.randomInt(index + 1);
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }

  return copy;
}

function buildShoe(deckCount, firstDeck = 0) {
  const cards = [];

  for (let deck = firstDeck; deck < firstDeck + deckCount; deck += 1) {
    for (const suit of BLACKJACK_SUITS) {
      for (const rank of BLACKJACK_RANKS) {
        cards.push({ id: `${deck}-${rank}${suit}`, rank, suit });
      }
    }
  }

  return secureShuffle(cards);
}

/** Roba del zapato; si se agotara, se anade una baraja nueva barajada (con ids nuevos, sin repetir cartas). */
function drawFromShoe(bj) {
  if (!bj.shoe.length) {
    bj.shoe = buildShoe(1, bj.decksUsed);
    bj.decksUsed += 1;
  }

  return bj.shoe.pop();
}

function cardPoints(card) {
  if (card.rank === 'A') return 1;
  if (['J', 'Q', 'K'].includes(card.rank)) return 10;
  return Number(card.rank);
}

/** Valor de una mano: los ases cuentan 11 si no se pasa de 21 (mano "blanda"). */
function blackjackValue(cards) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    total += cardPoints(card);
    aces += card.rank === 'A' ? 1 : 0;
  }

  const soft = aces > 0 && total + 10 <= 21;
  return { total: soft ? total + 10 : total, soft };
}

function isNatural(cards) {
  return cards.length === 2 && blackjackValue(cards).total === 21;
}

function blackjackGroup(bj) {
  return bj.groups[bj.groupIndex] || [];
}

function setupBlackjack(room) {
  const specialRound = room.match.specialRound;
  const seats = [...specialRound.participantIds];
  const groups = [];

  for (let index = 0; index < seats.length; index += BLACKJACK_TABLE_SIZE) {
    groups.push(seats.slice(index, index + BLACKJACK_TABLE_SIZE));
  }

  specialRound.blackjack = {
    stage: 'betting',
    handNumber: 0,
    seats,
    groups,
    groupIndex: 0,
    previousGroupIndex: null,
    players: new Map(
      seats.map((playerId) => [
        playerId,
        { playerId, chips: BLACKJACK_START_CHIPS, bet: 0, confirmed: false, cards: [], status: 'queued', history: [] },
      ]),
    ),
    dealer: { cards: [], revealed: false },
    dealerDealt: false,
    shoe: [],
    decksUsed: 0,
    dealOrder: [],
    dealStartedAt: null,
    betEndsAt: null,
    turnOrder: [],
    turnIndex: -1,
    currentPlayerId: null,
    turnEndsAt: null,
    turnLocked: false,
    groupChangeEndsAt: null,
    summaryEndsAt: null,
    lastSummary: null,
    finalRanking: null,
    resolvedHand: 0,
  };

  startBlackjackHand(room, 1, specialRound.introEndsAt - Date.now());
}

function startBlackjackHand(room, handNumber, extraDelayMs = 0) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj) {
    return;
  }

  bj.handNumber = handNumber;
  bj.dealer = { cards: [], revealed: false };
  bj.dealerDealt = false;
  bj.summaryEndsAt = null;
  // Mazo nuevo y barajado para cada mano, compartido por todos los grupos: 1 baraja hasta 3 jugadores y 2 desde 4.
  bj.decksUsed = bj.seats.length <= 3 ? 1 : 2;
  bj.shoe = buildShoe(bj.decksUsed);

  for (const player of bj.players.values()) {
    player.cards = [];
    player.bet = 0;
    player.confirmed = false;
    player.status = 'queued';
  }

  startBlackjackGroupBetting(room, 0, extraDelayMs);
}

function startBlackjackGroupBetting(room, groupIndex, extraDelayMs = 0) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj) {
    return;
  }

  bj.stage = 'betting';
  bj.groupIndex = groupIndex;
  bj.dealOrder = [];
  bj.dealStartedAt = null;
  bj.turnOrder = [];
  bj.turnIndex = -1;
  bj.currentPlayerId = null;
  bj.turnEndsAt = null;
  bj.turnLocked = false;
  bj.groupChangeEndsAt = null;
  bj.betEndsAt = Date.now() + Math.max(0, extraDelayMs) + BLACKJACK_BET_MS;

  for (const playerId of blackjackGroup(bj)) {
    const player = bj.players.get(playerId);
    // Sin fichas suficientes no se puede apostar: mira la mano desde su asiento.
    player.confirmed = player.chips < BLACKJACK_MIN_BET;
    player.status = player.confirmed ? 'broke' : 'betting';
  }

  setRoomTimer(room, 'blackjack', bj.betEndsAt, () => startBlackjackDeal(room));
  emitMatchState(room);
  maybeStartBlackjackDeal(room);
}

function maybeStartBlackjackDeal(room) {
  const specialRound = room.match?.specialRound;
  const bj = specialRound?.blackjack;

  if (!bj || bj.stage !== 'betting') {
    return;
  }

  const activeIds = getActiveParticipantIds(room, specialRound);

  if (blackjackGroup(bj).filter((playerId) => activeIds.includes(playerId)).every((playerId) => bj.players.get(playerId)?.confirmed)) {
    startBlackjackDeal(room);
  }
}

function startBlackjackDeal(room) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj || bj.stage !== 'betting') {
    return;
  }

  clearRoomTimer(room, 'blackjack');
  const group = blackjackGroup(bj);

  // Quien no confirmo a tiempo (o se desconecto) no juega esta mano.
  for (const playerId of group) {
    const player = bj.players.get(playerId);

    if (!player.confirmed) {
      player.confirmed = true;
      player.bet = 0;
    }

    if (player.status === 'betting' || player.status === 'ready') {
      player.status = player.bet > 0 ? 'waiting' : 'sitting-out';
    }
  }

  const bettors = group.filter((playerId) => bj.players.get(playerId).bet > 0);

  if (!bettors.length) {
    finishBlackjackGroup(room);
    return;
  }

  const draw = () => drawFromShoe(bj);
  bj.dealOrder = [];

  // Orden real: primera carta a cada jugador, segunda a cada jugador y despues las dos del crupier.
  for (let round = 0; round < 2; round += 1) {
    for (const playerId of bettors) {
      bj.players.get(playerId).cards.push(draw());
      bj.dealOrder.push({ to: playerId, index: round });
    }
  }

  // El crupier recibe su mano una sola vez por ronda; los grupos siguientes juegan contra esa misma mano.
  if (!bj.dealerDealt) {
    const upCard = draw();
    let holeCard = draw();

    // Regla especial: el crupier no puede empezar con blackjack. La carta vuelve al mazo (posicion aleatoria)
    // y se roba otra. Ocurre antes de enviar nada, asi que nadie ve una carta distinta de la definitiva.
    while (isNatural([upCard, holeCard])) {
      bj.shoe.splice(crypto.randomInt(bj.shoe.length + 1), 0, holeCard);
      holeCard = draw();
    }

    bj.dealer.cards = [upCard, holeCard];
    bj.dealOrder.push({ to: 'dealer', index: 0 }, { to: 'dealer', index: 1, hidden: true });
    bj.dealerDealt = true;
  }

  for (const playerId of bettors) {
    const player = bj.players.get(playerId);
    player.status = isNatural(player.cards) ? 'blackjack' : 'playing';
  }

  bj.stage = 'dealing';
  bj.dealStartedAt = Date.now() + 300;
  setRoomTimer(room, 'blackjack', bj.dealStartedAt + bj.dealOrder.length * BLACKJACK_DEAL_INTERVAL_MS + 600, () =>
    startBlackjackTurns(room),
  );
  emitMatchState(room);
}

function startBlackjackTurns(room) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj || bj.stage !== 'dealing') {
    return;
  }

  bj.stage = 'player-turns';
  bj.turnOrder = blackjackGroup(bj).filter((playerId) => bj.players.get(playerId)?.status === 'playing');
  bj.turnIndex = -1;
  advanceBlackjackTurn(room);
}

function advanceBlackjackTurn(room) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj || bj.stage !== 'player-turns') {
    return;
  }

  clearRoomTimer(room, 'blackjack');
  bj.turnLocked = false;
  bj.turnIndex += 1;

  while (bj.turnIndex < bj.turnOrder.length && bj.players.get(bj.turnOrder[bj.turnIndex])?.status !== 'playing') {
    bj.turnIndex += 1;
  }

  if (bj.turnIndex >= bj.turnOrder.length) {
    bj.currentPlayerId = null;
    bj.turnEndsAt = null;
    finishBlackjackGroup(room);
    return;
  }

  bj.currentPlayerId = bj.turnOrder[bj.turnIndex];
  bj.turnEndsAt = Date.now() + BLACKJACK_TURN_MS;
  // Si se le acaba el tiempo (o se ha desconectado), se planta solo para no bloquear la mesa.
  setRoomTimer(room, 'blackjack', bj.turnEndsAt, () => applyBlackjackAction(room, bj.currentPlayerId, 'stand'));
  emitMatchState(room);

  const current = room.players.get(bj.currentPlayerId);

  if (!current || !current.active) {
    setRoomTimer(room, 'blackjack', Date.now() + 2500, () => applyBlackjackAction(room, bj.currentPlayerId, 'stand'));
  }
}

function blackjackTurnToken(bj) {
  const player = bj.players.get(bj.currentPlayerId);
  return `${bj.handNumber}:${bj.currentPlayerId}:${player?.cards.length || 0}`;
}

function applyBlackjackAction(room, playerId, action) {
  const bj = room.match?.specialRound?.blackjack;
  const player = bj?.players.get(playerId);

  if (!bj || bj.stage !== 'player-turns' || bj.turnLocked || bj.currentPlayerId !== playerId || player?.status !== 'playing') {
    return false;
  }

  if (action === 'hit') {
    player.cards.push(drawFromShoe(bj));
    const { total } = blackjackValue(player.cards);

    if (total > 21) {
      player.status = 'bust';
    } else if (total === 21) {
      player.status = 'stood';
    }
  } else {
    player.status = 'stood';
  }

  if (player.status !== 'playing') {
    // La camara se queda en este jugador un momento (se ve que se planta o se pasa) y despues sigue la mesa.
    bj.turnLocked = true;
    bj.turnEndsAt = null;
    setRoomTimer(room, 'blackjack', Date.now() + BLACKJACK_RESULT_PAUSE_MS, () => advanceBlackjackTurn(room));
  }

  emitMatchState(room);
  return true;
}

/** Al terminar un grupo se sienta el siguiente (con una transicion) o, si era el ultimo, juega el crupier. */
function finishBlackjackGroup(room) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj || bj.stage === 'group-change' || bj.stage === 'dealer-turn' || bj.stage === 'hand-summary') {
    return;
  }

  clearRoomTimer(room, 'blackjack');
  bj.currentPlayerId = null;
  bj.turnEndsAt = null;
  bj.turnLocked = false;

  if (bj.groupIndex + 1 >= bj.groups.length) {
    startBlackjackDealer(room);
    return;
  }

  const nextGroup = bj.groupIndex + 1;
  bj.stage = 'group-change';
  bj.previousGroupIndex = bj.groupIndex;
  bj.groupIndex = nextGroup;
  bj.groupChangeEndsAt = Date.now() + BLACKJACK_GROUP_CHANGE_MS;
  setRoomTimer(room, 'blackjack', bj.groupChangeEndsAt, () => startBlackjackGroupBetting(room, nextGroup));
  emitMatchState(room);
}

/** Pide con 16 o menos (S17), salvo que ya supere a todas las manos vivas: entonces se planta. */
function dealerShouldHit(dealerCards, liveTotals) {
  const total = blackjackValue(dealerCards).total;

  if (!liveTotals.length || total >= 17) {
    return false;
  }

  return total <= Math.max(...liveTotals);
}

function startBlackjackDealer(room) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj) {
    return;
  }

  // Nadie aposto en toda la mano: no hay nada que jugar.
  if (!bj.dealerDealt) {
    resolveBlackjackHand(room);
    return;
  }

  bj.stage = 'dealer-turn';
  emitMatchState(room);
  // Primero la camara va hacia el crupier (y cada cliente vuelve a su mesa), despues gira la carta oculta.
  const delay = bj.groups.length > 1 ? BLACKJACK_DEALER_INTRO_MS : BLACKJACK_DEALER_STEP_MS;
  setRoomTimer(room, 'blackjack', Date.now() + delay, () => blackjackDealerStep(room));
}

function blackjackDealerStep(room) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj || bj.stage !== 'dealer-turn') {
    return;
  }

  if (!bj.dealer.revealed) {
    bj.dealer.revealed = true;
  } else {
    // Manos que siguen vivas en todos los grupos (las pasadas ya perdieron y los blackjack ya cobran).
    const liveTotals = [...bj.players.values()].filter((player) => player.status === 'stood').map((player) => blackjackValue(player.cards).total);

    if (dealerShouldHit(bj.dealer.cards, liveTotals)) {
      bj.dealer.cards.push(drawFromShoe(bj));
    } else {
      resolveBlackjackHand(room);
      return;
    }
  }

  emitMatchState(room);
  setRoomTimer(room, 'blackjack', Date.now() + BLACKJACK_DEALER_STEP_MS, () => blackjackDealerStep(room));
}

function resolveBlackjackHand(room) {
  const bj = room.match?.specialRound?.blackjack;

  // Cada mano se liquida exactamente una vez, pase lo que pase con los eventos.
  if (!bj || bj.resolvedHand >= bj.handNumber) {
    return;
  }

  bj.resolvedHand = bj.handNumber;
  clearRoomTimer(room, 'blackjack');
  bj.dealer.revealed = true;
  bj.currentPlayerId = null;
  bj.turnLocked = false;
  const dealerTotal = blackjackValue(bj.dealer.cards).total;
  const dealerBust = dealerTotal > 21;
  const results = [];

  for (const playerId of bj.seats) {
    const player = bj.players.get(playerId);
    const total = blackjackValue(player.cards).total;
    let outcome = 'sat-out';
    let delta = 0;

    if (player.bet > 0) {
      if (player.status === 'bust') {
        outcome = 'lose';
        delta = -player.bet;
      } else if (player.status === 'blackjack') {
        outcome = 'blackjack';
        delta = Math.floor(player.bet * 1.5);
      } else if (dealerBust || total > dealerTotal) {
        outcome = 'win';
        delta = player.bet;
      } else if (total === dealerTotal) {
        outcome = 'push';
      } else {
        outcome = 'lose';
        delta = -player.bet;
      }
    }

    player.chips += delta;
    player.history.push({ hand: bj.handNumber, bet: player.bet, outcome, delta, total, chipsAfter: player.chips });
    results.push({ playerId, outcome, delta, bet: player.bet, total });
  }

  bj.stage = 'hand-summary';
  bj.lastSummary = { hand: bj.handNumber, dealerTotal, dealerBust, results };
  bj.summaryEndsAt = Date.now() + BLACKJACK_SUMMARY_MS;
  setRoomTimer(room, 'blackjack', bj.summaryEndsAt, () => {
    if (bj.handNumber < BLACKJACK_HANDS) {
      startBlackjackHand(room, bj.handNumber + 1);
    } else {
      finishBlackjack(room);
    }
  });
  emitMatchState(room);
}

function finishBlackjack(room) {
  const specialRound = room.match?.specialRound;
  const bj = specialRound?.blackjack;

  if (!bj || bj.finalRanking) {
    return;
  }

  const sorted = [...bj.players.values()].sort((first, second) => second.chips - first.chips);
  const scoringSlots = Math.max(1, sorted.length - 1);
  bj.finalRanking = sorted.map((player) => {
    // Mismo saldo = misma posicion y mismos puntos. Sin fichas para apostar = ha perdido: resta 10.
    const position = 1 + sorted.filter((other) => other.chips > player.chips).length;
    const broke = player.chips < BLACKJACK_MIN_BET;

    return {
      playerId: player.playerId,
      playerName: room.players.get(player.playerId)?.name || '',
      position,
      startChips: BLACKJACK_START_CHIPS,
      finalChips: player.chips,
      net: player.chips - BLACKJACK_START_CHIPS,
      broke,
      hands: player.history.map((entry) => ({ hand: entry.hand, outcome: entry.outcome, delta: entry.delta })),
      points: broke ? BLACKJACK_BROKE_PENALTY : rankLadderPoints(position - 1, scoringSlots),
    };
  });
  bj.stage = 'final';
  specialRound.results = bj.finalRanking.map((entry) => ({
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

function toPublicBlackjack(bj) {
  if (!bj) {
    return null;
  }

  const dealerVisible = bj.dealer.revealed ? bj.dealer.cards : bj.dealer.cards.slice(0, 1);

  return {
    stage: bj.stage,
    handNumber: bj.handNumber,
    totalHands: BLACKJACK_HANDS,
    minBet: BLACKJACK_MIN_BET,
    startChips: BLACKJACK_START_CHIPS,
    tableSize: BLACKJACK_TABLE_SIZE,
    seats: bj.seats,
    groups: bj.groups,
    groupIndex: bj.groupIndex,
    previousGroupIndex: bj.stage === 'group-change' ? bj.previousGroupIndex : null,
    groupChangeEndsAt: bj.stage === 'group-change' ? bj.groupChangeEndsAt : null,
    groupChangeMs: BLACKJACK_GROUP_CHANGE_MS,
    players: bj.seats.map((playerId) => {
      const player = bj.players.get(playerId);
      return {
        playerId,
        chips: player.chips,
        bet: player.bet,
        confirmed: player.confirmed,
        status: player.status,
        cards: player.cards,
        value: blackjackValue(player.cards),
        history: player.history,
      };
    }),
    // La carta oculta nunca sale del servidor hasta que se revela: solo se envia un marcador sin identidad.
    dealer: {
      cards: bj.dealer.revealed ? bj.dealer.cards : bj.dealer.cards.map((card, index) => (index === 1 ? { id: 'hole', hidden: true } : card)),
      value: blackjackValue(dealerVisible),
      revealed: bj.dealer.revealed,
    },
    dealOrder: bj.dealOrder,
    dealStartedAt: bj.dealStartedAt,
    dealInterval: BLACKJACK_DEAL_INTERVAL_MS,
    betEndsAt: bj.betEndsAt,
    currentPlayerId: bj.currentPlayerId,
    turnEndsAt: bj.turnEndsAt,
    turnLocked: bj.turnLocked,
    turnToken: bj.stage === 'player-turns' && !bj.turnLocked ? blackjackTurnToken(bj) : null,
    summaryEndsAt: bj.summaryEndsAt,
    lastSummary: bj.lastSummary,
    finalRanking: bj.finalRanking,
  };
}

/* ------------------------------------------------------------------ */
/* Barriles                                                            */
/* ------------------------------------------------------------------ */
// Cada barril cae de 50 m a 0 m con una curva acelerada identica para todos: h(t) = 50 * (1 - (t/T)^p).
// El cliente detiene su barril al instante y envia el tiempo de caida; el servidor lo valida contra su reloj.

const BARRELS_START_HEIGHT = 50;
// Caida rapida (en torno a segundo y medio): hay que fiarse del instinto, no hay medidor en pantalla.
const BARRELS_FALL_MS = 1400;
const BARRELS_EXPONENT = 1.9;
const BARRELS_COUNTDOWN_MS = 3500;
const BARRELS_CLOCK_TOLERANCE_MS = 150;
const BARRELS_GRACE_MS = 1200;
const BARRELS_CRUSHED_PENALTY = -10;

function barrelHeightAt(elapsedMs) {
  const progress = Math.min(1, Math.max(0, elapsedMs / BARRELS_FALL_MS));
  return Math.max(0, BARRELS_START_HEIGHT * (1 - Math.pow(progress, BARRELS_EXPONENT)));
}

function setupBarrels(room) {
  const specialRound = room.match.specialRound;
  const startsAt = specialRound.introEndsAt + BARRELS_COUNTDOWN_MS;

  specialRound.barrels = {
    stage: 'falling',
    roundId: `${room.match.roundNumber}-${crypto.randomUUID().slice(0, 8)}`,
    startsAt,
    racers: new Map(specialRound.participantIds.map((playerId) => [playerId, { playerId, status: 'falling', height: null, elapsedMs: null }])),
    ranking: null,
  };

  setRoomTimer(room, 'barrels', startsAt + BARRELS_FALL_MS + BARRELS_GRACE_MS, () => resolveBarrels(room));
}

function maybeResolveBarrels(room) {
  const specialRound = room.match?.specialRound;
  const barrels = specialRound?.barrels;

  if (!barrels || barrels.stage !== 'falling') {
    return;
  }

  const pending = [...barrels.racers.values()].filter((racer) => racer.status === 'falling' && room.players.get(racer.playerId)?.active);

  if (!pending.length && Date.now() >= barrels.startsAt) {
    resolveBarrels(room);
  }
}

function resolveBarrels(room) {
  const specialRound = room.match?.specialRound;
  const barrels = specialRound?.barrels;

  if (!barrels || barrels.stage !== 'falling') {
    return;
  }

  clearRoomTimer(room, 'barrels');

  for (const racer of barrels.racers.values()) {
    if (racer.status === 'falling') {
      racer.status = 'crushed';
      racer.height = 0;
    }
  }

  // Supervivientes primero (menos metros = mejor; desempate por el tiempo exacto y despues por id, nunca por
  // el orden de llegada de los mensajes). Los aplastados comparten la ultima posicion.
  const survivors = [...barrels.racers.values()]
    .filter((racer) => racer.status === 'stopped')
    .sort((first, second) => first.height - second.height || second.elapsedMs - first.elapsedMs || first.playerId.localeCompare(second.playerId));
  const crushed = [...barrels.racers.values()].filter((racer) => racer.status === 'crushed').sort((first, second) => first.playerId.localeCompare(second.playerId));
  const scoringSlots = Math.max(1, barrels.racers.size - 1);

  barrels.ranking = [
    ...survivors.map((racer, index) => ({ ...racer, position: index + 1, points: rankLadderPoints(index, scoringSlots) })),
    ...crushed.map((racer) => ({ ...racer, position: survivors.length + 1, points: BARRELS_CRUSHED_PENALTY })),
  ].map((entry) => ({ ...entry, playerName: room.players.get(entry.playerId)?.name || '' }));
  barrels.stage = 'results';
  specialRound.results = barrels.ranking.map((entry) => ({
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

function toPublicBarrels(barrels) {
  if (!barrels) {
    return null;
  }

  return {
    stage: barrels.stage,
    roundId: barrels.roundId,
    startsAt: barrels.startsAt,
    fallMs: BARRELS_FALL_MS,
    startHeight: BARRELS_START_HEIGHT,
    exponent: BARRELS_EXPONENT,
    racers: [...barrels.racers.values()],
    ranking: barrels.ranking,
  };
}

/* ------------------------------------------------------------------ */
/* Cuidado que explota (globo)                                         */
/* ------------------------------------------------------------------ */
// - Orden de la fila aleatorio en la ronda 1 y el mismo en todas las siguientes.
// - En su turno, el jugador camina hasta la palanca y le da las veces que quiera (cada palancazo +1 de aire, como minimo
//   uno) y despues pasa el turno. Si se le acaba el tiempo sin tocarla, se le da un palancazo y pasa.
// - El globo aguanta una cantidad secreta de aire entre 5 y 50 (incluidos): con 5 o menos nunca explota y
//   explota en el palancazo que supera su capacidad. La capacidad no sale del servidor hasta que explota.
// - A quien le explota pierde 15 puntos; el resto gana 5. Aqui nadie gana mas.

const BALLOON_MIN_CAPACITY = 5;
const BALLOON_MAX_CAPACITY = 50;
const BALLOON_WALK_MS = 1800;
const BALLOON_TURN_MS = 15000;
const BALLOON_EXPLODE_PENALTY = -15;
const BALLOON_SURVIVOR_POINTS = 5;

function setupBalloon(room) {
  const specialRound = room.match.specialRound;

  specialRound.balloon = {
    stage: 'walking',
    order: secureShuffle(specialRound.participantIds),
    capacity: BALLOON_MIN_CAPACITY + crypto.randomInt(BALLOON_MAX_CAPACITY - BALLOON_MIN_CAPACITY + 1),
    air: 0,
    round: 1,
    turnIndex: 0,
    turnNumber: 0,
    currentPlayerId: null,
    pumpsThisTurn: 0,
    turnStartsAt: null,
    turnEndsAt: null,
    lastPump: null,
    outcome: null,
  };

  beginBalloonTurn(room, 0, 1, specialRound.introEndsAt - Date.now());
}

function beginBalloonTurn(room, startIndex, startRound, extraDelayMs = 0) {
  const balloon = room.match?.specialRound?.balloon;

  if (!balloon || balloon.outcome) {
    return;
  }

  // Siguiente jugador presente en la fila (quien se haya ido pierde su turno, el orden no cambia).
  let index = startIndex;
  let round = startRound;
  let found = false;

  for (let step = 0; step < balloon.order.length; step += 1) {
    if (room.players.get(balloon.order[index])?.active) {
      found = true;
      break;
    }

    index += 1;

    if (index >= balloon.order.length) {
      index = 0;
      round += 1;
    }
  }

  if (!found) {
    finishBalloon(room, null);
    return;
  }

  balloon.turnIndex = index;
  balloon.round = round;
  balloon.turnNumber += 1;
  balloon.currentPlayerId = balloon.order[index];
  balloon.pumpsThisTurn = 0;
  balloon.stage = 'walking';
  balloon.turnStartsAt = Date.now() + Math.max(0, extraDelayMs) + BALLOON_WALK_MS;
  balloon.turnEndsAt = balloon.turnStartsAt + BALLOON_TURN_MS;
  const turnNumber = balloon.turnNumber;

  // Primero camina hasta la palanca; al llegar empieza a contar su tiempo de turno.
  setRoomTimer(room, 'balloon', balloon.turnStartsAt, () => {
    if (balloon.turnNumber !== turnNumber || balloon.outcome) {
      return;
    }

    balloon.stage = 'pumping';
    setRoomTimer(room, 'balloon', balloon.turnEndsAt, () => balloonTurnTimeout(room, turnNumber));
    emitMatchState(room);
  });
  emitMatchState(room);
}

function balloonTurnToken(balloon) {
  return `${balloon.turnNumber}:${balloon.pumpsThisTurn}`;
}

function balloonTurnTimeout(room, turnNumber) {
  const balloon = room.match?.specialRound?.balloon;

  if (!balloon || balloon.outcome || balloon.turnNumber !== turnNumber || balloon.stage !== 'pumping') {
    return;
  }

  if (!balloon.pumpsThisTurn) {
    pumpBalloon(room, balloon.currentPlayerId);

    if (balloon.outcome) {
      return;
    }
  }

  passBalloonTurn(room);
}

function pumpBalloon(room, playerId) {
  const balloon = room.match?.specialRound?.balloon;

  if (
    !balloon ||
    balloon.outcome ||
    balloon.stage !== 'pumping' ||
    balloon.currentPlayerId !== playerId
  ) {
    return false;
  }

  balloon.air += 1;
  balloon.pumpsThisTurn += 1;
  balloon.lastPump = { playerId, air: balloon.air, turnNumber: balloon.turnNumber, pump: balloon.pumpsThisTurn, at: Date.now() };

  if (balloon.air > balloon.capacity) {
    finishBalloon(room, playerId);
    return true;
  }

  emitMatchState(room);
  return true;
}

/** Pasa al siguiente de la fila; al terminar la fila empieza otra ronda con el mismo orden. */
function passBalloonTurn(room, force = false) {
  const balloon = room.match?.specialRound?.balloon;

  if (!balloon || balloon.outcome || (!force && (balloon.stage !== 'pumping' || !balloon.pumpsThisTurn))) {
    return false;
  }

  clearRoomTimer(room, 'balloon');
  let index = balloon.turnIndex + 1;
  let round = balloon.round;

  if (index >= balloon.order.length) {
    index = 0;
    round += 1;
  }

  beginBalloonTurn(room, index, round);
  return true;
}

function finishBalloon(room, explodedBy) {
  const specialRound = room.match?.specialRound;
  const balloon = specialRound?.balloon;

  if (!balloon || balloon.outcome) {
    return;
  }

  clearRoomTimer(room, 'balloon');
  balloon.stage = 'exploded';
  balloon.outcome = {
    explodedBy,
    explodedName: explodedBy ? room.players.get(explodedBy)?.name || '' : '',
    air: balloon.air,
    capacity: balloon.capacity,
    round: balloon.round,
    at: Date.now(),
    results: specialRound.participantIds.map((playerId) => ({
      playerId,
      playerName: room.players.get(playerId)?.name || '',
      points: playerId === explodedBy ? BALLOON_EXPLODE_PENALTY : BALLOON_SURVIVOR_POINTS,
    })),
  };
  specialRound.results = balloon.outcome.results.map((entry) => ({
    ...entry,
    correctCount: 0,
    answeredCount: 0,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function skipInactiveBalloonPlayer(room) {
  const balloon = room.match?.specialRound?.balloon;

  if (balloon && !balloon.outcome && balloon.currentPlayerId && !room.players.get(balloon.currentPlayerId)?.active) {
    passBalloonTurn(room, true);
  }
}

function toPublicBalloon(balloon) {
  if (!balloon) {
    return null;
  }

  // La capacidad del globo solo se publica dentro del resultado, cuando ya ha explotado.
  return {
    stage: balloon.stage,
    order: balloon.order,
    round: balloon.round,
    turnIndex: balloon.turnIndex,
    turnNumber: balloon.turnNumber,
    currentPlayerId: balloon.currentPlayerId,
    air: balloon.air,
    pumpsThisTurn: balloon.pumpsThisTurn,
    minCapacity: BALLOON_MIN_CAPACITY,
    maxCapacity: BALLOON_MAX_CAPACITY,
    walkMs: BALLOON_WALK_MS,
    turnStartsAt: balloon.turnStartsAt,
    turnEndsAt: balloon.turnEndsAt,
    turnToken: balloon.stage === 'pumping' ? balloonTurnToken(balloon) : null,
    lastPump: balloon.lastPump,
    outcome: balloon.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Cubiletes                                                           */
/* ------------------------------------------------------------------ */
// - 4 rondas mas una ronda bonus final: el crupier mete la bola en un cubilete, los mezcla (cada ronda mas rapido;
//   la bonus, muy rapido) y despues hay 15 s para elegir cubilete (sin confirmacion; se puede cambiar hasta que acaba
//   el tiempo). Cada acierto suma 5 (max 25).
// - Los movimientos los genera el servidor (anfitrion de la sala) y los manda a todos, asi todos ven el mismo
//   patron. La posicion final de la bola no se envia hasta revelarla: solo se podria deducir del historial.
// - Movimientos: 'swap' intercambia los cubiletes de dos huecos; 'fake' amaga el cambio y los deja como estaban.

const CUPS_COUNT = 4;
const CUPS_ROUNDS = 5;
const CUPS_PLACE_MS = 2000;
const CUPS_VOTE_MS = 15000;
const CUPS_REVEAL_PAUSE_MS = 1000;
const CUPS_REVEAL_MS = 4200;
const CUPS_POINTS = 5;
const CUPS_FAKE_CHANCE = 0.25;
const CUPS_SPEEDS = [
  { moves: 6, moveMs: 760 },
  { moves: 8, moveMs: 540 },
  { moves: 10, moveMs: 370 },
  { moves: 13, moveMs: 230 },
  // Ronda 5, bonus: mezcla muy rapida (no sigue la progresion de las anteriores).
  { moves: 18, moveMs: 110 },
];

function cupsFinalSlot(initialSlot, moves) {
  let slot = initialSlot;

  for (const move of moves) {
    if (move.type === 'swap') {
      slot = slot === move.a ? move.b : slot === move.b ? move.a : slot;
    }
  }

  return slot;
}

function setupCups(room) {
  const specialRound = room.match.specialRound;

  specialRound.cups = {
    stage: 'shuffling',
    round: 0,
    initialSlot: 0,
    moves: [],
    moveMs: 0,
    finalSlot: null,
    revealedSlot: null,
    placeStartsAt: null,
    shuffleStartsAt: null,
    shuffleEndsAt: null,
    voteEndsAt: null,
    revealAt: null,
    nextRoundAt: null,
    votes: new Map(),
    scores: new Map(specialRound.participantIds.map((playerId) => [playerId, 0])),
    history: [],
    outcome: null,
  };

  startCupsRound(room, 1, specialRound.introEndsAt - Date.now());
}

function startCupsRound(room, round, extraDelayMs = 0) {
  const cups = room.match?.specialRound?.cups;

  if (!cups) {
    return;
  }

  const speed = CUPS_SPEEDS[round - 1];
  cups.round = round;
  cups.stage = 'shuffling';
  cups.initialSlot = crypto.randomInt(CUPS_COUNT);
  cups.moves = Array.from({ length: speed.moves }, () => {
    const a = crypto.randomInt(CUPS_COUNT);
    let b = crypto.randomInt(CUPS_COUNT - 1);
    b += b >= a ? 1 : 0;
    return { type: Math.random() < CUPS_FAKE_CHANCE ? 'fake' : 'swap', a, b };
  });
  cups.moveMs = speed.moveMs;
  // La solucion solo vive en el servidor hasta la revelacion.
  cups.finalSlot = cupsFinalSlot(cups.initialSlot, cups.moves);
  cups.revealedSlot = null;
  cups.votes = new Map();
  cups.placeStartsAt = Date.now() + Math.max(0, extraDelayMs) + 400;
  cups.shuffleStartsAt = cups.placeStartsAt + CUPS_PLACE_MS;
  cups.shuffleEndsAt = cups.shuffleStartsAt + cups.moves.length * cups.moveMs;
  cups.voteEndsAt = cups.shuffleEndsAt + CUPS_VOTE_MS;
  cups.revealAt = null;
  cups.nextRoundAt = null;

  // Al terminar de mezclar empieza la votacion (el tiempo de mezcla es el que tarda el crupier, sin contador).
  setRoomTimer(room, 'cups', cups.shuffleEndsAt, () => {
    if (cups.round !== round || cups.stage !== 'shuffling') {
      return;
    }

    cups.stage = 'voting';
    setRoomTimer(room, 'cups', cups.voteEndsAt, () => closeCupsVoting(room, round));
    emitMatchState(room);
    maybeCloseCupsVoting(room);
  });
  emitMatchState(room);
}

function maybeCloseCupsVoting(room) {
  const specialRound = room.match?.specialRound;
  const cups = specialRound?.cups;

  if (cups?.stage === 'voting' && getActiveParticipantIds(room, specialRound).every((playerId) => cups.votes.has(playerId))) {
    closeCupsVoting(room, cups.round);
  }
}

/** Fin de la votacion: un segundo de pausa (el contador se desvanece) y se levanta el cubilete de la bola. */
function closeCupsVoting(room, round) {
  const cups = room.match?.specialRound?.cups;

  if (!cups || cups.stage !== 'voting' || cups.round !== round) {
    return;
  }

  cups.stage = 'closing';
  cups.revealAt = Date.now() + CUPS_REVEAL_PAUSE_MS;
  setRoomTimer(room, 'cups', cups.revealAt, () => revealCups(room, round));
  emitMatchState(room);
}

function revealCups(room, round) {
  const cups = room.match?.specialRound?.cups;

  if (!cups || cups.stage !== 'closing' || cups.round !== round) {
    return;
  }

  cups.stage = 'reveal';
  cups.revealedSlot = cups.finalSlot;
  const votes = [...cups.votes.entries()].map(([playerId, slot]) => ({ playerId, slot }));
  const winners = votes.filter((vote) => vote.slot === cups.finalSlot).map((vote) => vote.playerId);

  for (const playerId of winners) {
    cups.scores.set(playerId, (cups.scores.get(playerId) || 0) + CUPS_POINTS);
  }

  cups.history.push({ round, ballSlot: cups.finalSlot, votes, winners });
  cups.nextRoundAt = Date.now() + CUPS_REVEAL_MS;
  setRoomTimer(room, 'cups', cups.nextRoundAt, () => (round < CUPS_ROUNDS ? startCupsRound(room, round + 1) : finishCups(room)));
  emitMatchState(room);
}

function finishCups(room) {
  const specialRound = room.match?.specialRound;
  const cups = specialRound?.cups;

  if (!cups || cups.outcome) {
    return;
  }

  cups.stage = 'finished';
  const ranking = [...cups.scores.entries()]
    .map(([playerId, score]) => ({
      playerId,
      playerName: room.players.get(playerId)?.name || '',
      hits: score / CUPS_POINTS,
      points: score,
    }))
    .sort((first, second) => second.points - first.points);
  cups.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.hits,
    answeredCount: CUPS_ROUNDS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicCups(cups) {
  if (!cups) {
    return null;
  }

  const revealed = cups.stage === 'reveal' || cups.stage === 'finished';

  return {
    stage: cups.stage,
    round: cups.round,
    totalRounds: CUPS_ROUNDS,
    cupCount: CUPS_COUNT,
    initialSlot: cups.initialSlot,
    moves: cups.moves,
    moveMs: cups.moveMs,
    placeMs: CUPS_PLACE_MS,
    placeStartsAt: cups.placeStartsAt,
    shuffleStartsAt: cups.shuffleStartsAt,
    shuffleEndsAt: cups.shuffleEndsAt,
    voteEndsAt: cups.voteEndsAt,
    revealAt: cups.revealAt,
    nextRoundAt: cups.nextRoundAt,
    // La bola solo se publica al revelar.
    revealedSlot: revealed ? cups.revealedSlot : null,
    votes: [...cups.votes.entries()].map(([playerId, slot]) => ({ playerId, slot })),
    scores: [...cups.scores.entries()].map(([playerId, score]) => ({ playerId, score })),
    history: cups.history,
    outcome: cups.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Esquiva los coches                                                  */
/* ------------------------------------------------------------------ */
// - Carretera de 4 carriles. Cada ronda: 15 s para elegir carril (si no, se asigna uno al azar); despues pasan
//   coches por carriles al azar (1 en las rondas 1 y 2; 2 distintos desde la 3) y quien este en ellos queda fuera.
// - Se juega hasta que queda uno o menos, o hasta completar la ronda 6.
// - Puntos: los supervivientes ganan 30; el resto, por orden de aguante (escalera, el ultimo 0). Si no sobrevive
//   nadie, los ultimos en caer (todos en la misma ronda) ganan 0 si fue en la ronda 1, 5 en la 2 y 10 desde la 3.
// - Los carriles de los coches no se publican hasta que pasan.

const CARS_LANES = 4;
const CARS_MAX_ROUNDS = 6;
const CARS_CHOOSE_MS = 15000;
const CARS_FADE_MS = 1000;
const CARS_HORN_DELAY_MS = 2000;
const CARS_DRIVE_MS = 2800;
const CARS_RESULTS_MS = 2600;
const CARS_RETURN_MS = 2600;

function setupCars(room) {
  const specialRound = room.match.specialRound;
  const ids = specialRound.participantIds;
  const leftCount = Math.ceil(ids.length / 2);

  specialRound.cars = {
    stage: 'choosing',
    round: 0,
    alive: new Set(ids),
    // Mitad en cada acera (con impares, uno mas a la izquierda).
    sides: new Map(ids.map((playerId, index) => [playerId, index < leftCount ? { side: 'left', index } : { side: 'right', index: index - leftCount }])),
    choices: new Map(),
    carLanes: [],
    hits: [],
    eliminatedRound: new Map(),
    chooseEndsAt: null,
    hornAt: null,
    passStartsAt: null,
    impactAt: null,
    nextRoundAt: null,
    outcome: null,
  };

  startCarsRound(room, 1, specialRound.introEndsAt - Date.now());
}

function startCarsRound(room, round, extraDelayMs = 0) {
  const cars = room.match?.specialRound?.cars;

  if (!cars) {
    return;
  }

  cars.round = round;
  cars.stage = 'choosing';
  cars.choices = new Map();
  cars.carLanes = [];
  cars.hits = [];
  cars.hornAt = null;
  cars.passStartsAt = null;
  cars.impactAt = null;
  cars.nextRoundAt = null;
  cars.chooseEndsAt = Date.now() + Math.max(0, extraDelayMs) + CARS_CHOOSE_MS;
  setRoomTimer(room, 'cars', cars.chooseEndsAt, () => closeCarsChoice(room, round));
  emitMatchState(room);
}

function maybeCloseCarsChoice(room) {
  const cars = room.match?.specialRound?.cars;

  if (cars?.stage === 'choosing' && [...cars.alive].filter((playerId) => room.players.get(playerId)?.active).every((playerId) => cars.choices.has(playerId))) {
    closeCarsChoice(room, cars.round);
  }
}

function closeCarsChoice(room, round) {
  const cars = room.match?.specialRound?.cars;

  if (!cars || cars.stage !== 'choosing' || cars.round !== round) {
    return;
  }

  // Quien no eligio a tiempo va a un carril al azar.
  for (const playerId of cars.alive) {
    if (!cars.choices.has(playerId)) {
      cars.choices.set(playerId, crypto.randomInt(CARS_LANES));
    }
  }

  cars.stage = 'waiting';
  cars.carLanes = secureShuffle([...Array(CARS_LANES).keys()]).slice(0, round <= 2 ? 1 : 2);
  cars.hornAt = Date.now() + CARS_FADE_MS + CARS_HORN_DELAY_MS;
  cars.passStartsAt = cars.hornAt + 600;
  cars.impactAt = cars.passStartsAt + CARS_DRIVE_MS / 2;
  setRoomTimer(room, 'cars', cars.hornAt, () => {
    if (cars.round !== round || cars.stage !== 'waiting') {
      return;
    }

    // Suena el claxon: a partir de aqui se sabe por donde pasan los coches.
    cars.stage = 'passing';
    setRoomTimer(room, 'cars', cars.impactAt, () => resolveCarsImpact(room, round));
    emitMatchState(room);
  });
  emitMatchState(room);
}

function resolveCarsImpact(room, round) {
  const cars = room.match?.specialRound?.cars;

  if (!cars || cars.stage !== 'passing' || cars.round !== round) {
    return;
  }

  cars.hits = [...cars.alive].filter((playerId) => cars.carLanes.includes(cars.choices.get(playerId)));

  for (const playerId of cars.hits) {
    cars.alive.delete(playerId);
    cars.eliminatedRound.set(playerId, round);
  }

  cars.stage = 'aftermath';
  setRoomTimer(room, 'cars', Date.now() + CARS_RESULTS_MS, () => {
    if (cars.alive.size <= 1 || round >= CARS_MAX_ROUNDS) {
      finishCars(room);
      return;
    }

    // Los que siguen vivos vuelven andando a las aceras y empieza la ronda siguiente.
    cars.stage = 'returning';
    cars.nextRoundAt = Date.now() + CARS_RETURN_MS;
    setRoomTimer(room, 'cars', cars.nextRoundAt, () => startCarsRound(room, round + 1));
    emitMatchState(room);
  });
  emitMatchState(room);
}

function finishCars(room) {
  const specialRound = room.match?.specialRound;
  const cars = specialRound?.cars;

  if (!cars || cars.outcome) {
    return;
  }

  clearRoomTimer(room, 'cars');
  cars.stage = 'finished';
  // Grupos por aguante: los supervivientes primero y despues quien cayo mas tarde.
  const reach = (playerId) => (cars.alive.has(playerId) ? Infinity : cars.eliminatedRound.get(playerId) || 0);
  const levels = [...new Set(specialRound.participantIds.map(reach))].sort((first, second) => second - first);
  const survivors = specialRound.participantIds.filter((playerId) => cars.alive.has(playerId));
  const lastRound = levels[0];
  const top = survivors.length ? 30 : lastRound >= 3 ? 10 : lastRound === 2 ? 5 : 0;
  const pointsFor = (level) => {
    const index = levels.indexOf(level);

    if (index === 0) {
      return top;
    }

    if (index === levels.length - 1) {
      return 0;
    }

    return Math.min(top, Math.max(5, Math.round((top * (1 - index / (levels.length - 1))) / 5) * 5));
  };

  const ranking = specialRound.participantIds
    .map((playerId) => ({
      playerId,
      playerName: room.players.get(playerId)?.name || '',
      survived: cars.alive.has(playerId),
      eliminatedRound: cars.eliminatedRound.get(playerId) || null,
      position: levels.indexOf(reach(playerId)) + 1,
      points: pointsFor(reach(playerId)),
    }))
    .sort((first, second) => first.position - second.position);
  cars.outcome = { ranking, rounds: cars.round };
  specialRound.results = ranking.map((entry) => ({
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

function toPublicCars(cars) {
  if (!cars) {
    return null;
  }

  const carsVisible = ['passing', 'aftermath', 'returning', 'finished'].includes(cars.stage);

  return {
    stage: cars.stage,
    round: cars.round,
    maxRounds: CARS_MAX_ROUNDS,
    lanes: CARS_LANES,
    sides: [...cars.sides.entries()].map(([playerId, seat]) => ({ playerId, ...seat })),
    alive: [...cars.alive],
    choices: [...cars.choices.entries()].map(([playerId, lane]) => ({ playerId, lane })),
    chooseEndsAt: cars.chooseEndsAt,
    hornAt: cars.hornAt,
    passStartsAt: carsVisible ? cars.passStartsAt : null,
    impactAt: carsVisible ? cars.impactAt : null,
    driveMs: CARS_DRIVE_MS,
    nextRoundAt: cars.nextRoundAt,
    // Por donde pasan los coches solo se sabe cuando suena el claxon.
    carLanes: carsVisible ? cars.carLanes : [],
    hits: cars.hits,
    eliminated: [...cars.eliminatedRound.entries()].map(([playerId, round]) => ({ playerId, round })),
    outcome: cars.outcome,
  };
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
  maybeStartBlackjackDeal(room);
  maybeResolveBarrels(room);

  // Si el jugador en turno del blackjack se va o se desconecta, se planta para no bloquear la mesa.
  const bj = specialRound.blackjack;

  if (bj?.stage === 'player-turns' && bj.currentPlayerId && !room.players.get(bj.currentPlayerId)?.active) {
    applyBlackjackAction(room, bj.currentPlayerId, 'stand');
  }

  // Igual en el globo: si quien esta en la palanca se va, pasa el turno al siguiente.
  skipInactiveBalloonPlayer(room);
  maybeCloseCupsVoting(room);
  maybeCloseCarsChoice(room);
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

  for (; ;) {
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

    if (room.lobbyReturn) {
      callback?.({ ok: false, reason: 'Espera a que el resto vuelva al lobby.' });
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
      // Ultimos minijuegos jugados (no pueden volver a tocar hasta que se jueguen otros dos distintos).
      recentMinigameIds: [],
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

    // Primero vuelve solo el host (la sala sigue siendo la misma, con el mismo codigo). El resto se queda en
    // el podio hasta que el host confirme que su lobby esta bien; si no confirmara, se les lleva igualmente.
    room.lobbyReturn = { requestedAt: Date.now(), confirmed: false };
    socket.emit('match:returned-to-lobby', { lobbyId: room.code, lobby: toLobby(room) });
    setRoomTimer(room, 'lobby-return', Date.now() + LOBBY_RETURN_FALLBACK_MS, () => bringPlayersToLobby(room));
    callback?.({ ok: true, lobby: toLobby(room) });
  });

  socket.on('match:lobby-return-confirm', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);

    if (!room || !isHostRequest(room, payload)) {
      callback?.({ ok: false, reason: 'Solo el host puede confirmar el lobby.' });
      return;
    }

    if (!room.lobbyReturn || room.lobbyReturn.confirmed) {
      callback?.({ ok: true });
      return;
    }

    room.lobbyReturn.confirmed = true;
    const at = Date.now() + LOBBY_RETURN_DELAY_MS;
    roomExceptHost(room).emit('match:lobby-return-countdown', { lobbyId: room.code, at });
    setRoomTimer(room, 'lobby-return', at, () => bringPlayersToLobby(room));
    callback?.({ ok: true, at });
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

  socket.on('match:blackjack-bet', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const bj = room?.match?.specialRound?.blackjack;
    const seat = bj?.players.get(player?.id);
    const amount = Math.trunc(Number(payload.amount));

    if (!room || !player || !bj || !seat || room.match.phase !== 'special-round' || bj.stage !== 'betting') {
      callback?.({ ok: false, reason: 'Ahora mismo no se puede apostar.' });
      return;
    }

    // La mano indicada evita que un mensaje antiguo apueste en la mano siguiente.
    if (Number(payload.handNumber) !== bj.handNumber) {
      callback?.({ ok: false, reason: 'Esa apuesta era de otra mano.' });
      return;
    }

    if (!blackjackGroup(bj).includes(player.id)) {
      callback?.({ ok: false, reason: 'Todavia no le toca a tu mesa.' });
      return;
    }

    if (seat.confirmed) {
      callback?.({ ok: true, bet: seat.bet });
      return;
    }

    if (!Number.isFinite(amount) || amount < 0 || (amount > 0 && amount < BLACKJACK_MIN_BET) || amount > seat.chips) {
      callback?.({ ok: false, reason: `La apuesta debe estar entre ${BLACKJACK_MIN_BET} y ${seat.chips} fichas (o 0 para no jugar).` });
      return;
    }

    seat.bet = amount;
    seat.confirmed = true;
    seat.status = amount > 0 ? 'ready' : 'sitting-out';
    emitMatchState(room);
    maybeStartBlackjackDeal(room);
    callback?.({ ok: true, bet: amount });
  });

  socket.on('match:blackjack-action', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const bj = room?.match?.specialRound?.blackjack;
    const action = String(payload.action || '');

    if (!room || !player || !bj || room.match.phase !== 'special-round' || bj.stage !== 'player-turns') {
      callback?.({ ok: false, reason: 'No es momento de jugar.' });
      return;
    }

    if (bj.currentPlayerId !== player.id) {
      callback?.({ ok: false, reason: 'No es tu turno.' });
      return;
    }

    if (!['hit', 'stand'].includes(action)) {
      callback?.({ ok: false, reason: 'Accion no valida.' });
      return;
    }

    // El token (mano:jugador:cartas) hace que un doble clic o un reintento solo se aplique una vez; durante la
    // pausa tras plantarse o pasarse ya no se acepta nada mas de ese turno.
    if (bj.turnLocked || String(payload.turnToken || '') !== blackjackTurnToken(bj)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    applyBlackjackAction(room, player.id, action);
    callback?.({ ok: true });
  });

  socket.on('match:cups-vote', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const specialRound = room?.match?.specialRound;
    const cups = specialRound?.cups;
    const slot = Number(payload.slot);

    if (!room || !player || !cups || room.match.phase !== 'special-round' || !specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay cubiletes en juego.' });
      return;
    }

    // La ronda indicada evita que un clic tardio cuente en la ronda siguiente.
    if (cups.stage !== 'voting' || Number(payload.round) !== cups.round) {
      callback?.({ ok: false, reason: 'Ahora no se puede elegir cubilete.' });
      return;
    }

    if (!Number.isInteger(slot) || slot < 0 || slot >= CUPS_COUNT) {
      callback?.({ ok: false, reason: 'Cubilete no valido.' });
      return;
    }

    cups.votes.set(player.id, slot);
    emitMatchState(room);
    maybeCloseCupsVoting(room);
    callback?.({ ok: true, slot });
  });

  socket.on('match:cars-choose', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const cars = room?.match?.specialRound?.cars;
    const lane = Number(payload.lane);

    if (!room || !player || !cars || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay carretera en juego.' });
      return;
    }

    if (!cars.alive.has(player.id)) {
      callback?.({ ok: false, reason: 'Ya te han atropellado: te toca mirar.' });
      return;
    }

    if (cars.stage !== 'choosing' || Number(payload.round) !== cars.round) {
      callback?.({ ok: false, reason: 'Ahora no se puede cambiar de carril.' });
      return;
    }

    if (!Number.isInteger(lane) || lane < 0 || lane >= CARS_LANES) {
      callback?.({ ok: false, reason: 'Carril no valido.' });
      return;
    }

    cars.choices.set(player.id, lane);
    emitMatchState(room);
    maybeCloseCarsChoice(room);
    callback?.({ ok: true, lane });
  });

  socket.on('match:balloon-pump', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const balloon = room?.match?.specialRound?.balloon;

    if (!room || !player || !balloon || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay ningun globo en juego.' });
      return;
    }

    if (balloon.outcome) {
      callback?.({ ok: true, ignored: true, exploded: true });
      return;
    }

    if (balloon.currentPlayerId !== player.id) {
      callback?.({ ok: false, reason: 'No es tu turno.' });
      return;
    }

    if (balloon.stage !== 'pumping') {
      callback?.({ ok: false, reason: 'Espera a llegar a la palanca.' });
      return;
    }

    // El token (turno:palancazos) hace que un doble clic o un reintento solo cuente una vez.
    if (String(payload.turnToken || '') !== balloonTurnToken(balloon)) {
      callback?.({ ok: true, ignored: true, air: balloon.air });
      return;
    }

    pumpBalloon(room, player.id);
    callback?.({ ok: true, air: balloon.air, exploded: Boolean(balloon.outcome) });
  });

  socket.on('match:balloon-pass', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const balloon = room?.match?.specialRound?.balloon;

    if (!room || !player || !balloon || room.match.phase !== 'special-round' || balloon.outcome) {
      callback?.({ ok: false, reason: 'No hay ningun globo en juego.' });
      return;
    }

    // Un "pasar" de un turno anterior (reintento o doble clic) no puede saltarse al siguiente jugador.
    if (Number(payload.turnNumber) !== balloon.turnNumber || balloon.currentPlayerId !== player.id) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (balloon.stage !== 'pumping' || !balloon.pumpsThisTurn) {
      callback?.({ ok: false, reason: 'Dale al menos una vez a la palanca antes de pasar.' });
      return;
    }

    passBalloonTurn(room);
    callback?.({ ok: true });
  });

  socket.on('match:barrel-stop', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const barrels = room?.match?.specialRound?.barrels;
    const racer = barrels?.racers.get(player?.id);
    const now = Date.now();

    if (!room || !player || !barrels || !racer || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay barriles en juego.' });
      return;
    }

    if (String(payload.roundId || '') !== barrels.roundId) {
      callback?.({ ok: false, reason: 'Ese barril era de otra ronda.' });
      return;
    }

    // Idempotente: el primer resultado registrado es el que vale.
    if (racer.status !== 'falling') {
      callback?.({ ok: true, status: racer.status, height: racer.height, elapsedMs: racer.elapsedMs });
      return;
    }

    if (barrels.stage !== 'falling' || now < barrels.startsAt) {
      callback?.({ ok: false, reason: 'La ronda no esta en marcha.' });
      return;
    }

    const serverElapsed = now - barrels.startsAt;
    let elapsedMs = Number(payload.elapsedMs);

    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      callback?.({ ok: false, reason: 'Tiempo no valido.' });
      return;
    }

    // No se puede declarar una parada posterior al momento en que el mensaje llega al servidor
    // (con un margen para el desfase de reloj): impide "parar" el barril mas abajo de lo real.
    if (elapsedMs > serverElapsed + BARRELS_CLOCK_TOLERANCE_MS) {
      elapsedMs = serverElapsed;
    }

    const height = Math.round(barrelHeightAt(elapsedMs) * 100) / 100;
    racer.elapsedMs = Math.round(elapsedMs);

    if (elapsedMs >= BARRELS_FALL_MS || height <= 0) {
      racer.status = 'crushed';
      racer.height = 0;
    } else {
      racer.status = 'stopped';
      racer.height = height;
    }

    io.to(room.code).emit('match:barrels-update', {
      lobbyId: room.code,
      roundId: barrels.roundId,
      racer: { ...racer },
    });
    callback?.({ ok: true, status: racer.status, height: racer.height, elapsedMs: racer.elapsedMs });
    maybeResolveBarrels(room);
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
