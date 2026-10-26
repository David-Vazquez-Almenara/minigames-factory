const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
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
const WHO_QUESTIONS = require('./data/who-questions.json').questions;
const QUIZ_QUESTIONS = require('./data/quiz-questions.json').questions;

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
const PAINT_DRAWING_MS = 120000;
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
// Sin descripciones: el nombre del minijuego se ve este rato tras el titulo y se empieza a jugar.
const MINIGAME_NAME_ONLY_MS = 1300;
const MINIGAME_INTRO_MS = 4000;
const MINIGAME_READING_MS_PER_CHAR = 60;
const MINIGAME_INTRO_MAX_MS = 20000;
// El portavoz no tiene que pulsar nada: su cliente gira la ruleta 1 s despues de mostrarla y, si no lo hace
// (desconexion), el servidor la gira solo poco despues como respaldo.
const TEN_BUT_AUTO_SPIN_EXTRA_MS = 2500;
// Vuelta al lobby al terminar: el host primero y el resto 1 s despues de que el host confirme su lobby.
const LOBBY_RETURN_DELAY_MS = 1000;
// Si el host no pulsa "Ver marcador" cuando el minijuego ya tiene resultados, se pulsa solo pasado este tiempo.
const AUTO_SCOREBOARD_MS = 7000;
const LOBBY_RETURN_FALLBACK_MS = 12000;
const PINTURILLO_DRAW_MS = 90000;
const PINTURILLO_FRAME_MIN_GAP_MS = 150;
const PINTURILLO_MAX_FRAME_LENGTH = 450000;
const PINTURILLO_CHAT_HISTORY = 80;
const POGO_COUNTDOWN_MS = 3000;
const POGO_RACE_MS = 35000;
const POGO_GOAL = 30;
// Solo frena el spam: el cliente ya espera 500 ms entre ruletas, pero con la latencia variable de internet dos
// saltos legitimos pueden llegar mas juntos y no deben perderse.
const POGO_MIN_JUMP_GAP_MS = 250;
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
    title: 'Operaciones matemáticas',
    description:
      'Resuelve las operaciones. Cuantas más aciertes y más rápido termines, más puntos podrás ganar.',
    image: 'assets/minigames/math-operations.png',
    accent: '#d9f4ff',
    minPlayers: 1,
  },
  {
    id: 'paint',
    title: 'A Pintar',
    description:
      'Dibuja el objeto y vota después por la obra que más se parezca.',
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
      'El portavoz gira una ruleta del 1 al 10 y describe su número con una frase del tipo "es un 10, pero...". El resto tiene que adivinarlo.',
    image: 'assets/minigames/ten-but.png',
    accent: '#b9f7a7',
    minPlayers: 2,
  },
  {
    id: 'pinturillo',
    title: 'Pinturillo',
    description:
      'Un jugador dibuja y el resto la adivina por el chat. Cuanto antes la aciertes, más puntos.',
    image: 'assets/minigames/pinturillo.png',
    accent: '#ffb3b3',
    minPlayers: 2,
  },
  {
    id: 'pogo',
    title: 'Carrera en pogo',
    description:
      'Pulsa ESPACIO (o el botón) cuando la aguja pase por la zona marcada para saltar. La zona blanca vale el doble. Llega el primero a la meta.',
    image: 'assets/minigames/pogo.png',
    accent: '#d9f4ff',
    minPlayers: 2,
  },
  {
    id: 'blackjack',
    title: 'Blackjack',
    description:
      'Mesa de casino con 300 fichas para 3 manos. Gana al crupier sin pasarte de 21. Gana quien acabe con más fichas.',
    image: 'assets/minigames/blackjack.png',
    accent: '#b9f7a7',
    minPlayers: 2,
  },
  {
    id: 'barrels',
    title: 'Barriles',
    description:
      'Un barril cae sobre tu cabeza. Pulsa ESPACIO (o el botón) para pararlo lo más cerca posible de tu cabeza... sin que te aplaste.',
    image: 'assets/minigames/barrels.png',
    accent: '#ffe891',
    minPlayers: 2,
  },
  {
    id: 'cups',
    title: 'Cubiletes',
    description:
      'El crupier esconde una bola bajo uno de los 4 cubiletes y los mezcla. Cuando paren, tienes 15 segundos para elegir dónde está la bola.',
    image: 'assets/minigames/cups.png',
    accent: '#fff0a8',
    minPlayers: 2,
  },
  {
    id: 'cars',
    title: 'Esquiva los coches',
    description:
      'Elige uno de los 4 carriles y cruza los dedos. Gana quien aguante más rondas.',
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
  {
    id: 'dance',
    title: 'Pista de baile',
    description:
      'Pulsa las letras (o los colores) en el orden en que salen antes de que acabe el tiempo. Cada ronda la secuencia es más larga. Si te equivocas o no llegas a tiempo, quedas eliminado.',
    image: 'assets/minigames/dance.png',
    accent: '#d6c4ff',
    minPlayers: 2,
  },
  {
    id: 'count',
    title: '¿Cuántos hay?',
    description:
      'Desde el callejón ves pasar gente por la calle: andando, corriendo, en coche, en moto o en bici. Cuenta cuántas personas pasan. Gana quien más se acerque.',
    image: 'assets/minigames/count.png',
    accent: '#ffe0b3',
    minPlayers: 2,
  },
  {
    id: 'duel',
    title: 'Desenfundar',
    description:
      'Duelo contra el crupier. Cuando salga "¡YA!", dispara (ESPACIO o el botón) antes que él. Si disparas antes de tiempo, pierdes la ronda.',
    image: 'assets/minigames/duel.png',
    accent: '#f3d29b',
    minPlayers: 2,
  },
  {
    id: 'stopwatch',
    title: 'Para el cronómetro',
    description:
      'El cronómetro arranca y a los 3 segundos deja de verse. Páralo (ESPACIO o el botón) lo más cerca posible del tiempo que marca el panel.',
    image: 'assets/minigames/stopwatch.png',
    accent: '#bfe3ff',
    minPlayers: 2,
  },
  {
    id: 'tower',
    title: 'Torre de cajas',
    description:
      'Suelta la caja (ESPACIO o tocando la pantalla) justo encima de la torre: lo que sobresalga se corta. Tienes 45 segundos. Gana quien llegue más alto.',
    image: 'assets/minigames/tower.png',
    accent: '#c8f0d2',
    minPlayers: 2,
  },
  {
    id: 'beer',
    title: 'Jarras en la barra',
    description:
      '3 rondas. Para el medidor lo más cerca posible de la línea roja, que deja la jarra justo en el borde. Gana quien menos se quede del borde en total; cada jarra que tires resta 5 puntos.',
    image: 'assets/minigames/beer.png',
    accent: '#ffe2a8',
    minPlayers: 2,
  },
  {
    id: 'chop',
    title: 'Corta verduras',
    description:
      'Haz clic (o pulsa el botón) lo más rápido que puedas durante 10 segundos: cada 10 cortes, una verdura. Gana quien más verduras corte.',
    image: 'assets/minigames/chop.png',
    accent: '#d8f5c4',
    minPlayers: 2,
  },
  {
    id: 'swing',
    title: 'Salto con cuerda',
    description:
      'Por turnos, balancéate en la cuerda y suéltate (ESPACIO o el botón) en el momento justo. El ángulo decide hasta dónde llegas; si te sueltas yendo hacia atrás, restas metros.',
    image: 'assets/minigames/swing.png',
    accent: '#c9ecff',
    minPlayers: 2,
  },
  {
    id: 'golf',
    title: 'Mini golf',
    description:
      'Tres hoyos, un único golpe en cada uno. Arrastra hacia atrás desde cualquier sitio, como un tirachinas, para apuntar y elegir la fuerza, y suelta. Gana quien menos se aleje del hoyo en total.',
    image: 'assets/minigames/golf.png',
    accent: '#c8f0c0',
    minPlayers: 2,
  },
  {
    id: 'order',
    title: 'Memoriza el pedido',
    description:
      'Mira bien la hamburguesa que pide el cliente: después tendrás que montarla capa a capa en el mismo orden. Si te equivocas en una capa, pierdes la ronda.',
    image: 'assets/minigames/order.png',
    accent: '#ffe0a8',
    minPlayers: 2,
  },
  {
    id: 'bowling',
    title: 'Bolos',
    description:
      'Una sola tirada. Para el medidor de dirección y después el de efecto (ESPACIO o el botón). Gana quien más bolos derribe.',
    image: 'assets/minigames/bowling.png',
    accent: '#d9d4ff',
    minPlayers: 2,
  },
  {
    id: 'who',
    title: '¿Quién es quién?',
    description:
      'Tres preguntas comprometidas. Vota en secreto a quien mejor encaje (también a ti): si votas al más votado ganas 10 puntos; si hay empate, quien votó a uno de los empatados gana 5.',
    image: 'assets/minigames/who.png',
    accent: '#ffd1e8',
    minPlayers: 3,
  },
  {
    id: 'crossy',
    title: 'Cruza la carretera',
    description:
      'Avanza con las flechas (o WASD) esquivando coches y trenes: cuando la luz roja de la vía parpadea, viene un tren. Gana quien llegue más lejos en 40 s; si te atropellan, pierdes 5 puntos.',
    image: 'assets/minigames/crossy.png',
    accent: '#c8f5d0',
    minPlayers: 2,
  },
  {
    id: 'javelin',
    title: 'Tiro de jabalina',
    description:
      'Arrastra hacia atrás para elegir ángulo y fuerza y suelta. Tienes 3 jabalinas y 40 s: gana quien deje una más cerca de la bandera.',
    image: 'assets/minigames/javelin.png',
    accent: '#ffe7c2',
    minPlayers: 2,
  },
  {
    id: 'quiz',
    title: 'Preguntas y respuestas',
    description:
      'Tres preguntas de cultura general, cada vez más difíciles. Elige la respuesta correcta (A, B, C o D) en 15 s. Cada acierto vale 10 puntos.',
    image: 'assets/minigames/quiz.png',
    accent: '#cfe3ff',
    minPlayers: 2,
  },
  {
    id: 'push',
    title: 'Empujar',
    description:
      'Arrastra para elegir dirección y fuerza (puedes rectificar) y confirma. Todos salen a la vez: echa a los demás al agua. Desde la ronda 3 la pista se encoge: lo marcado en rojo se hunde en la ronda siguiente.',
    image: 'assets/minigames/push.png',
    accent: '#c6f1ff',
    minPlayers: 2,
  },
  {
    id: 'russian',
    title: 'Ruleta rusa',
    description:
      'Por turnos, coge el revólver: dispara o salta una bala y dispara la siguiente. Empieza con 1 bala y cada vez que alguien cae se recarga con una más (máximo 3). Gana quien sobreviva.',
    image: 'assets/minigames/russian.png',
    accent: '#ffd0c4',
    minPlayers: 2,
  },
  {
    id: 'bomb',
    title: 'Patata caliente',
    description:
      'Palabras encadenadas con una bomba: escribe una palabra que exista y empiece por la última, las dos o las tres últimas letras de la anterior (sin repetir) y pulsa Intro para pasarla. La mecha es secreta: ¡que no te explote en las manos!',
    image: 'assets/minigames/bomb.png',
    accent: '#ffe0a8',
    minPlayers: 2,
  },
  {
    id: 'cannon',
    title: 'Cañón',
    description:
      'Uno lleva el cañón desde la muralla y el resto elige en secreto una de las 4 zonas de abajo. Después el cañonero elige dónde disparar sin ver a nadie. 3 rondas: 10 puntos por ronda sobrevivida y el cañonero suma por cada uno que derriba.',
    image: 'assets/minigames/cannon.png',
    accent: '#d6e4ff',
    minPlayers: 2,
  },
  {
    id: 'bomberman',
    title: 'Bomberman',
    description:
      'Muévete con WASD o las flechas (o la cruceta) y pon bombas con Espacio o Intro. Explotan a los 5 s en cruz, rompen piedras y pueden soltar mejoras de alcance y de bombas. ¡Que no te pille ninguna! Gana el último en pie.',
    image: 'assets/minigames/bomberman.png',
    accent: '#c9f2c9',
    minPlayers: 2,
  },
  {
    id: 'snake',
    title: 'Snake',
    description:
      'Gira tu serpiente con las flechas, WASD o deslizando el dedo y come manzanas para crecer. Si chocas con la pared, con otra serpiente o contigo, quedas fuera. Gana quien aguante más; entre los que siguen, la más larga.',
    image: 'assets/minigames/snake.png',
    accent: '#aad751',
    minPlayers: 2,
  },
  {
    id: 'race',
    title: 'Carrera',
    description:
      'Carrera de coches a 2 vueltas. Acelera con ↑ o W, frena con ↓ o S y gira con ← → o A D (o con los botones). Por el césped vas más lento. Pasa por todos los puntos de control en orden en cada vuelta (si te saltas uno, la vuelta no cuenta). Gana quien llega primero; si no terminas a tiempo, -15.',
    image: 'assets/minigames/race.png',
    accent: '#ffd9a8',
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
    // Sin explicaciones: tras el titulo del minijuego se empieza a jugar directamente.
    skipDescriptions: Boolean(settings.skipDescriptions),
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

  // Minijuegos con plazos fijos: la pausa los desplaza (los temporizadores ya se desplazan aparte).
  const deadlines = [
    [specialRound.who, ['questionAt', 'voteStartsAt', 'voteEndsAt', 'nextRoundAt']],
    [specialRound.crossy, ['startsAt', 'endsAt']],
    [specialRound.javelin, ['startsAt', 'endsAt', 'zoomEndsAt']],
    [specialRound.quiz, ['questionAt', 'answerStartsAt', 'answerEndsAt', 'correctAt', 'nextRoundAt']],
    [specialRound.push, ['aimStartsAt', 'aimEndsAt', 'launchAt', 'nextRoundAt']],
    [specialRound.russian, ['turnStartsAt', 'arriveAt', 'decideStartsAt', 'decideEndsAt', 'nextAt']],
    // Mecha de la bomba: se desplaza el inicio y el final a la vez, asi la pausa no la consume.
    [specialRound.bomb, ['orbitEndsAt', 'passStartsAt', 'passEndsAt', 'typingStartsAt', 'explodeAt', 'nextAt']],
    [specialRound.cannon, ['chooseStartsAt', 'chooseEndsAt', 'aimEndsAt', 'fireAt', 'impactAt', 'nextAt']],
    [specialRound.bomberman, ['startsAt', 'endsAt']],
    [specialRound.snake, ['startsAt', 'endsAt']],
    [specialRound.race, ['startsAt', 'endsAt']],
    ...(specialRound.bomberman?.bombs || []).map((bomb) => [bomb, ['explodeAt']]),
  ];

  for (const [state, keys] of deadlines) {
    for (const key of state ? keys : []) {
      if (state[key]) {
        state[key] += shiftMs;
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
    skipDescription: Boolean(specialRound.skipDescription),
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
    dance: toPublicDance(specialRound.dance),
    count: toPublicCount(specialRound.count),
    duel: toPublicDuel(specialRound.duel),
    stopwatch: toPublicStopwatch(specialRound.stopwatch),
    tower: toPublicTower(specialRound.tower),
    beer: toPublicBeer(specialRound.beer),
    chop: toPublicChop(specialRound.chop),
    swing: toPublicSwing(specialRound.swing),
    golf: toPublicGolf(specialRound.golf),
    order: toPublicOrder(specialRound.order),
    bowling: toPublicBowling(specialRound.bowling),
    who: toPublicWho(specialRound.who),
    crossy: toPublicCrossy(specialRound.crossy),
    javelin: toPublicJavelin(specialRound.javelin),
    quiz: toPublicQuiz(specialRound.quiz),
    push: toPublicPush(specialRound.push),
    russian: toPublicRussian(specialRound.russian),
    bomb: toPublicBomb(specialRound.bomb),
    cannon: toPublicCannon(specialRound.cannon),
    bomberman: toPublicBomberman(specialRound.bomberman),
    snake: toPublicSnake(specialRound.snake),
    race: toPublicRace(specialRound.race),
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
    bomb: null,
    cannon: null,
  };

  if (!specialRound || !specialRound.participantIds.includes(playerId)) {
    return base;
  }

  // Patata caliente: solo quien tiene la bomba sabe cuando explota (para su propio reloj).
  const bomb = specialRound.bomb;

  if (bomb?.stage === 'typing' && bomb.holderId === playerId) {
    base.bomb = { turn: bomb.turn, explodeAt: bomb.explodeAt };
  }

  // Canon: los de abajo ven donde se pone cada uno; el canonero no lo sabe hasta el disparo.
  const cannon = specialRound.cannon;

  if (cannon && (cannon.stage === 'choosing' || cannon.stage === 'aiming') && cannon.cannoneerId !== playerId) {
    base.cannon = {
      round: cannon.round,
      picks:
        cannon.stage === 'aiming'
          ? cannon.positions.map((entry) => ({ playerId: entry.playerId, zone: entry.zone }))
          : [...cannon.picks.entries()].map(([id, zone]) => ({ playerId: id, zone })),
    };
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
 * Ciclos sin repeticion: en una partida no se repite ningun minijuego hasta que se han jugado todos los activos.
 * Entonces empieza un ciclo nuevo y vuelven a salir al azar entre todos (sin repetir de nuevo hasta completarlo).
 * Los ya jugados siguen apareciendo en la ruleta (para que se vea variedad), pero no pueden ser el ganador. Al
 * empezar un ciclo nuevo, el ultimo jugado no sale justo despues (si hay alternativa).
 */
function chooseMinigame(room, candidates) {
  const cycle = room.match?.cycleMinigameIds || [];
  let pool = candidates.filter((minigame) => !cycle.includes(minigame.id));

  if (!pool.length) {
    room.match.cycleMinigameIds = [];
    const last = cycle[cycle.length - 1];
    pool = candidates.length > 1 ? candidates.filter((minigame) => minigame.id !== last) : candidates;
  }

  return randomItem(pool);
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
  room.match.cycleMinigameIds = [...(room.match.cycleMinigameIds || []), winner.id];
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
  // Si el minijuego ya se jugo en esta partida, la explicacion dura lo minimo: ya la conocen.
  const playedMinigameIds = room.match.playedMinigameIds || (room.match.playedMinigameIds = new Set());
  // Con "sin descripciones" (opcion de la sala) solo se ve el titulo y el nombre del minijuego un momento.
  const skipDescription = Boolean(room.settings.skipDescriptions);
  const introMs = skipDescription
    ? MINIGAME_TITLE_MS + MINIGAME_NAME_ONLY_MS
    : playedMinigameIds.has(minigame.id)
      ? MINIGAME_INTRO_MS
      : minigameIntroMs(minigame.description);
  playedMinigameIds.add(minigame.id);

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
    skipDescription,
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
    dance: null,
    count: null,
    duel: null,
    stopwatch: null,
    tower: null,
    beer: null,
    chop: null,
    swing: null,
    golf: null,
    order: null,
    bowling: null,
    who: null,
    crossy: null,
    javelin: null,
    quiz: null,
    push: null,
    russian: null,
    bomb: null,
    cannon: null,
    bomberman: null,
    snake: null,
    race: null,
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
  } else if (minigame.id === 'dance') {
    setupDance(room);
  } else if (minigame.id === 'count') {
    setupCount(room);
  } else if (minigame.id === 'duel') {
    setupDuel(room);
  } else if (minigame.id === 'stopwatch') {
    setupStopwatch(room);
  } else if (minigame.id === 'tower') {
    setupTower(room);
  } else if (minigame.id === 'beer') {
    setupBeer(room);
  } else if (minigame.id === 'chop') {
    setupChop(room);
  } else if (minigame.id === 'swing') {
    setupSwing(room);
  } else if (minigame.id === 'golf') {
    setupGolf(room);
  } else if (minigame.id === 'order') {
    setupOrder(room);
  } else if (minigame.id === 'bowling') {
    setupBowling(room);
  } else if (minigame.id === 'who') {
    setupWho(room);
  } else if (minigame.id === 'crossy') {
    setupCrossy(room);
  } else if (minigame.id === 'javelin') {
    setupJavelin(room);
  } else if (minigame.id === 'quiz') {
    setupQuiz(room);
  } else if (minigame.id === 'push') {
    setupPush(room);
  } else if (minigame.id === 'russian') {
    setupRussian(room);
  } else if (minigame.id === 'bomb') {
    setupBomb(room);
  } else if (minigame.id === 'cannon') {
    setupCannon(room);
  } else if (minigame.id === 'bomberman') {
    setupBomberman(room);
  } else if (minigame.id === 'snake') {
    setupSnake(room);
  } else if (minigame.id === 'race') {
    setupRace(room);
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
// - Mesas de 4: con mas jugadores se juega por grupos de 4 (en orden de asiento). Todos los grupos apuestan a la
//   vez al empezar la mano (nadie puede ajustar su apuesta viendo a los grupos anteriores); despues cada grupo
//   recibe sus cartas y juega sus turnos y se sienta el siguiente. El crupier tiene una sola mano para toda la
//   ronda (se reparte con el primer grupo que juega) y la juega al final contra todos los grupos a la vez.
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

  startBlackjackBetting(room, extraDelayMs);
}

/**
 * Apuestas de la mano: todos los grupos apuestan a la vez (cada uno ve su mesa), asi nadie de un grupo posterior
 * puede ajustar su apuesta viendo como les ha ido a los grupos anteriores. Despues se juega grupo a grupo.
 */
function startBlackjackBetting(room, extraDelayMs = 0) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj) {
    return;
  }

  bj.stage = 'betting';
  bj.groupIndex = 0;
  bj.previousGroupIndex = null;
  bj.dealOrder = [];
  bj.dealStartedAt = null;
  bj.turnOrder = [];
  bj.turnIndex = -1;
  bj.currentPlayerId = null;
  bj.turnEndsAt = null;
  bj.turnLocked = false;
  bj.groupChangeEndsAt = null;
  bj.betEndsAt = Date.now() + Math.max(0, extraDelayMs) + BLACKJACK_BET_MS;

  for (const player of bj.players.values()) {
    // Sin fichas suficientes no se puede apostar: mira la mano desde su asiento.
    player.confirmed = player.chips < BLACKJACK_MIN_BET;
    player.status = player.confirmed ? 'broke' : 'betting';
  }

  setRoomTimer(room, 'blackjack', bj.betEndsAt, () => closeBlackjackBetting(room));
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

  if (bj.seats.filter((playerId) => activeIds.includes(playerId)).every((playerId) => bj.players.get(playerId)?.confirmed)) {
    closeBlackjackBetting(room);
  }
}

/** Primer grupo (desde `from`) en el que alguien ha apostado; -1 si no queda ninguno. */
function nextBlackjackGroupWithBets(bj, from) {
  for (let index = from; index < bj.groups.length; index += 1) {
    if (bj.groups[index].some((playerId) => bj.players.get(playerId).bet > 0)) {
      return index;
    }
  }

  return -1;
}

/** Se cierran las apuestas de todos y empieza a jugar el primer grupo con apuestas. */
function closeBlackjackBetting(room) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj || bj.stage !== 'betting') {
    return;
  }

  clearRoomTimer(room, 'blackjack');

  // Quien no confirmo a tiempo (o se desconecto) no juega esta mano. Quien aposto espera a que juegue su mesa.
  for (const player of bj.players.values()) {
    if (!player.confirmed) {
      player.confirmed = true;
      player.bet = 0;
    }

    if (player.status === 'betting' || player.status === 'ready') {
      player.status = player.bet > 0 ? 'queued' : 'sitting-out';
    }
  }

  const first = nextBlackjackGroupWithBets(bj, 0);

  // Nadie ha apostado: el crupier no juega y la mano se liquida sin mas.
  if (first < 0) {
    startBlackjackDealer(room);
    return;
  }

  bj.groupIndex = first;

  // Con varios grupos, cada uno estaba viendo su mesa: transicion hasta la mesa que empieza.
  if (bj.groups.length > 1) {
    bj.stage = 'group-change';
    bj.previousGroupIndex = null;
    bj.groupChangeEndsAt = Date.now() + BLACKJACK_GROUP_CHANGE_MS;
    setRoomTimer(room, 'blackjack', bj.groupChangeEndsAt, () => startBlackjackDeal(room));
    emitMatchState(room);
    return;
  }

  startBlackjackDeal(room);
}

/** Reparte al grupo que esta en la mesa (sus apuestas ya estan hechas). */
function startBlackjackDeal(room) {
  const bj = room.match?.specialRound?.blackjack;

  if (!bj || (bj.stage !== 'betting' && bj.stage !== 'group-change')) {
    return;
  }

  clearRoomTimer(room, 'blackjack');
  bj.groupChangeEndsAt = null;
  const group = blackjackGroup(bj);
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

  // Los grupos en los que nadie ha apostado no se sientan a la mesa.
  const nextGroup = nextBlackjackGroupWithBets(bj, bj.groupIndex + 1);

  if (nextGroup < 0) {
    startBlackjackDealer(room);
    return;
  }

  bj.stage = 'group-change';
  bj.previousGroupIndex = bj.groupIndex;
  bj.groupIndex = nextGroup;
  bj.groupChangeEndsAt = Date.now() + BLACKJACK_GROUP_CHANGE_MS;
  setRoomTimer(room, 'blackjack', bj.groupChangeEndsAt, () => startBlackjackDeal(room));
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
// - 4 rondas: el crupier mete la bola en un cubilete, los mezcla (cada ronda mas rapido) y despues hay 15 s para
//   elegir cubilete (sin confirmacion; se puede cambiar hasta que acaba el tiempo). Cada acierto suma 5 (max 20).
// - Los movimientos los genera el servidor (anfitrion de la sala) y los manda a todos, asi todos ven el mismo
//   patron. La posicion final de la bola no se envia hasta revelarla: solo se podria deducir del historial.
// - Movimientos: 'swap' intercambia los cubiletes de dos huecos; 'fake' amaga el cambio y los deja como estaban.

const CUPS_COUNT = 4;
const CUPS_ROUNDS = 4;
const CUPS_PLACE_MS = 2000;
const CUPS_VOTE_MS = 15000;
const CUPS_REVEAL_PAUSE_MS = 1000;
const CUPS_REVEAL_MS = 4200;
const CUPS_POINTS = 5;
const CUPS_FAKE_CHANCE = 0.25;
const CUPS_SPEEDS = [
  { moves: 6, moveMs: 760 },
  { moves: 13, moveMs: 230 },
  { moves: 15, moveMs: 190 },
  { moves: 17, moveMs: 150 },
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
    // Mientras se vota nadie ve que eligieron los demas (daria ventaja a los ultimos): solo quien ya ha votado.
    votes: cups.stage === 'voting' ? [] : [...cups.votes.entries()].map(([playerId, slot]) => ({ playerId, slot })),
    votedPlayerIds: [...cups.votes.keys()],
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

/* ------------------------------------------------------------------ */
/* Pista de baile                                                      */
/* ------------------------------------------------------------------ */
// - 5 rondas: en cada una hay que pulsar en orden una secuencia de letras (o de colores, en el modo por colores)
//   antes de que acabe el tiempo. Quien no la completa queda eliminado y se baja del escenario.
// - Todas las secuencias se publican desde el principio: el juego corre entero en el cliente, que solo avisa al
//   servidor cuando termina la secuencia o cuando se le acaba el tiempo. El servidor solo reparte quien cae.
// - Puntos como en los coches: quien mas aguanta gana 30 y el resto por escalera (el ultimo 0). Caer en la
//   primera ronda resta 10.

const DANCE_LENGTHS = [4, 7, 10, 15, 20];
// Todas las rondas duran lo mismo: lo que se complica es la longitud de la secuencia.
const DANCE_TIMES_MS = [15000, 15000, 15000, 15000, 15000];
const DANCE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Colores solidos del modo por colores (el cliente tiene la misma paleta en el mismo orden).
const DANCE_PALETTE_SIZE = 12;
// Antes de la ronda 1 se muestra el aviso del teclado / modo por colores; las siguientes llevan solo la cuenta atras.
const DANCE_FIRST_LEAD_MS = 10000;
const DANCE_LEAD_MS = 3500;
// Margen para que llegue el aviso de "terminado" de quien acaba justo al limite.
const DANCE_GRACE_MS = 1500;
// Tiempo minimo humano por pulsacion: completar mas rapido que esto no es creible.
const DANCE_MIN_MS_PER_KEY = 70;
const DANCE_CLAP_MS = 3000;
const DANCE_EXIT_MS = 3800;

function danceSequence(length, alphabetSize) {
  const sequence = [];

  // Sin dos seguidos iguales: asi cada paso de la lista se distingue del anterior.
  while (sequence.length < length) {
    const value = crypto.randomInt(alphabetSize);

    if (value !== sequence[sequence.length - 1]) {
      sequence.push(value);
    }
  }

  return sequence;
}

function setupDance(room) {
  const specialRound = room.match.specialRound;

  specialRound.dance = {
    stage: 'playing',
    round: 0,
    sequences: DANCE_LENGTHS.map((length) => ({
      letters: danceSequence(length, DANCE_LETTERS.length).map((index) => DANCE_LETTERS[index]),
      colors: danceSequence(length, DANCE_PALETTE_SIZE),
    })),
    alive: new Set(specialRound.participantIds),
    done: new Set(),
    eliminatedRound: new Map(),
    roundLosers: [],
    roundStartsAt: null,
    roundEndsAt: null,
    breakEndsAt: null,
    outcome: null,
  };

  startDanceRound(room, 1, specialRound.introEndsAt - Date.now() + DANCE_FIRST_LEAD_MS);
}

function startDanceRound(room, round, leadMs) {
  const dance = room.match?.specialRound?.dance;

  if (!dance) {
    return;
  }

  dance.round = round;
  dance.stage = 'playing';
  dance.done = new Set();
  dance.roundLosers = [];
  dance.breakEndsAt = null;
  dance.roundStartsAt = Date.now() + Math.max(0, leadMs);
  dance.roundEndsAt = dance.roundStartsAt + DANCE_TIMES_MS[round - 1];
  setRoomTimer(room, 'dance', dance.roundEndsAt + DANCE_GRACE_MS, () => closeDanceRound(room, round));
  emitMatchState(room);
}

function eliminateDancer(dance, playerId) {
  if (!dance.alive.delete(playerId)) {
    return;
  }

  dance.eliminatedRound.set(playerId, dance.round);
  dance.roundLosers.push(playerId);
}

function maybeCloseDanceRound(room) {
  const dance = room.match?.specialRound?.dance;

  if (
    dance?.stage === 'playing' &&
    [...dance.alive].filter((playerId) => room.players.get(playerId)?.active).every((playerId) => dance.done.has(playerId))
  ) {
    closeDanceRound(room, dance.round);
  }
}

function closeDanceRound(room, round) {
  const dance = room.match?.specialRound?.dance;

  if (!dance || dance.stage !== 'playing' || dance.round !== round) {
    return;
  }

  // Quien no ha terminado (o se ha desconectado) cae aqui.
  for (const playerId of [...dance.alive]) {
    if (!dance.done.has(playerId)) {
      eliminateDancer(dance, playerId);
    }
  }

  const participants = room.match.specialRound.participantIds.length;
  const over = round >= DANCE_LENGTHS.length || dance.alive.size === 0 || (participants > 1 && dance.alive.size <= 1);
  // Los supervivientes aplauden; si alguien ha caido, se espera a que salga del escenario.
  dance.stage = 'break';
  dance.breakEndsAt = Date.now() + (dance.roundLosers.length ? DANCE_EXIT_MS : DANCE_CLAP_MS);
  setRoomTimer(room, 'dance', dance.breakEndsAt, () => (over ? finishDance(room) : startDanceRound(room, round + 1, DANCE_LEAD_MS)));
  emitMatchState(room);
}

function finishDance(room) {
  const specialRound = room.match?.specialRound;
  const dance = specialRound?.dance;

  if (!dance || dance.outcome) {
    return;
  }

  clearRoomTimer(room, 'dance');
  dance.stage = 'finished';
  const reach = (playerId) => (dance.alive.has(playerId) ? Infinity : dance.eliminatedRound.get(playerId) || 0);
  const levels = [...new Set(specialRound.participantIds.map(reach))].sort((first, second) => second - first);
  const pointsFor = (playerId) => {
    if (dance.eliminatedRound.get(playerId) === 1) {
      return -10;
    }

    const index = levels.indexOf(reach(playerId));

    if (index === 0) {
      return 30;
    }

    if (index === levels.length - 1) {
      return 0;
    }

    return Math.min(30, Math.max(5, Math.round((30 * (1 - index / (levels.length - 1))) / 5) * 5));
  };

  const ranking = specialRound.participantIds
    .map((playerId) => ({
      playerId,
      playerName: room.players.get(playerId)?.name || '',
      survived: dance.alive.has(playerId),
      eliminatedRound: dance.eliminatedRound.get(playerId) || null,
      position: levels.indexOf(reach(playerId)) + 1,
      points: pointsFor(playerId),
    }))
    .sort((first, second) => first.position - second.position);
  dance.outcome = { ranking, rounds: dance.round };
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

function toPublicDance(dance) {
  if (!dance) {
    return null;
  }

  return {
    stage: dance.stage,
    round: dance.round,
    totalRounds: DANCE_LENGTHS.length,
    lengths: DANCE_LENGTHS,
    timesMs: DANCE_TIMES_MS,
    // Todas las secuencias desde el principio: el cliente juega sin esperar a nadie.
    sequences: dance.sequences,
    paletteSize: DANCE_PALETTE_SIZE,
    roundStartsAt: dance.roundStartsAt,
    roundEndsAt: dance.roundEndsAt,
    breakEndsAt: dance.breakEndsAt,
    alive: [...dance.alive],
    eliminated: [...dance.eliminatedRound.entries()].map(([playerId, round]) => ({ playerId, round })),
    roundLosers: dance.roundLosers,
    outcome: dance.outcome,
  };
}

/**
 * Puntos en escalera comunes a los minijuegos de clasificacion: el primer grupo gana `top`, el ultimo 0 y los de
 * en medio bajan de forma proporcional (redondeado a 5).
 */
function ladderPoints(levelIndex, levelCount, top = 30) {
  if (levelIndex === 0) {
    return top;
  }

  if (levelIndex >= levelCount - 1) {
    return 0;
  }

  return Math.min(top, Math.max(5, Math.round((top * (1 - levelIndex / (levelCount - 1))) / 5) * 5));
}

/* ------------------------------------------------------------------ */
/* ¿Cuantos hay?                                                       */
/* ------------------------------------------------------------------ */
// - Vista desde un callejon a una calle con dos aceras (3 carriles de paso cada una) y una carretera de dos
//   carriles (cada uno en un sentido). Pasan entre 5 y 40 personas: andando, corriendo o en coche, moto o bici
//   (una sola persona por vehiculo). Hay que decir cuantas han pasado.
// - El servidor genera el guion completo (quien pasa, cuando, por donde y a que velocidad) y lo publica al empezar:
//   cada cliente lo reproduce por su cuenta. En un carril de la carretera no entra un vehiculo hasta que sale el
//   anterior; en las aceras nadie alcanza al que va delante en su mismo carril.
// - Puntos en escalera por cercania al numero real (el mas cercano 30, el ultimo 0; sin respuesta, 0).

const COUNT_MIN = 5;
const COUNT_MAX = 40;
// Distancia (m) que recorre cada uno de punta a punta de la calle (nace y desaparece fuera de la vista).
const COUNT_TRAVEL = 24;
const COUNT_SPEEDS = { walk: 2.3, run: 4.8, bike: 5.5, moto: 9.5, car: 15 };
const COUNT_FAST_BOOST = { walk: 1.35, run: 1.3, bike: 1.35, moto: 1.3, car: 1.3 };
// Antes de empezar: travelling de la camara por el callejon y cuenta atras.
const COUNT_LEAD_MS = 6000;
const COUNT_TIME_BANNER_MS = 2200;
const COUNT_ANSWER_MS = 15000;
const COUNT_GRACE_MS = 1500;

function countTravelMs(speed) {
  return Math.round((COUNT_TRAVEL / speed) * 1000);
}

function buildCountSchedule(total) {
  // Carriles: 0-2 acera cercana, 3-5 acera del fondo, 'road-near' (derecha a izquierda) y 'road-far' (al reves).
  const laneDir = new Map([...Array(6).keys()].map((lane) => [lane, crypto.randomInt(2) ? 1 : -1]));
  laneDir.set('road-near', -1);
  laneDir.set('road-far', 1);
  const lastInLane = new Map();
  const schedule = [];
  let time = 400;

  const earliestFor = (lane, speed) => {
    const previous = lastInLane.get(lane);

    if (!previous) {
      return 0;
    }

    if (typeof lane === 'string') {
      // Carretera: hasta que no sale el vehiculo anterior no entra otro.
      return previous.exitAt + 250;
    }

    // Acera: dejar distancia con el de delante y no alcanzarle antes de que salga.
    const gapMs = (1.5 / previous.speed) * 1000;
    return Math.max(previous.at + gapMs, previous.exitAt + gapMs - countTravelMs(speed));
  };

  for (let index = 0; index < total; index += 1) {
    // Salidas muy seguidas: asi coinciden muchos a la vez en pantalla.
    time += 90 + crypto.randomInt(560);
    const pick = (onRoad) => {
      const kind = onRoad ? ['car', 'car', 'moto', 'moto', 'bike'][crypto.randomInt(5)] : crypto.randomInt(100) < 50 ? 'walk' : 'run';
      // Cada uno va a su ritmo normal o, al azar, algo mas rapido.
      const boost = crypto.randomInt(2) ? COUNT_FAST_BOOST[kind] : 1;
      const speed = COUNT_SPEEDS[kind] * boost * (0.92 + crypto.randomInt(17) / 100);
      const lanes = onRoad ? ['road-near', 'road-far'] : [...Array(6).keys()];
      // El carril que antes quede libre (sin esperar si alguno ya lo esta).
      const options = secureShuffle(lanes).map((lane) => ({ lane, earliest: earliestFor(lane, speed) }));
      return { kind, speed, chosen: options.reduce((best, option) => (option.earliest < best.earliest ? option : best)) };
    };
    let candidate = pick(crypto.randomInt(100) < 32);

    // Si la carretera esta ocupada no se espera al vehiculo: pasa alguien por la acera y la calle no se vacia.
    if (candidate.chosen.earliest > time && typeof candidate.chosen.lane === 'string') {
      candidate = pick(false);
    }

    const { kind, speed, chosen } = candidate;
    time = Math.max(time, Math.ceil(chosen.earliest));
    const exitAt = time + countTravelMs(speed);
    lastInLane.set(chosen.lane, { at: time, speed, exitAt });
    schedule.push({
      id: index,
      at: time,
      kind,
      lane: chosen.lane,
      dir: laneDir.get(chosen.lane),
      speed: Math.round(speed * 100) / 100,
      look: crypto.randomInt(1000),
    });
  }

  return schedule;
}

function setupCount(room) {
  const specialRound = room.match.specialRound;
  const total = COUNT_MIN + crypto.randomInt(COUNT_MAX - COUNT_MIN + 1);
  const schedule = buildCountSchedule(total);
  const watchStartsAt = specialRound.introEndsAt + COUNT_LEAD_MS;
  const watchEndsAt = watchStartsAt + Math.max(...schedule.map((entry) => entry.at + countTravelMs(entry.speed))) + 400;

  specialRound.count = {
    stage: 'watching',
    total,
    schedule,
    travel: COUNT_TRAVEL,
    watchStartsAt,
    watchEndsAt,
    answerEndsAt: watchEndsAt + COUNT_TIME_BANNER_MS + COUNT_ANSWER_MS,
    answers: new Map(),
    outcome: null,
  };

  setRoomTimer(room, 'count', watchEndsAt, () => {
    const count = room.match?.specialRound?.count;

    if (count?.stage === 'watching') {
      count.stage = 'answering';
      setRoomTimer(room, 'count', count.answerEndsAt + COUNT_GRACE_MS, () => finishCount(room));
      emitMatchState(room);
    }
  });
}

function maybeFinishCount(room) {
  const count = room.match?.specialRound?.count;

  if (count?.stage === 'answering' && getActiveParticipantIds(room, room.match.specialRound).every((playerId) => count.answers.has(playerId))) {
    finishCount(room);
  }
}

function finishCount(room) {
  const specialRound = room.match?.specialRound;
  const count = specialRound?.count;

  if (!count || count.outcome) {
    return;
  }

  clearRoomTimer(room, 'count');
  count.stage = 'reveal';
  const distance = (playerId) => (count.answers.has(playerId) ? Math.abs(count.answers.get(playerId) - count.total) : Infinity);
  const levels = [...new Set(specialRound.participantIds.map(distance))].sort((first, second) => first - second);
  const ranking = specialRound.participantIds
    .map((playerId) => ({
      playerId,
      playerName: room.players.get(playerId)?.name || '',
      answer: count.answers.has(playerId) ? count.answers.get(playerId) : null,
      distance: Number.isFinite(distance(playerId)) ? distance(playerId) : null,
      position: levels.indexOf(distance(playerId)) + 1,
      points: Number.isFinite(distance(playerId)) ? ladderPoints(levels.indexOf(distance(playerId)), levels.length) : 0,
    }))
    .sort((first, second) => first.position - second.position);
  count.outcome = { total: count.total, ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.distance === 0 ? 1 : 0,
    answeredCount: entry.answer === null ? 0 : 1,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicCount(count) {
  if (!count) {
    return null;
  }

  return {
    stage: count.stage,
    // El guion se publica entero (cada cliente lo reproduce); el total solo se anuncia al final.
    schedule: count.schedule,
    travel: count.travel,
    watchStartsAt: count.watchStartsAt,
    watchEndsAt: count.watchEndsAt,
    answerEndsAt: count.answerEndsAt,
    timeBannerMs: COUNT_TIME_BANNER_MS,
    answeredPlayerIds: [...count.answers.keys()],
    outcome: count.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Desenfundar                                                         */
/* ------------------------------------------------------------------ */
// - Duelo en una calle del oeste contra el crupier. 3 rondas: tras una espera al azar aparece "¡YA!" y hay que
//   disparar antes de que dispare el crupier (cada ronda mas rapido). Disparar antes de la senal es falta.
// - Cada cliente mide su propio tiempo de reaccion desde que ve la senal en su pantalla y solo envia el
//   resultado; el servidor lo apunta y al acabar la ronda reparte quien ha caido.
// - Clasificacion: rondas ganadas y, a igualdad, reaccion media mas rapida. Puntos en escalera (30 ... 0).

// Un solo duelo.
const DUEL_ROUNDS = 1;
const DUEL_DEALER_MS = [600];
const DUEL_FIRST_LEAD_MS = 3500;
const DUEL_LEAD_MS = 2000;
// Espera aleatoria antes de la senal (desde que empieza la ronda).
const DUEL_WAIT_MIN_MS = 2500;
const DUEL_WAIT_RANGE_MS = 3500;
// Margen para que lleguen los disparos tras el limite, y lo que dura el resultado en pantalla.
const DUEL_GRACE_MS = 900;
const DUEL_RESULT_MS = 4200;
const DUEL_MIN_REACTION_MS = 90;

function setupDuel(room) {
  const specialRound = room.match.specialRound;

  specialRound.duel = {
    stage: 'waiting',
    round: 0,
    roundStartsAt: null,
    signalAt: null,
    deadline: null,
    nextRoundAt: null,
    shots: new Map(),
    results: [],
    history: [],
    outcome: null,
  };

  startDuelRound(room, 1, specialRound.introEndsAt - Date.now() + DUEL_FIRST_LEAD_MS);
}

function startDuelRound(room, round, leadMs) {
  const duel = room.match?.specialRound?.duel;

  if (!duel) {
    return;
  }

  duel.round = round;
  duel.stage = 'waiting';
  duel.shots = new Map();
  duel.results = [];
  duel.nextRoundAt = null;
  duel.roundStartsAt = Date.now() + Math.max(0, leadMs);
  duel.signalAt = duel.roundStartsAt + DUEL_WAIT_MIN_MS + crypto.randomInt(DUEL_WAIT_RANGE_MS);
  duel.deadline = duel.signalAt + DUEL_DEALER_MS[round - 1];
  setRoomTimer(room, 'duel', duel.deadline + DUEL_GRACE_MS, () => resolveDuelRound(room, round));
  emitMatchState(room);
}

function resolveDuelRound(room, round) {
  const specialRound = room.match?.specialRound;
  const duel = specialRound?.duel;

  if (!duel || duel.round !== round || duel.stage !== 'waiting') {
    return;
  }

  const dealerMs = DUEL_DEALER_MS[round - 1];
  duel.results = specialRound.participantIds.map((playerId) => {
    const shot = duel.shots.get(playerId);
    const reactionMs = shot && !shot.foul ? shot.reactionMs : null;
    return { playerId, reactionMs, foul: Boolean(shot?.foul), hit: reactionMs !== null && reactionMs <= dealerMs };
  });
  duel.history.push({ round, dealerMs, results: duel.results });
  duel.stage = 'result';
  duel.nextRoundAt = Date.now() + DUEL_RESULT_MS;
  setRoomTimer(room, 'duel', duel.nextRoundAt, () => (round < DUEL_ROUNDS ? startDuelRound(room, round + 1, DUEL_LEAD_MS) : finishDuel(room)));
  emitMatchState(room);
}

function finishDuel(room) {
  const specialRound = room.match?.specialRound;
  const duel = specialRound?.duel;

  if (!duel || duel.outcome) {
    return;
  }

  clearRoomTimer(room, 'duel');
  duel.stage = 'finished';
  const stats = specialRound.participantIds.map((playerId) => {
    const hits = duel.history.flatMap((entry) => entry.results).filter((result) => result.playerId === playerId && result.hit);
    const averageMs = hits.length ? Math.round(hits.reduce((sum, result) => sum + result.reactionMs, 0) / hits.length) : null;
    return { playerId, wins: hits.length, averageMs, key: `${hits.length}:${averageMs ?? 0}` };
  });
  const ordered = [...stats].sort((first, second) => second.wins - first.wins || (first.averageMs ?? Infinity) - (second.averageMs ?? Infinity));
  const levels = [...new Set(ordered.map((entry) => entry.key))];
  const ranking = ordered.map((entry) => ({
    playerId: entry.playerId,
    playerName: room.players.get(entry.playerId)?.name || '',
    wins: entry.wins,
    averageMs: entry.averageMs,
    position: levels.indexOf(entry.key) + 1,
    points: entry.wins ? ladderPoints(levels.indexOf(entry.key), levels.length) : 0,
  }));
  duel.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.wins,
    answeredCount: DUEL_ROUNDS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicDuel(duel) {
  if (!duel) {
    return null;
  }

  return {
    stage: duel.stage,
    round: duel.round,
    totalRounds: DUEL_ROUNDS,
    dealerMs: DUEL_DEALER_MS[Math.max(0, duel.round - 1)],
    roundStartsAt: duel.roundStartsAt,
    signalAt: duel.signalAt,
    deadline: duel.deadline,
    nextRoundAt: duel.nextRoundAt,
    // Los disparos de los demas no se reparten hasta el final de la ronda.
    results: duel.results,
    history: duel.history,
    outcome: duel.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Para el cronometro                                                  */
/* ------------------------------------------------------------------ */
// - 3 rondas. Arriba sale el tiempo objetivo (p. ej. 08,0); el cronometro arranca y a los 3 s deja de verse.
//   Hay que pararlo lo mas cerca posible del objetivo. El cronometro corre en cada cliente y solo se envia el tiempo.
// - Gana quien menos error acumula; puntos en escalera (30 ... 0). Quien no para se lleva el error maximo.

// Una sola ronda, con un objetivo entre 6,0 y 12,0 s.
const STOPWATCH_ROUNDS = 1;
const STOPWATCH_TARGETS = [[60, 120]];
const STOPWATCH_VISIBLE_MS = 3000;
const STOPWATCH_MAX_ERROR_MS = 5000;
const STOPWATCH_FIRST_LEAD_MS = 3500;
const STOPWATCH_LEAD_MS = 3500;
const STOPWATCH_REVEAL_MS = 4500;

function setupStopwatch(room) {
  const specialRound = room.match.specialRound;

  specialRound.stopwatch = {
    stage: 'running',
    round: 0,
    targetMs: 0,
    startsAt: null,
    deadline: null,
    nextRoundAt: null,
    stops: new Map(),
    history: [],
    outcome: null,
  };

  startStopwatchRound(room, 1, specialRound.introEndsAt - Date.now() + STOPWATCH_FIRST_LEAD_MS);
}

function startStopwatchRound(room, round, leadMs) {
  const stopwatch = room.match?.specialRound?.stopwatch;

  if (!stopwatch) {
    return;
  }

  const [low, high] = STOPWATCH_TARGETS[round - 1];
  stopwatch.round = round;
  stopwatch.stage = 'running';
  stopwatch.stops = new Map();
  stopwatch.nextRoundAt = null;
  // Objetivo en decimas de segundo (p. ej. 8,3 s).
  stopwatch.targetMs = (low + crypto.randomInt(high - low + 1)) * 100;
  stopwatch.startsAt = Date.now() + Math.max(0, leadMs);
  stopwatch.deadline = stopwatch.startsAt + stopwatch.targetMs + STOPWATCH_MAX_ERROR_MS;
  setRoomTimer(room, 'stopwatch', stopwatch.deadline + 800, () => revealStopwatchRound(room, round));
  emitMatchState(room);
}

function maybeRevealStopwatch(room) {
  const stopwatch = room.match?.specialRound?.stopwatch;

  if (
    stopwatch?.stage === 'running' &&
    getActiveParticipantIds(room, room.match.specialRound).every((playerId) => stopwatch.stops.has(playerId))
  ) {
    revealStopwatchRound(room, stopwatch.round);
  }
}

function revealStopwatchRound(room, round) {
  const specialRound = room.match?.specialRound;
  const stopwatch = specialRound?.stopwatch;

  if (!stopwatch || stopwatch.round !== round || stopwatch.stage !== 'running') {
    return;
  }

  const results = specialRound.participantIds.map((playerId) => {
    const elapsedMs = stopwatch.stops.has(playerId) ? stopwatch.stops.get(playerId) : null;
    return {
      playerId,
      elapsedMs,
      errorMs: elapsedMs === null ? STOPWATCH_MAX_ERROR_MS : Math.min(STOPWATCH_MAX_ERROR_MS, Math.abs(elapsedMs - stopwatch.targetMs)),
    };
  });
  stopwatch.history.push({ round, targetMs: stopwatch.targetMs, results });
  stopwatch.stage = 'reveal';
  stopwatch.nextRoundAt = Date.now() + STOPWATCH_REVEAL_MS;
  setRoomTimer(room, 'stopwatch', stopwatch.nextRoundAt, () =>
    round < STOPWATCH_ROUNDS ? startStopwatchRound(room, round + 1, STOPWATCH_LEAD_MS) : finishStopwatch(room),
  );
  emitMatchState(room);
}

function finishStopwatch(room) {
  const specialRound = room.match?.specialRound;
  const stopwatch = specialRound?.stopwatch;

  if (!stopwatch || stopwatch.outcome) {
    return;
  }

  clearRoomTimer(room, 'stopwatch');
  stopwatch.stage = 'finished';
  const totals = specialRound.participantIds.map((playerId) => ({
    playerId,
    totalErrorMs: stopwatch.history.reduce((sum, entry) => sum + (entry.results.find((result) => result.playerId === playerId)?.errorMs ?? STOPWATCH_MAX_ERROR_MS), 0),
  }));
  const levels = [...new Set(totals.map((entry) => entry.totalErrorMs))].sort((first, second) => first - second);
  const ranking = totals
    .map((entry) => ({
      ...entry,
      playerName: room.players.get(entry.playerId)?.name || '',
      position: levels.indexOf(entry.totalErrorMs) + 1,
      points: ladderPoints(levels.indexOf(entry.totalErrorMs), levels.length),
    }))
    .sort((first, second) => first.position - second.position);
  stopwatch.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: 0,
    answeredCount: STOPWATCH_ROUNDS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicStopwatch(stopwatch) {
  if (!stopwatch) {
    return null;
  }

  return {
    stage: stopwatch.stage,
    round: stopwatch.round,
    totalRounds: STOPWATCH_ROUNDS,
    targetMs: stopwatch.targetMs,
    visibleMs: STOPWATCH_VISIBLE_MS,
    maxErrorMs: STOPWATCH_MAX_ERROR_MS,
    startsAt: stopwatch.startsAt,
    deadline: stopwatch.deadline,
    nextRoundAt: stopwatch.nextRoundAt,
    // Quien ya ha parado se sabe; su tiempo, solo al revelar la ronda.
    stoppedPlayerIds: [...stopwatch.stops.keys()],
    history: stopwatch.history,
    outcome: stopwatch.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Torre de cajas                                                      */
/* ------------------------------------------------------------------ */
// - Juego 2D de una sola partida de 45 s: una caja va y viene y hay que soltarla encima de la torre; lo que
//   sobresale se corta. Si no toca la torre, se acabo. Gana quien mas alto llega (aunque haya perdido antes).
// - Todo se juega en el cliente: solo envia su altura cada vez que coloca una caja (para que el resto la vea) y
//   si ha perdido. Puntos en escalera por altura (empates comparten puntos); quien no coloca ni una, -10.

const TOWER_LEAD_MS = 3500;
const TOWER_PLAY_MS = 45000;
const TOWER_GRACE_MS = 1500;
// Ritmo maximo creible (una caja cada 250 ms) para descartar alturas imposibles.
const TOWER_MIN_MS_PER_BOX = 250;

function setupTower(room) {
  const specialRound = room.match.specialRound;
  const startsAt = specialRound.introEndsAt + TOWER_LEAD_MS;

  specialRound.tower = {
    stage: 'playing',
    startsAt,
    endsAt: startsAt + TOWER_PLAY_MS,
    levels: new Map(specialRound.participantIds.map((playerId) => [playerId, 0])),
    lost: new Set(),
    finished: new Set(),
    outcome: null,
  };

  setRoomTimer(room, 'tower', startsAt + TOWER_PLAY_MS + TOWER_GRACE_MS, () => finishTower(room));
}

function maybeFinishTower(room) {
  const tower = room.match?.specialRound?.tower;

  if (tower?.stage === 'playing' && getActiveParticipantIds(room, room.match.specialRound).every((playerId) => tower.finished.has(playerId))) {
    finishTower(room);
  }
}

function finishTower(room) {
  const specialRound = room.match?.specialRound;
  const tower = specialRound?.tower;

  if (!tower || tower.outcome) {
    return;
  }

  clearRoomTimer(room, 'tower');
  tower.stage = 'finished';
  const levels = [...new Set(specialRound.participantIds.map((playerId) => tower.levels.get(playerId) || 0))].sort((first, second) => second - first);
  const ranking = specialRound.participantIds
    .map((playerId) => {
      const level = tower.levels.get(playerId) || 0;
      return {
        playerId,
        playerName: room.players.get(playerId)?.name || '',
        level,
        lost: tower.lost.has(playerId),
        position: levels.indexOf(level) + 1,
        points: level === 0 ? -10 : ladderPoints(levels.indexOf(level), levels.length),
      };
    })
    .sort((first, second) => first.position - second.position);
  tower.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.level,
    answeredCount: entry.level,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicTower(tower) {
  if (!tower) {
    return null;
  }

  return {
    stage: tower.stage,
    startsAt: tower.startsAt,
    endsAt: tower.endsAt,
    levels: [...tower.levels.entries()].map(([playerId, level]) => ({ playerId, level, lost: tower.lost.has(playerId), finished: tower.finished.has(playerId) })),
    outcome: tower.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Jarras en la barra                                                  */
/* ------------------------------------------------------------------ */
// - Juego de habilidad: la barra mide siempre lo mismo y la misma fuerza deja la jarra siempre en el mismo sitio.
//   El 80 % del medidor (marcado con una linea roja) la deja justo en el borde; por encima, se cae. El medidor
//   sube y baja muy rapido: hay que pararlo lo mas cerca posible de la linea sin pasarse.
// - El medidor corre en el cliente; solo se envia la fuerza. Cuando todos han lanzado se reparten las distancias
//   y cada cliente anima todas las jarras a la vez, frenando poco a poco hasta su punto final.
// - 3 rondas. En cada una se apunta lo que le falta a cada jarra para el borde (12 m menos lo que recorre); quien la
//   tira ese round cuenta como si no se hubiera movido (12 m). Gana quien menos suma en las 3.
// - Puntos en escalera por esa suma (el mejor 30, el ultimo 0) y -5 por cada jarra tirada.

const BEER_LENGTH = 12;
const BEER_ROUNDS = 3;
const BEER_FALL_PENALTY = 5;
const BEER_NEXT_ROUND_MS = 1800;
// Fuerza (0-1) que deja la jarra exactamente en el borde: la linea roja del medidor.
const BEER_PERFECT_POWER = 0.8;
// Metros que recorre la jarra con la fuerza maxima (asi el 80 % son justo los metros de la barra).
const BEER_REACH = BEER_LENGTH / BEER_PERFECT_POWER;
const BEER_LEAD_MS = 3000;
const BEER_AIM_MS = 12000;
const BEER_SLIDE_LEAD_MS = 1200;
const BEER_SLIDE_MS = 4500;
const BEER_RESULT_DELAY_MS = 1200;

function setupBeer(room) {
  const specialRound = room.match.specialRound;

  specialRound.beer = {
    stage: 'aiming',
    round: 0,
    length: BEER_LENGTH,
    reach: BEER_REACH,
    aimStartsAt: null,
    aimEndsAt: null,
    powers: new Map(),
    slideStartsAt: null,
    slideMs: BEER_SLIDE_MS,
    throws: [],
    history: [],
    outcome: null,
  };

  startBeerRound(room, 1, specialRound.introEndsAt + BEER_LEAD_MS);
}

/** Ronda nueva: todas las jarras vuelven a la salida y se vuelve a apuntar. */
function startBeerRound(room, round, aimStartsAt) {
  const beer = room.match?.specialRound?.beer;

  if (!beer) {
    return;
  }

  beer.round = round;
  beer.stage = 'aiming';
  beer.aimStartsAt = Math.max(Date.now(), aimStartsAt);
  beer.aimEndsAt = beer.aimStartsAt + BEER_AIM_MS;
  beer.powers = new Map();
  beer.slideStartsAt = null;
  beer.throws = [];
  setRoomTimer(room, 'beer', beer.aimEndsAt + 1000, () => startBeerSlide(room));
  emitMatchState(room);
}

function maybeStartBeerSlide(room) {
  const beer = room.match?.specialRound?.beer;

  if (beer?.stage === 'aiming' && getActiveParticipantIds(room, room.match.specialRound).every((playerId) => beer.powers.has(playerId))) {
    startBeerSlide(room);
  }
}

function startBeerSlide(room) {
  const specialRound = room.match?.specialRound;
  const beer = specialRound?.beer;

  if (!beer || beer.stage !== 'aiming') {
    return;
  }

  // Quien no ha lanzado (desconectado) desliza sin fuerza: se queda en la salida.
  beer.throws = specialRound.participantIds.map((playerId) => {
    const power = beer.powers.has(playerId) ? beer.powers.get(playerId) : 0;
    const distance = Math.round(power * beer.reach * 100) / 100;
    return { playerId, power, distance, fell: distance > beer.length, gap: Math.round((beer.length - distance) * 100) / 100 };
  });
  beer.stage = 'sliding';
  beer.slideStartsAt = Date.now() + BEER_SLIDE_LEAD_MS;
  const round = beer.round;
  setRoomTimer(room, 'beer', beer.slideStartsAt + BEER_SLIDE_MS + BEER_RESULT_DELAY_MS, () => {
    // Resultado de la ronda (se ve un momento) y despues la siguiente o el final.
    beer.history.push({ round, throws: beer.throws });
    beer.stage = 'result';
    setRoomTimer(room, 'beer', Date.now() + BEER_NEXT_ROUND_MS, () =>
      round < BEER_ROUNDS ? startBeerRound(room, round + 1, Date.now() + 1200) : finishBeer(room),
    );
    emitMatchState(room);
  });
  emitMatchState(room);
}

function finishBeer(room) {
  const specialRound = room.match?.specialRound;
  const beer = specialRound?.beer;

  if (!beer || beer.outcome) {
    return;
  }

  clearRoomTimer(room, 'beer');
  beer.stage = 'finished';
  // Suma de lo que se quedo del borde en cada ronda (tirarla cuenta como no haberse movido).
  const totals = specialRound.participantIds.map((playerId) => {
    const rounds = beer.history.map((entry) => entry.throws.find((row) => row.playerId === playerId)).filter(Boolean);
    const total = Math.round(rounds.reduce((sum, row) => sum + (row.fell ? BEER_LENGTH : row.gap), 0) * 100) / 100;
    return { playerId, total, falls: rounds.filter((row) => row.fell).length, rounds: rounds.map((row) => ({ gap: row.gap, fell: row.fell, distance: row.distance })) };
  });
  const levels = [...new Set(totals.map((entry) => entry.total))].sort((first, second) => first - second);
  const ranking = totals
    .map((entry) => ({
      ...entry,
      playerName: room.players.get(entry.playerId)?.name || '',
      position: levels.indexOf(entry.total) + 1,
      points: ladderPoints(levels.indexOf(entry.total), levels.length) - BEER_FALL_PENALTY * entry.falls,
    }))
    .sort((first, second) => first.position - second.position);
  beer.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: BEER_ROUNDS - entry.falls,
    answeredCount: BEER_ROUNDS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicBeer(beer) {
  if (!beer) {
    return null;
  }

  return {
    stage: beer.stage,
    round: beer.round,
    totalRounds: BEER_ROUNDS,
    fallPenalty: BEER_FALL_PENALTY,
    history: beer.history,
    length: beer.length,
    reach: beer.reach,
    perfectPower: BEER_PERFECT_POWER,
    aimStartsAt: beer.aimStartsAt,
    aimEndsAt: beer.aimEndsAt,
    thrownPlayerIds: [...beer.powers.keys()],
    slideStartsAt: beer.slideStartsAt,
    slideMs: beer.slideMs,
    // Las distancias solo se reparten cuando han lanzado todos (para animar todas las jarras a la vez).
    throws: beer.throws,
    outcome: beer.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Corta verduras                                                      */
/* ------------------------------------------------------------------ */
// - Clicker de 10 s en una cocina: cada 10 cortes, una verdura. Los clics se cuentan solo en el cliente; al
//   acabar, cada cliente envia cuantas verduras ha cortado (clics / 10) y 3 s despues salen los resultados.
// - Puntos en escalera por verduras (empates comparten); quien no corta ninguna, 0.

const CHOP_LEAD_MS = 4500;
const CHOP_PLAY_MS = 10000;
const CHOP_RESULT_PAUSE_MS = 3000;
// Tope creible: 20 clics por segundo durante los 10 s.
const CHOP_MAX_VEGGIES = 20;

function setupChop(room) {
  const specialRound = room.match.specialRound;
  const startsAt = specialRound.introEndsAt + CHOP_LEAD_MS;

  specialRound.chop = {
    stage: 'playing',
    startsAt,
    endsAt: startsAt + CHOP_PLAY_MS,
    resultsAt: startsAt + CHOP_PLAY_MS + CHOP_RESULT_PAUSE_MS,
    veggies: new Map(),
    outcome: null,
  };

  setRoomTimer(room, 'chop', specialRound.chop.resultsAt, () => finishChop(room));
}

function finishChop(room) {
  const specialRound = room.match?.specialRound;
  const chop = specialRound?.chop;

  if (!chop || chop.outcome) {
    return;
  }

  clearRoomTimer(room, 'chop');
  chop.stage = 'finished';
  const count = (playerId) => chop.veggies.get(playerId) || 0;
  const levels = [...new Set(specialRound.participantIds.map(count))].sort((first, second) => second - first);
  const ranking = specialRound.participantIds
    .map((playerId) => ({
      playerId,
      playerName: room.players.get(playerId)?.name || '',
      veggies: count(playerId),
      position: levels.indexOf(count(playerId)) + 1,
      points: count(playerId) ? ladderPoints(levels.indexOf(count(playerId)), levels.length) : 0,
    }))
    .sort((first, second) => first.position - second.position);
  chop.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.veggies,
    answeredCount: entry.veggies,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicChop(chop) {
  if (!chop) {
    return null;
  }

  return {
    stage: chop.stage,
    startsAt: chop.startsAt,
    endsAt: chop.endsAt,
    resultsAt: chop.resultsAt,
    reportedPlayerIds: [...chop.veggies.keys()],
    outcome: chop.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Salto con cuerda                                                    */
/* ------------------------------------------------------------------ */
// - Plataforma en lo alto de un arbol y una cuerda colgada de una rama. Por turnos (orden al azar), cada jugador
//   se balancea en media circunferencia y se suelta cuando quiere. Todos salen con la misma velocidad: el angulo
//   decide la distancia (a 45 grados hacia delante se llega mas lejos; soltarse yendo hacia atras resta metros).
// - El balanceo corre en el cliente con un reloj comun; el cliente envia el angulo y el sentido al soltarse y el
//   servidor calcula el salto con la misma fisica que el cliente (que ya lo esta animando).
// - Puntos en escalera por distancia (el mas lejos 30, el ultimo 0). Quien acaba en negativo, -15.

const SWING_PIVOT = { x: 1, y: 13.2 };
const SWING_ROPE = 4.5;
const SWING_SPEED = 14;
const SWING_GRAVITY = 9.8;
// Una ida y vuelta completa del balanceo (de un extremo al otro y vuelta): rapida.
const SWING_PERIOD_MS = 1500;
// Hasta donde sube la cuerda a cada lado de la vertical: 105 grados (15 por encima de la horizontal). Pasada la
// horizontal hacia delante, la cuerda ya vuelve hacia atras y el salto sale hacia atras (y al reves).
const SWING_AMPLITUDE = 105;
const SWING_WALK_MS = 1600;
const SWING_TURN_MS = 10000;
const SWING_AFTER_LANDING_MS = 3200;

/** Angulo de la cuerda (grados, 0 = vertical, +90 = horizontal hacia delante) y sentido en que se mueve. */
function swingAngleAt(elapsedMs) {
  const phase = (2 * Math.PI * elapsedMs) / SWING_PERIOD_MS;
  return { angle: SWING_AMPLITUDE * Math.sin(phase), dir: Math.cos(phase) >= 0 ? 1 : -1 };
}

/** Salto al soltarse: misma fisica en cliente y servidor. Distancia desde el tronco (x = 0). */
function swingJump(angleDeg, dir) {
  const angle = (Math.max(-SWING_AMPLITUDE, Math.min(SWING_AMPLITUDE, angleDeg)) * Math.PI) / 180;
  const x0 = SWING_PIVOT.x + SWING_ROPE * Math.sin(angle);
  const y0 = SWING_PIVOT.y - SWING_ROPE * Math.cos(angle);
  const vx = dir * SWING_SPEED * Math.cos(angle);
  const vy = dir * SWING_SPEED * Math.sin(angle);
  const time = (vy + Math.sqrt(vy * vy + 2 * SWING_GRAVITY * y0)) / SWING_GRAVITY;
  return { distance: Math.round((x0 + vx * time) * 100) / 100, flightMs: Math.round(time * 1000) };
}

function setupSwing(room) {
  const specialRound = room.match.specialRound;

  specialRound.swing = {
    stage: 'walking',
    order: secureShuffle(specialRound.participantIds),
    turnIndex: 0,
    walkStartsAt: null,
    swingStartsAt: null,
    swingEndsAt: null,
    flightStartsAt: null,
    nextTurnAt: null,
    jumps: [],
    outcome: null,
  };

  startSwingTurn(room, 0, specialRound.introEndsAt - Date.now() + 1500);
}

function startSwingTurn(room, turnIndex, leadMs = 0) {
  const swing = room.match?.specialRound?.swing;

  if (!swing) {
    return;
  }

  if (turnIndex >= swing.order.length) {
    finishSwing(room);
    return;
  }

  swing.turnIndex = turnIndex;
  swing.stage = 'walking';
  swing.walkStartsAt = Date.now() + Math.max(0, leadMs);
  swing.swingStartsAt = swing.walkStartsAt + SWING_WALK_MS;
  swing.swingEndsAt = swing.swingStartsAt + SWING_TURN_MS;
  swing.flightStartsAt = null;
  swing.nextTurnAt = null;
  setRoomTimer(room, 'swing', swing.swingStartsAt, () => {
    if (swing.turnIndex !== turnIndex || swing.stage !== 'walking') {
      return;
    }

    swing.stage = 'swinging';
    // Si no se suelta a tiempo (o se ha desconectado), se suelta solo donde este la cuerda.
    setRoomTimer(room, 'swing', swing.swingEndsAt + 1500, () => {
      const { angle, dir } = swingAngleAt(swing.swingEndsAt - swing.swingStartsAt);
      releaseSwing(room, turnIndex, angle, dir);
    });
    emitMatchState(room);
  });
  emitMatchState(room);
}

function releaseSwing(room, turnIndex, angle, dir) {
  const swing = room.match?.specialRound?.swing;

  if (!swing || swing.turnIndex !== turnIndex || swing.stage !== 'swinging') {
    return;
  }

  const playerId = swing.order[turnIndex];
  const { distance, flightMs } = swingJump(angle, dir);
  swing.jumps.push({ playerId, angle: Math.round(angle * 100) / 100, dir, distance, flightMs });
  swing.stage = 'flying';
  swing.flightStartsAt = Date.now();
  swing.nextTurnAt = swing.flightStartsAt + flightMs + SWING_AFTER_LANDING_MS;
  setRoomTimer(room, 'swing', swing.nextTurnAt, () => startSwingTurn(room, turnIndex + 1));
  emitMatchState(room);
}

function finishSwing(room) {
  const specialRound = room.match?.specialRound;
  const swing = specialRound?.swing;

  if (!swing || swing.outcome) {
    return;
  }

  clearRoomTimer(room, 'swing');
  swing.stage = 'finished';
  const distanceOf = (playerId) => swing.jumps.find((jump) => jump.playerId === playerId)?.distance ?? 0;
  const forward = specialRound.participantIds.filter((playerId) => distanceOf(playerId) >= 0);
  const levels = [...new Set(forward.map(distanceOf))].sort((first, second) => second - first);
  const ranking = specialRound.participantIds
    .map((playerId) => {
      const distance = distanceOf(playerId);
      const backwards = distance < 0;
      return {
        playerId,
        playerName: room.players.get(playerId)?.name || '',
        distance,
        backwards,
        position: backwards ? levels.length + 1 : levels.indexOf(distance) + 1,
        points: backwards ? -15 : ladderPoints(levels.indexOf(distance), levels.length),
      };
    })
    .sort((first, second) => first.position - second.position || second.distance - first.distance);
  swing.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.backwards ? 0 : 1,
    answeredCount: 1,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicSwing(swing) {
  if (!swing) {
    return null;
  }

  return {
    stage: swing.stage,
    order: swing.order,
    turnIndex: swing.turnIndex,
    currentPlayerId: swing.order[swing.turnIndex] || null,
    periodMs: SWING_PERIOD_MS,
    walkStartsAt: swing.walkStartsAt,
    swingStartsAt: swing.swingStartsAt,
    swingEndsAt: swing.swingEndsAt,
    flightStartsAt: swing.flightStartsAt,
    nextTurnAt: swing.nextTurnAt,
    jumps: swing.jumps,
    outcome: swing.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Mini golf                                                           */
/* ------------------------------------------------------------------ */
// - 2D, 3 rondas con 3 de los 20 mapas al azar. Un unico golpe por ronda (15 s para tirar; si no, cuenta como
//   fallo). La fisica es determinista y corre en el cliente: cada uno simula su golpe al momento y envia el tiro
//   (angulo y fuerza) y su resultado. Al tirar todos, se reparten los tiros y cada cliente simula las bolas de los
//   demas con la misma fisica (mismo recorrido exacto).
// - Gana quien menos distancia al hoyo acumula (meterla cuenta 0; no tirar cuenta como fallo). Escalera 30 ... 0.

// 10 hoyos sencillos y 10 dificiles (con rebotes): cada partida juega 3 al azar.
const GOLF_MAP_COUNT = 20;
const GOLF_ROUNDS = 3;
const GOLF_PREVIEW_MS = 2500;
const GOLF_AIM_MS = 15000;
const GOLF_ROLL_LEAD_MS = 600;
// Tope de lo que puede rodar una bola; la ronda real espera solo a la bola mas lenta (cada cliente lo envia).
const GOLF_ROLL_MS = 7000;
// Pausa para ver donde ha quedado cada bola antes de pasar de hoyo.
const GOLF_REVEAL_MS = 1000;
// Distancia que cuenta quien no tira (o la tira al agua): peor que cualquier tiro real.
const GOLF_MISS_DISTANCE = 1000;

function setupGolf(room) {
  const specialRound = room.match.specialRound;

  specialRound.golf = {
    stage: 'aiming',
    maps: secureShuffle([...Array(GOLF_MAP_COUNT).keys()]).slice(0, GOLF_ROUNDS),
    round: 0,
    aimStartsAt: null,
    aimEndsAt: null,
    rollStartsAt: null,
    nextRoundAt: null,
    shots: new Map(),
    history: [],
    outcome: null,
  };

  startGolfRound(room, 1, specialRound.introEndsAt - Date.now());
}

function startGolfRound(room, round, extraMs = 0) {
  const golf = room.match?.specialRound?.golf;

  if (!golf) {
    return;
  }

  golf.round = round;
  golf.stage = 'aiming';
  golf.shots = new Map();
  golf.aimStartsAt = Date.now() + Math.max(0, extraMs) + GOLF_PREVIEW_MS;
  golf.aimEndsAt = golf.aimStartsAt + GOLF_AIM_MS;
  golf.rollStartsAt = null;
  golf.nextRoundAt = null;
  setRoomTimer(room, 'golf', golf.aimEndsAt + 1000, () => revealGolfRound(room, round));
  emitMatchState(room);
}

function maybeRevealGolf(room) {
  const golf = room.match?.specialRound?.golf;

  if (golf?.stage === 'aiming' && getActiveParticipantIds(room, room.match.specialRound).every((playerId) => golf.shots.has(playerId))) {
    revealGolfRound(room, golf.round);
  }
}

function revealGolfRound(room, round) {
  const specialRound = room.match?.specialRound;
  const golf = specialRound?.golf;

  if (!golf || golf.round !== round || golf.stage !== 'aiming') {
    return;
  }

  const shots = specialRound.participantIds.map((playerId) => {
    const shot = golf.shots.get(playerId);
    return shot ? { playerId, ...shot, missed: false } : { playerId, angle: 0, power: 0, holed: false, distance: GOLF_MISS_DISTANCE, missed: true };
  });
  golf.history.push({ round, map: golf.maps[round - 1], shots });
  golf.stage = 'rolling';
  golf.rollStartsAt = Date.now() + GOLF_ROLL_LEAD_MS;
  // Solo se espera a que pare la bola mas lenta (las demas salen todas a la vez en rollStartsAt).
  const slowestRollMs = Math.max(0, ...shots.filter((shot) => !shot.missed).map((shot) => shot.rollMs ?? GOLF_ROLL_MS));
  golf.nextRoundAt = golf.rollStartsAt + slowestRollMs + GOLF_REVEAL_MS;
  setRoomTimer(room, 'golf', golf.nextRoundAt, () => (round < GOLF_ROUNDS ? startGolfRound(room, round + 1) : finishGolf(room)));
  emitMatchState(room);
}

function finishGolf(room) {
  const specialRound = room.match?.specialRound;
  const golf = specialRound?.golf;

  if (!golf || golf.outcome) {
    return;
  }

  clearRoomTimer(room, 'golf');
  golf.stage = 'finished';
  const totals = specialRound.participantIds.map((playerId) => {
    const shots = golf.history.map((entry) => entry.shots.find((shot) => shot.playerId === playerId));
    return {
      playerId,
      total: Math.round(shots.reduce((sum, shot) => sum + (shot ? (shot.holed ? 0 : shot.distance) : GOLF_MISS_DISTANCE), 0)),
      holes: shots.filter((shot) => shot?.holed).length,
    };
  });
  const levels = [...new Set(totals.map((entry) => entry.total))].sort((first, second) => first - second);
  const ranking = totals
    .map((entry) => ({
      ...entry,
      playerName: room.players.get(entry.playerId)?.name || '',
      position: levels.indexOf(entry.total) + 1,
      points: ladderPoints(levels.indexOf(entry.total), levels.length),
    }))
    .sort((first, second) => first.position - second.position);
  golf.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.holes,
    answeredCount: GOLF_ROUNDS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicGolf(golf) {
  if (!golf) {
    return null;
  }

  return {
    stage: golf.stage,
    round: golf.round,
    totalRounds: GOLF_ROUNDS,
    map: golf.maps[Math.max(0, golf.round - 1)],
    aimStartsAt: golf.aimStartsAt,
    aimEndsAt: golf.aimEndsAt,
    rollStartsAt: golf.rollStartsAt,
    rollMs: GOLF_ROLL_MS,
    nextRoundAt: golf.nextRoundAt,
    shotPlayerIds: [...golf.shots.keys()],
    // Los tiros de los demas solo se reparten cuando han tirado todos.
    history: golf.history,
    outcome: golf.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Memoriza el pedido                                                  */
/* ------------------------------------------------------------------ */
// - 3 rondas: se ve una hamburguesa unos segundos y despues hay que montarla capa a capa en el mismo orden.
//   Cada ronda lleva mas ingredientes y se ve menos tiempo en proporcion. Equivocarse en una capa pierde la ronda.
// - Todo en el cliente; al acabar cada ronda envia si la ha completado y cuanto ha tardado.
// - Clasificacion: rondas completadas y, a igualdad, menos tiempo total. Escalera 30 ... 0.

const ORDER_INGREDIENTS = 8;
const ORDER_LAYERS = [4, 6, 8];
const ORDER_SHOW_MS = [5000, 5500, 6500];
const ORDER_BUILD_MS = 20000;
const ORDER_LEAD_MS = 2500;
const ORDER_REVEAL_MS = 3000;

function setupOrder(room) {
  const specialRound = room.match.specialRound;

  specialRound.order = {
    stage: 'showing',
    recipes: ORDER_LAYERS.map((layers) => {
      const recipe = [];

      // Sin dos capas iguales seguidas (para que el orden sea claro).
      while (recipe.length < layers) {
        const value = crypto.randomInt(ORDER_INGREDIENTS);

        if (value !== recipe[recipe.length - 1]) {
          recipe.push(value);
        }
      }

      return recipe;
    }),
    round: 0,
    showStartsAt: null,
    buildStartsAt: null,
    buildEndsAt: null,
    nextRoundAt: null,
    reports: new Map(),
    history: [],
    outcome: null,
  };

  startOrderRound(room, 1, specialRound.introEndsAt - Date.now());
}

function startOrderRound(room, round, extraMs = 0) {
  const order = room.match?.specialRound?.order;

  if (!order) {
    return;
  }

  order.round = round;
  order.stage = 'showing';
  order.reports = new Map();
  order.showStartsAt = Date.now() + Math.max(0, extraMs) + ORDER_LEAD_MS;
  order.buildStartsAt = order.showStartsAt + ORDER_SHOW_MS[round - 1];
  order.buildEndsAt = order.buildStartsAt + ORDER_BUILD_MS;
  order.nextRoundAt = null;
  setRoomTimer(room, 'order', order.buildEndsAt + 1000, () => closeOrderRound(room, round));
  emitMatchState(room);
}

function maybeCloseOrderRound(room) {
  const order = room.match?.specialRound?.order;

  if (order && order.stage === 'showing' && getActiveParticipantIds(room, room.match.specialRound).every((playerId) => order.reports.has(playerId))) {
    closeOrderRound(room, order.round);
  }
}

function closeOrderRound(room, round) {
  const specialRound = room.match?.specialRound;
  const order = specialRound?.order;

  if (!order || order.round !== round || order.stage !== 'showing') {
    return;
  }

  order.history.push({
    round,
    results: specialRound.participantIds.map((playerId) => ({ playerId, ...(order.reports.get(playerId) || { success: false, ms: ORDER_BUILD_MS }) })),
  });
  order.stage = 'reveal';
  order.nextRoundAt = Date.now() + ORDER_REVEAL_MS;
  setRoomTimer(room, 'order', order.nextRoundAt, () => (round < ORDER_LAYERS.length ? startOrderRound(room, round + 1) : finishOrder(room)));
  emitMatchState(room);
}

function finishOrder(room) {
  const specialRound = room.match?.specialRound;
  const order = specialRound?.order;

  if (!order || order.outcome) {
    return;
  }

  clearRoomTimer(room, 'order');
  order.stage = 'finished';
  const stats = specialRound.participantIds.map((playerId) => {
    const results = order.history.map((entry) => entry.results.find((result) => result.playerId === playerId)).filter(Boolean);
    const done = results.filter((result) => result.success);
    return { playerId, completed: done.length, totalMs: done.reduce((sum, result) => sum + result.ms, 0) };
  });
  const keyOf = (entry) => `${entry.completed}:${entry.totalMs}`;
  const ordered = [...stats].sort((first, second) => second.completed - first.completed || first.totalMs - second.totalMs);
  const levels = [...new Set(ordered.map(keyOf))];
  const ranking = ordered.map((entry) => ({
    ...entry,
    playerName: room.players.get(entry.playerId)?.name || '',
    position: levels.indexOf(keyOf(entry)) + 1,
    points: entry.completed ? ladderPoints(levels.indexOf(keyOf(entry)), levels.length) : 0,
  }));
  order.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.completed,
    answeredCount: ORDER_LAYERS.length,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicOrder(order) {
  if (!order) {
    return null;
  }

  return {
    stage: order.stage,
    round: order.round,
    totalRounds: ORDER_LAYERS.length,
    ingredientCount: ORDER_INGREDIENTS,
    recipe: order.recipes[Math.max(0, order.round - 1)],
    showStartsAt: order.showStartsAt,
    buildStartsAt: order.buildStartsAt,
    buildEndsAt: order.buildEndsAt,
    nextRoundAt: order.nextRoundAt,
    reportedPlayerIds: [...order.reports.keys()],
    history: order.history,
    outcome: order.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Bolos                                                               */
/* ------------------------------------------------------------------ */
// - Bolera 3D, una tirada por jugador y todos a la vez. Cada jugador para dos medidores (direccion y efecto) y su
//   cliente simula la bola y los bolos (fisica completa en su pista). Solo envia cuantos bolos ha tirado.
// - Cuando han tirado todos, se reparten los bolos de cada uno y en las pistas de los demas se ve una tirada normal
//   que derriba ese numero de bolos. Escalera por bolos (empates comparten); 0 bolos, 0 puntos.

const BOWLING_LEAD_MS = 4000;
const BOWLING_AIM_MS = 15000;
const BOWLING_ROLL_LEAD_MS = 800;
const BOWLING_ROLL_MS = 6500;

function setupBowling(room) {
  const specialRound = room.match.specialRound;
  const aimStartsAt = specialRound.introEndsAt + BOWLING_LEAD_MS;

  specialRound.bowling = {
    stage: 'aiming',
    aimStartsAt,
    aimEndsAt: aimStartsAt + BOWLING_AIM_MS,
    throws: new Map(),
    rollStartsAt: null,
    results: [],
    outcome: null,
  };

  setRoomTimer(room, 'bowling', aimStartsAt + BOWLING_AIM_MS + 1500, () => startBowlingRoll(room));
}

function maybeStartBowlingRoll(room) {
  const bowling = room.match?.specialRound?.bowling;

  if (bowling?.stage === 'aiming' && getActiveParticipantIds(room, room.match.specialRound).every((playerId) => bowling.throws.has(playerId))) {
    startBowlingRoll(room);
  }
}

function startBowlingRoll(room) {
  const specialRound = room.match?.specialRound;
  const bowling = specialRound?.bowling;

  if (!bowling || bowling.stage !== 'aiming') {
    return;
  }

  bowling.results = specialRound.participantIds.map((playerId) => ({ playerId, pins: bowling.throws.get(playerId)?.pins ?? 0 }));
  bowling.stage = 'rolling';
  bowling.rollStartsAt = Date.now() + BOWLING_ROLL_LEAD_MS;
  setRoomTimer(room, 'bowling', bowling.rollStartsAt + BOWLING_ROLL_MS, () => finishBowling(room));
  emitMatchState(room);
}

function finishBowling(room) {
  const specialRound = room.match?.specialRound;
  const bowling = specialRound?.bowling;

  if (!bowling || bowling.outcome) {
    return;
  }

  clearRoomTimer(room, 'bowling');
  bowling.stage = 'finished';
  const levels = [...new Set(bowling.results.map((entry) => entry.pins))].sort((first, second) => second - first);
  const ranking = bowling.results
    .map((entry) => ({
      ...entry,
      playerName: room.players.get(entry.playerId)?.name || '',
      position: levels.indexOf(entry.pins) + 1,
      points: entry.pins ? ladderPoints(levels.indexOf(entry.pins), levels.length) : 0,
    }))
    .sort((first, second) => first.position - second.position);
  bowling.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.pins,
    answeredCount: 10,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicBowling(bowling) {
  if (!bowling) {
    return null;
  }

  return {
    stage: bowling.stage,
    aimStartsAt: bowling.aimStartsAt,
    aimEndsAt: bowling.aimEndsAt,
    thrownPlayerIds: [...bowling.throws.keys()],
    rollStartsAt: bowling.rollStartsAt,
    rollMs: BOWLING_ROLL_MS,
    // Los bolos de cada uno solo se reparten cuando han tirado todos.
    results: bowling.results,
    outcome: bowling.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* ¿Quien es quien?                                                    */
/* ------------------------------------------------------------------ */
// - 3 rondas con preguntas al azar ("¿Quien llegaria tarde a su propia boda?"). Cada uno vota en secreto a otro
//   jugador (15 s). El mas votado de la ronda "gana" la pregunta: quien le voto suma 10 puntos; si hay empate entre
//   los mas votados, quien voto a cualquiera de ellos suma 5. Sin votar, 0. Maximo 30 puntos.

const WHO_ROUNDS = 3;
const WHO_QUESTION_MS = 2500;
const WHO_VOTE_MS = 15000;
const WHO_REVEAL_MS = 6500;

function setupWho(room) {
  const specialRound = room.match.specialRound;

  specialRound.who = {
    stage: 'question',
    questions: secureShuffle(WHO_QUESTIONS).slice(0, WHO_ROUNDS),
    round: 0,
    questionAt: null,
    voteStartsAt: null,
    voteEndsAt: null,
    nextRoundAt: null,
    votes: new Map(),
    history: [],
    outcome: null,
  };

  startWhoRound(room, 1, specialRound.introEndsAt - Date.now());
}

function startWhoRound(room, round, extraMs = 0) {
  const who = room.match?.specialRound?.who;

  if (!who) {
    return;
  }

  who.round = round;
  who.stage = 'question';
  who.votes = new Map();
  who.questionAt = Date.now() + Math.max(0, extraMs);
  who.voteStartsAt = who.questionAt + WHO_QUESTION_MS;
  who.voteEndsAt = who.voteStartsAt + WHO_VOTE_MS;
  who.nextRoundAt = null;
  setRoomTimer(room, 'who', who.voteStartsAt, () => {
    if (who.round === round && who.stage === 'question') {
      who.stage = 'voting';
      setRoomTimer(room, 'who', who.voteEndsAt + 500, () => revealWhoRound(room, round));
      emitMatchState(room);
    }
  });
  emitMatchState(room);
}

function maybeRevealWho(room) {
  const who = room.match?.specialRound?.who;

  if (who?.stage === 'voting' && getActiveParticipantIds(room, room.match.specialRound).every((playerId) => who.votes.has(playerId))) {
    revealWhoRound(room, who.round);
  }
}

function revealWhoRound(room, round) {
  const specialRound = room.match?.specialRound;
  const who = specialRound?.who;

  if (!who || who.round !== round || who.stage !== 'voting') {
    return;
  }

  const tally = new Map();

  for (const target of who.votes.values()) {
    tally.set(target, (tally.get(target) || 0) + 1);
  }

  const top = Math.max(0, ...tally.values());
  const chosen = top ? [...tally.entries()].filter(([, count]) => count === top).map(([playerId]) => playerId) : [];
  const award = chosen.length === 1 ? 10 : chosen.length > 1 ? 5 : 0;
  const votes = [...who.votes.entries()].map(([voterId, targetId]) => ({ voterId, targetId }));
  const points = specialRound.participantIds.map((playerId) => ({
    playerId,
    points: who.votes.has(playerId) && chosen.includes(who.votes.get(playerId)) ? award : 0,
  }));
  who.history.push({ round, question: who.questions[round - 1], votes, tally: [...tally.entries()].map(([playerId, count]) => ({ playerId, count })), chosen, points });
  who.stage = 'reveal';
  who.nextRoundAt = Date.now() + WHO_REVEAL_MS;
  setRoomTimer(room, 'who', who.nextRoundAt, () => (round < WHO_ROUNDS ? startWhoRound(room, round + 1) : finishWho(room)));
  emitMatchState(room);
}

function finishWho(room) {
  const specialRound = room.match?.specialRound;
  const who = specialRound?.who;

  if (!who || who.outcome) {
    return;
  }

  clearRoomTimer(room, 'who');
  who.stage = 'finished';
  const ranking = specialRound.participantIds
    .map((playerId) => {
      const total = who.history.reduce((sum, entry) => sum + (entry.points.find((row) => row.playerId === playerId)?.points || 0), 0);
      const hits = who.history.filter((entry) => (entry.points.find((row) => row.playerId === playerId)?.points || 0) > 0).length;
      return { playerId, playerName: room.players.get(playerId)?.name || '', points: total, hits };
    })
    .sort((first, second) => second.points - first.points);
  who.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.hits,
    answeredCount: WHO_ROUNDS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicWho(who) {
  if (!who) {
    return null;
  }

  return {
    stage: who.stage,
    round: who.round,
    totalRounds: WHO_ROUNDS,
    question: who.questions[Math.max(0, who.round - 1)],
    questionAt: who.questionAt,
    voteStartsAt: who.voteStartsAt,
    voteEndsAt: who.voteEndsAt,
    nextRoundAt: who.nextRoundAt,
    // A quien vota cada uno no se sabe hasta el final de la ronda; solo quien ha votado ya.
    votedPlayerIds: [...who.votes.keys()],
    history: who.history,
    outcome: who.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Cruza la carretera                                                  */
/* ------------------------------------------------------------------ */
// - Tipo Crossy Road: cuadricula de 9 columnas y filas de cesped (seguro, con arboles), carretera (coches a distintas
//   velocidades) y via de tren (trenes muy rapidos avisados con una luz roja). 40 s para llegar lo mas lejos posible.
// - El nivel lo genera el servidor; los coches y trenes se mueven con formulas deterministas sobre el reloj comun, asi
//   cada cliente detecta sus atropellos al instante. Cada cliente envia su posicion como mucho cada 500 ms y el resto la
//   ve interpolada.
// - Clasificacion: quien llega a la meta antes; despues, la fila mas lejana. Escalera 30 ... 0 y -5 si te atropellan.

const CROSSY_COLS = 9;
const CROSSY_FINISH_ROW = 60;
const CROSSY_LEAD_MS = 3500;
const CROSSY_PLAY_MS = 40000;
const CROSSY_GRACE_MS = 1500;
// Ritmo maximo creible de saltos (para descartar posiciones imposibles).
const CROSSY_MIN_MS_PER_HOP = 90;
const CROSSY_WRAP = 16;
const CROSSY_CAR_SPEEDS = [1.8, 3.2, 5.4];

function buildCrossyRows() {
  const rows = [];
  let roadRun = 0;

  for (let row = 0; row <= CROSSY_FINISH_ROW; row += 1) {
    const previous = rows[row - 1]?.type;
    let type = 'grass';

    if (row > 2 && row < CROSSY_FINISH_ROW) {
      const roll = crypto.randomInt(100);
      type = roll < 52 ? 'road' : roll < 72 && previous !== 'rail' ? 'rail' : 'grass';

      if (type === 'road' && roadRun >= 4) {
        type = 'grass';
      }
    }

    roadRun = type === 'road' ? roadRun + 1 : 0;

    if (type === 'road') {
      const count = 1 + crypto.randomInt(3);
      const length = crypto.randomInt(4) === 0 ? 2 : 1.4;
      const base = crypto.randomInt(1000) / 1000;
      rows.push({
        type,
        dir: crypto.randomInt(2) ? 1 : -1,
        speed: CROSSY_CAR_SPEEDS[crypto.randomInt(CROSSY_CAR_SPEEDS.length)] * (0.9 + crypto.randomInt(21) / 100),
        length,
        // Posiciones de partida repartidas por todo el carril (que vuelve a empezar cada CROSSY_WRAP columnas).
        cars: Array.from({ length: count }, (_unused, index) => Math.round(((base + index / count) % 1) * CROSSY_WRAP * 100) / 100),
        color: crypto.randomInt(8),
      });
    } else if (type === 'rail') {
      rows.push({ type, dir: crypto.randomInt(2) ? 1 : -1, periodMs: 4500 + crypto.randomInt(3500), offsetMs: crypto.randomInt(4000) });
    } else {
      // Arboles en el cesped (nunca en la salida ni en la meta, y siempre con hueco de sobra para pasar).
      const trees = row > 2 && row < CROSSY_FINISH_ROW ? secureShuffle([...Array(CROSSY_COLS).keys()].map((col) => col - 4)).slice(0, crypto.randomInt(4)) : [];
      rows.push({ type, trees });
    }
  }

  return rows;
}

function setupCrossy(room) {
  const specialRound = room.match.specialRound;
  const startsAt = specialRound.introEndsAt + CROSSY_LEAD_MS;

  specialRound.crossy = {
    stage: 'playing',
    rows: buildCrossyRows(),
    startsAt,
    endsAt: startsAt + CROSSY_PLAY_MS,
    players: new Map(specialRound.participantIds.map((playerId) => [playerId, { best: 0, row: 0, col: 0, dead: false, finishedAt: null }])),
    outcome: null,
  };

  setRoomTimer(room, 'crossy', startsAt + CROSSY_PLAY_MS + CROSSY_GRACE_MS, () => finishCrossy(room));
}

function maybeFinishCrossy(room) {
  const crossy = room.match?.specialRound?.crossy;

  if (
    crossy?.stage === 'playing' &&
    getActiveParticipantIds(room, room.match.specialRound).every((playerId) => {
      const player = crossy.players.get(playerId);
      return player && (player.dead || player.finishedAt);
    })
  ) {
    setRoomTimer(room, 'crossy', Date.now() + 1200, () => finishCrossy(room));
  }
}

function finishCrossy(room) {
  const specialRound = room.match?.specialRound;
  const crossy = specialRound?.crossy;

  if (!crossy || crossy.outcome) {
    return;
  }

  clearRoomTimer(room, 'crossy');
  crossy.stage = 'finished';
  const entries = specialRound.participantIds.map((playerId) => ({ playerId, ...crossy.players.get(playerId) }));
  // Los que llegan a la meta van primero y por orden de llegada; despues, por fila alcanzada (empates comparten).
  const keyOf = (entry) => (entry.finishedAt ? `meta:${entry.finishedAt}` : `fila:${entry.best}`);
  const ordered = [...entries].sort((first, second) => {
    if (first.finishedAt && second.finishedAt) return first.finishedAt - second.finishedAt;
    if (first.finishedAt || second.finishedAt) return first.finishedAt ? -1 : 1;
    return second.best - first.best;
  });
  const levels = [...new Set(ordered.map(keyOf))];
  const ranking = ordered.map((entry) => {
    const base = ladderPoints(levels.indexOf(keyOf(entry)), levels.length);
    return {
      playerId: entry.playerId,
      playerName: room.players.get(entry.playerId)?.name || '',
      rows: entry.best,
      finished: Boolean(entry.finishedAt),
      dead: entry.dead,
      position: levels.indexOf(keyOf(entry)) + 1,
      points: Math.max(0, base - (entry.dead ? 5 : 0)),
    };
  });
  crossy.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.rows,
    answeredCount: CROSSY_FINISH_ROW,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicCrossy(crossy) {
  if (!crossy) {
    return null;
  }

  return {
    stage: crossy.stage,
    cols: CROSSY_COLS,
    finishRow: CROSSY_FINISH_ROW,
    wrap: CROSSY_WRAP,
    rows: crossy.rows,
    startsAt: crossy.startsAt,
    endsAt: crossy.endsAt,
    players: [...crossy.players.entries()].map(([playerId, player]) => ({ playerId, best: player.best, row: player.row, col: player.col, dead: player.dead, finished: Boolean(player.finishedAt) })),
    outcome: crossy.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Tiro de jabalina                                                    */
/* ------------------------------------------------------------------ */
// - 2D: terreno con colinas (varios mapas) y una bandera entre 25 y 50 m. Cada jugador tiene 3 jabalinas y 40 s;
//   gana quien deja una mas cerca de la bandera (solo cuenta la mejor; no hace falta tirar las tres).
// - El tiro (angulo y fuerza) lo simula cada cliente con la misma fisica: el propio al instante y los de los demas
//   en cuanto llegan. Al acabar, la camara se aleja para ver todas y 2,5 s despues salen los resultados.

const JAVELIN_MAPS = 6;
const JAVELIN_THROWS = 3;
const JAVELIN_LEAD_MS = 2500;
const JAVELIN_PLAY_MS = 40000;
const JAVELIN_ZOOM_MS = 2600;

function setupJavelin(room) {
  const specialRound = room.match.specialRound;
  const startsAt = specialRound.introEndsAt + JAVELIN_LEAD_MS;

  specialRound.javelin = {
    stage: 'throwing',
    map: crypto.randomInt(JAVELIN_MAPS),
    // Bandera entre 25 y 50 m (en medios metros).
    flagX: (50 + crypto.randomInt(51)) / 2,
    startsAt,
    endsAt: startsAt + JAVELIN_PLAY_MS,
    zoomEndsAt: null,
    throws: new Map(specialRound.participantIds.map((playerId) => [playerId, []])),
    outcome: null,
  };

  setRoomTimer(room, 'javelin', startsAt + JAVELIN_PLAY_MS + 800, () => startJavelinZoom(room));
}

function maybeEndJavelin(room) {
  const javelin = room.match?.specialRound?.javelin;

  if (
    javelin?.stage === 'throwing' &&
    getActiveParticipantIds(room, room.match.specialRound).every((playerId) => (javelin.throws.get(playerId) || []).length >= JAVELIN_THROWS)
  ) {
    // Margen para que la ultima jabalina termine de volar antes de alejar la camara.
    setRoomTimer(room, 'javelin', Date.now() + 3500, () => startJavelinZoom(room));
  }
}

function startJavelinZoom(room) {
  const javelin = room.match?.specialRound?.javelin;

  if (!javelin || javelin.stage !== 'throwing') {
    return;
  }

  javelin.stage = 'zoom';
  javelin.zoomEndsAt = Date.now() + JAVELIN_ZOOM_MS;
  setRoomTimer(room, 'javelin', javelin.zoomEndsAt, () => finishJavelin(room));
  emitMatchState(room);
}

function finishJavelin(room) {
  const specialRound = room.match?.specialRound;
  const javelin = specialRound?.javelin;

  if (!javelin || javelin.outcome) {
    return;
  }

  clearRoomTimer(room, 'javelin');
  javelin.stage = 'finished';
  const best = (playerId) => {
    const throws = javelin.throws.get(playerId) || [];
    return throws.length ? Math.min(...throws.map((entry) => entry.distance)) : null;
  };
  const thrown = specialRound.participantIds.filter((playerId) => best(playerId) !== null);
  const levels = [...new Set(thrown.map(best))].sort((first, second) => first - second);
  const ranking = specialRound.participantIds
    .map((playerId) => {
      const distance = best(playerId);
      return {
        playerId,
        playerName: room.players.get(playerId)?.name || '',
        distance,
        throws: (javelin.throws.get(playerId) || []).length,
        position: distance === null ? levels.length + 1 : levels.indexOf(distance) + 1,
        points: distance === null ? 0 : ladderPoints(levels.indexOf(distance), levels.length),
      };
    })
    .sort((first, second) => first.position - second.position);
  javelin.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.throws,
    answeredCount: JAVELIN_THROWS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicJavelin(javelin) {
  if (!javelin) {
    return null;
  }

  return {
    stage: javelin.stage,
    map: javelin.map,
    flagX: javelin.flagX,
    throwsPerPlayer: JAVELIN_THROWS,
    startsAt: javelin.startsAt,
    endsAt: javelin.endsAt,
    zoomEndsAt: javelin.zoomEndsAt,
    // Los tiros se reparten en cuanto llegan: cada cliente reproduce las jabalinas de los demas.
    throws: [...javelin.throws.entries()].flatMap(([playerId, throws]) => throws.map((entry, index) => ({ playerId, index, ...entry }))),
    outcome: javelin.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Preguntas y respuestas                                              */
/* ------------------------------------------------------------------ */
// - 3 preguntas (de mas facil a mas dificil) con 4 respuestas A-D. 15 s para contestar; no se ve quien ha votado
//   que hasta que han contestado todos (o se acaba el tiempo). Entonces salen las caras en cada respuesta y 2 s
//   despues se marca en verde la correcta. 10 puntos por acierto (no hay posiciones: maximo 30).

const QUIZ_ROUNDS = 3;
const QUIZ_LEAD_MS = 1800;
const QUIZ_ANSWER_MS = 15000;
const QUIZ_VOTES_MS = 2000;
const QUIZ_CORRECT_MS = 4500;
const QUIZ_POINTS = 10;

/** Una pregunta por ronda subiendo la dificultad: facil (1-2), media (3) y dificil (4-5). Respuestas barajadas. */
function pickQuizQuestions() {
  const bands = [
    (difficulty) => difficulty <= 2,
    (difficulty) => difficulty === 3,
    (difficulty) => difficulty >= 4,
  ];

  return bands.map((inBand) => {
    const entry = randomItem(QUIZ_QUESTIONS.filter((question) => inBand(question.difficulty)));
    const order = secureShuffle([0, 1, 2, 3]);
    return {
      category: entry.category,
      difficulty: entry.difficulty,
      question: entry.question,
      options: order.map((index) => entry.answers[index]),
      // En el fichero la primera respuesta es la correcta.
      correctIndex: order.indexOf(0),
    };
  });
}

function setupQuiz(room) {
  const specialRound = room.match.specialRound;

  specialRound.quiz = {
    stage: 'answering',
    questions: pickQuizQuestions(),
    round: 0,
    questionAt: null,
    answerStartsAt: null,
    answerEndsAt: null,
    correctAt: null,
    nextRoundAt: null,
    answers: new Map(),
    history: [],
    outcome: null,
  };

  startQuizRound(room, 1, specialRound.introEndsAt - Date.now());
}

function startQuizRound(room, round, extraMs = 0) {
  const quiz = room.match?.specialRound?.quiz;

  if (!quiz) {
    return;
  }

  quiz.round = round;
  quiz.stage = 'answering';
  quiz.answers = new Map();
  quiz.questionAt = Date.now() + Math.max(0, extraMs);
  quiz.answerStartsAt = quiz.questionAt + QUIZ_LEAD_MS;
  quiz.answerEndsAt = quiz.answerStartsAt + QUIZ_ANSWER_MS;
  quiz.correctAt = null;
  quiz.nextRoundAt = null;
  setRoomTimer(room, 'quiz', quiz.answerEndsAt + 300, () => revealQuizVotes(room, round));
  emitMatchState(room);
}

function maybeRevealQuiz(room) {
  const quiz = room.match?.specialRound?.quiz;

  if (quiz?.stage === 'answering' && getActiveParticipantIds(room, room.match.specialRound).every((playerId) => quiz.answers.has(playerId))) {
    revealQuizVotes(room, quiz.round);
  }
}

/** Primero se ve quien ha votado cada respuesta; 2 s despues, cual era la correcta. */
function revealQuizVotes(room, round) {
  const specialRound = room.match?.specialRound;
  const quiz = specialRound?.quiz;

  if (!quiz || quiz.round !== round || quiz.stage !== 'answering') {
    return;
  }

  const question = quiz.questions[round - 1];
  quiz.stage = 'votes';
  quiz.correctAt = Date.now() + QUIZ_VOTES_MS;
  quiz.history.push({
    round,
    answers: [...quiz.answers.entries()].map(([playerId, choice]) => ({ playerId, choice })),
    correctIndex: question.correctIndex,
    points: specialRound.participantIds.map((playerId) => ({ playerId, points: quiz.answers.get(playerId) === question.correctIndex ? QUIZ_POINTS : 0 })),
  });
  setRoomTimer(room, 'quiz', quiz.correctAt, () => {
    quiz.stage = 'correct';
    quiz.nextRoundAt = Date.now() + QUIZ_CORRECT_MS;
    setRoomTimer(room, 'quiz', quiz.nextRoundAt, () => (round < QUIZ_ROUNDS ? startQuizRound(room, round + 1) : finishQuiz(room)));
    emitMatchState(room);
  });
  emitMatchState(room);
}

function finishQuiz(room) {
  const specialRound = room.match?.specialRound;
  const quiz = specialRound?.quiz;

  if (!quiz || quiz.outcome) {
    return;
  }

  clearRoomTimer(room, 'quiz');
  quiz.stage = 'finished';
  const ranking = specialRound.participantIds
    .map((playerId) => {
      const hits = quiz.history.filter((entry) => entry.points.find((row) => row.playerId === playerId)?.points).length;
      return { playerId, playerName: room.players.get(playerId)?.name || '', hits, points: hits * QUIZ_POINTS };
    })
    .sort((first, second) => second.points - first.points);
  quiz.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.hits,
    answeredCount: QUIZ_ROUNDS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicQuiz(quiz) {
  if (!quiz) {
    return null;
  }

  const question = quiz.questions[Math.max(0, quiz.round - 1)];
  const revealed = quiz.stage !== 'answering';
  const current = quiz.history.find((entry) => entry.round === quiz.round);

  return {
    stage: quiz.stage,
    round: quiz.round,
    totalRounds: QUIZ_ROUNDS,
    category: question.category,
    difficulty: question.difficulty,
    question: question.question,
    options: question.options,
    questionAt: quiz.questionAt,
    answerStartsAt: quiz.answerStartsAt,
    answerEndsAt: quiz.answerEndsAt,
    correctAt: quiz.correctAt,
    nextRoundAt: quiz.nextRoundAt,
    // Mientras se contesta solo se sabe quien ha contestado; que ha votado cada uno, al revelar.
    answeredPlayerIds: [...quiz.answers.keys()],
    answers: revealed && current ? current.answers : [],
    correctIndex: quiz.stage === 'correct' || quiz.stage === 'finished' ? question.correctIndex : null,
    // Puntos de las rondas ya resueltas (la actual, solo cuando ya se ve la correcta).
    history: quiz.history
      .filter((entry) => entry.round < quiz.round || quiz.stage === 'correct' || quiz.stage === 'finished')
      .map((entry) => ({ round: entry.round, points: entry.points })),
    outcome: quiz.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Empujar                                                             */
/* ------------------------------------------------------------------ */
// - Discos (la foto de cada jugador) sobre una pista de hielo redonda rodeada de agua. Rondas seguidas sin
//   recolocar a nadie, hasta que quede uno (o ninguno): en cada una todos eligen a la vez direccion y fuerza (15 s,
//   se puede rectificar; si no se confirma vale la ultima elegida) y 2 s despues salen todos a la vez. Quien acaba
//   con el disco entero fuera de la pista cae al agua.
// - La pista se encoge: las 2 primeras rondas entera; desde la 2 se marca en rojo el anillo que se hunde al empezar
//   la ronda siguiente, y quien tenga el centro en esa zona cae al agua. Asi hasta que la pista mide como una ficha.
// - La fisica la calcula cada cliente con los impulsos de todos (es determinista); el primer cliente que termina
//   envia el resultado y el servidor lo usa para la ronda siguiente.
// - Puntos: los que siguen vivos al final 30; el resto, escalera segun cuando cayeron; el primero en caer 0.

const PUSH_AIM_MS = 15000;
const PUSH_LAUNCH_DELAY_MS = 2000;
const PUSH_AFTER_MS = 1800;
const PUSH_ARENA_RADIUS = 10;
const PUSH_DISC_RADIUS = 1.1;
const PUSH_MAX_SPEED = 16;
const PUSH_MAX_STEPS = 120 * 12;
// Si nadie enviara el resultado (todos desconectados), la ronda se da por terminada sin cambios.
const PUSH_RESULT_FALLBACK_MS = PUSH_LAUNCH_DELAY_MS + 12000 + 4000;
// La pista empieza a encogerse en esta ronda, perdiendo este radio en cada una, hasta medir como una ficha.
const PUSH_SHRINK_FROM_ROUND = 3;
const PUSH_SHRINK_STEP = 1.2;
const PUSH_MIN_RADIUS = PUSH_DISC_RADIUS;
// Animacion del anillo que se hunde al empezar la ronda (antes de poder apuntar).
const PUSH_SHRINK_MS = 1600;
// Con la pista ya al minimo, a lo sumo estas rondas mas (por si quedan dos que no se mueven).
const PUSH_ROUNDS_AT_MINIMUM = 3;

/** Radio de la pista en una ronda. */
function pushArenaRadius(round) {
  const steps = Math.max(0, round - PUSH_SHRINK_FROM_ROUND + 1);
  return Math.max(PUSH_MIN_RADIUS, Math.round((PUSH_ARENA_RADIUS - steps * PUSH_SHRINK_STEP) * 1000) / 1000);
}

function setupPush(room) {
  const specialRound = room.match.specialRound;
  const ids = specialRound.participantIds;
  // Repartidos en circulo a 6/10 del radio, empezando arriba.
  const players = new Map(
    ids.map((playerId, index) => {
      const angle = (index / ids.length) * Math.PI * 2 - Math.PI / 2;
      const radius = ids.length > 1 ? PUSH_ARENA_RADIUS * 0.6 : 0;
      const round3 = (value) => Math.round(value * 1000) / 1000;
      return [playerId, { x: round3(Math.cos(angle) * radius), y: round3(Math.sin(angle) * radius), alive: true, fell: null }];
    }),
  );

  specialRound.push = {
    stage: 'aiming',
    round: 0,
    players,
    aims: new Map(),
    drafts: new Map(),
    impulses: [],
    launchBodies: [],
    arenaRadius: PUSH_ARENA_RADIUS,
    shrink: null,
    aimStartsAt: null,
    aimEndsAt: null,
    launchAt: null,
    nextRoundAt: null,
    outcome: null,
  };

  startPushRound(room, 1, specialRound.introEndsAt - Date.now() + 1500);
}

function startPushRound(room, round, extraMs = 0) {
  const push = room.match?.specialRound?.push;

  if (!push) {
    return;
  }

  // La zona marcada en rojo en la ronda anterior se hunde: quien tenga el centro ahi cae al agua.
  const radius = pushArenaRadius(round);
  push.shrink = null;

  if (radius < push.arenaRadius) {
    const fallen = alivePushIds(push).filter((playerId) => {
      const player = push.players.get(playerId);
      return Math.hypot(player.x, player.y) > radius;
    });

    for (const playerId of fallen) {
      // Cuenta como caido al final de la ronda anterior (despues de los que cayeron empujados en ella).
      Object.assign(push.players.get(playerId), { alive: false, fell: { round: round - 1, step: PUSH_MAX_STEPS + 1 } });
    }

    push.shrink = { from: push.arenaRadius, to: radius, at: Date.now(), fallen };
    extraMs = Math.max(extraMs, PUSH_SHRINK_MS);
  }

  push.arenaRadius = radius;
  const atMinimum = round - Math.ceil((PUSH_ARENA_RADIUS - PUSH_MIN_RADIUS) / PUSH_SHRINK_STEP) - PUSH_SHRINK_FROM_ROUND + 1;

  if (alivePushIds(push).length <= 1 || atMinimum > PUSH_ROUNDS_AT_MINIMUM) {
    // Ya no se juega mas: se ve como se hunde la pista y se acaba (sin simular otra ronda).
    push.round = round;
    push.stage = 'resolved';
    push.impulses = [];
    push.launchBodies = [];
    push.nextRoundAt = Date.now() + PUSH_SHRINK_MS;
    setRoomTimer(room, 'push', push.nextRoundAt, () => finishPush(room));
    emitMatchState(room);
    return;
  }

  push.round = round;
  push.stage = 'aiming';
  push.aims = new Map();
  push.drafts = new Map();
  push.impulses = [];
  push.aimStartsAt = Date.now() + Math.max(0, extraMs);
  push.aimEndsAt = push.aimStartsAt + PUSH_AIM_MS;
  push.launchAt = null;
  push.nextRoundAt = null;
  setRoomTimer(room, 'push', push.aimEndsAt + 300, () => launchPush(room, round));
  emitMatchState(room);
}

function alivePushIds(push) {
  return [...push.players.entries()].filter(([, player]) => player.alive).map(([playerId]) => playerId);
}

function maybeLaunchPush(room) {
  const push = room.match?.specialRound?.push;

  if (push?.stage !== 'aiming') {
    return;
  }

  const active = new Set(getActiveParticipantIds(room, room.match.specialRound));

  if (alivePushIds(push).filter((playerId) => active.has(playerId)).every((playerId) => push.aims.has(playerId))) {
    launchPush(room, push.round);
  }
}

/** Se cierran las direcciones: se reparten todos los impulsos (sin elegir = 0) y 2 s despues salen todos a la vez. */
function launchPush(room, round) {
  const push = room.match?.specialRound?.push;

  if (!push || push.round !== round || push.stage !== 'aiming') {
    return;
  }

  push.stage = 'launching';
  push.launchAt = Date.now() + PUSH_LAUNCH_DELAY_MS;
  // Confirmada, o si no la ultima que eligio sin confirmar, o quieto.
  push.impulses = alivePushIds(push).map((playerId) => ({ playerId, ...(push.aims.get(playerId) || push.drafts.get(playerId) || { vx: 0, vy: 0 }) }));
  // Posiciones de salida de la ronda: con ellas y los impulsos cada cliente anima la fisica, aunque el resultado
  // (que manda el cliente mas rapido) llegue antes de que empiece su animacion.
  push.launchBodies = alivePushIds(push).map((playerId) => ({ playerId, x: push.players.get(playerId).x, y: push.players.get(playerId).y }));
  setRoomTimer(room, 'push', push.launchAt + PUSH_RESULT_FALLBACK_MS, () => applyPushResult(room, round, null));
  emitMatchState(room);
}

/** Resultado de la simulacion (lo envia el primer cliente que la termina) o null si no llego ninguno. */
function applyPushResult(room, round, result) {
  const push = room.match?.specialRound?.push;

  if (!push || push.round !== round || push.stage !== 'launching') {
    return false;
  }

  const alive = alivePushIds(push);
  let steps = 0;

  if (result) {
    for (const body of result.positions) {
      Object.assign(push.players.get(body.playerId), { x: body.x, y: body.y });
    }

    for (const fall of result.falls) {
      Object.assign(push.players.get(fall.playerId), { alive: false, fell: { round, step: fall.step } });
    }

    steps = result.steps;
  }

  push.stage = 'resolved';
  const animationEnds = push.launchAt + Math.ceil((steps / 120) * 1000);
  push.nextRoundAt = Math.max(Date.now(), animationEnds) + PUSH_AFTER_MS;
  const remaining = alive.length - (result?.falls.length || 0);
  setRoomTimer(room, 'push', push.nextRoundAt, () => (remaining > 1 ? startPushRound(room, round + 1) : finishPush(room)));
  emitMatchState(room);
  return true;
}

function finishPush(room) {
  const specialRound = room.match?.specialRound;
  const push = specialRound?.push;

  if (!push || push.outcome) {
    return;
  }

  clearRoomTimer(room, 'push');
  push.stage = 'finished';
  // Cuanto mas tarde se cae, mejor; los que siguen en pie empatan arriba.
  const keyOf = (player) => (player.alive ? Infinity : player.fell.round * 100000 + player.fell.step);
  const entries = specialRound.participantIds.map((playerId) => ({ playerId, player: push.players.get(playerId) }));
  const levels = [...new Set(entries.map((entry) => keyOf(entry.player)))].sort((first, second) => second - first);
  const ranking = entries
    .map(({ playerId, player }) => {
      const level = levels.indexOf(keyOf(player));
      return {
        playerId,
        playerName: room.players.get(playerId)?.name || '',
        survived: player.alive,
        fellRound: player.fell?.round ?? null,
        position: level + 1,
        points: ladderPoints(level, levels.length),
      };
    })
    .sort((first, second) => first.position - second.position);
  push.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.survived ? push.round : (entry.fellRound || 1) - 1,
    answeredCount: push.round,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicPush(push) {
  if (!push) {
    return null;
  }

  return {
    stage: push.stage,
    round: push.round,
    fullRadius: PUSH_ARENA_RADIUS,
    arenaRadius: push.arenaRadius,
    // Lo que medira la pista en la ronda siguiente: el anillo entre este radio y el actual se marca en rojo.
    nextRadius: push.stage === 'finished' ? push.arenaRadius : pushArenaRadius(push.round + 1),
    shrink: push.shrink,
    discRadius: PUSH_DISC_RADIUS,
    maxSpeed: PUSH_MAX_SPEED,
    players: [...push.players.entries()].map(([playerId, player]) => ({ playerId, x: player.x, y: player.y, alive: player.alive, fellRound: player.fell?.round ?? null })),
    aimStartsAt: push.aimStartsAt,
    aimEndsAt: push.aimEndsAt,
    confirmedPlayerIds: [...push.aims.keys()],
    // Las direcciones de los demas no se ven hasta que salen todos.
    impulses: push.stage === 'aiming' ? [] : push.impulses,
    launchBodies: push.stage === 'aiming' ? [] : push.launchBodies || [],
    launchAt: push.launchAt,
    nextRoundAt: push.nextRoundAt,
    outcome: push.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Ruleta rusa                                                         */
/* ------------------------------------------------------------------ */
// - Por turnos (orden al azar, como el globo): cada jugador llega a la mesa, coge el revolver y se apunta. Elige
//   "Disparar" (dispara la recamara que toca) o "Saltar bala" (gira una recamara y dispara la siguiente).
// - El tambor tiene 6 recamaras. Se empieza con 1 bala; cada vez que alguien cae se recarga con una bala mas
//   (maximo 3, siempre quedan 3 libres) en posiciones al azar. Tras un disparo en vacio el tambor avanza.
// - Donde estan las balas solo lo sabe el servidor. Gana quien sobrevive; el resto, por orden de caida.

const RUSSIAN_CHAMBERS = 6;
const RUSSIAN_MAX_BULLETS = 3;
const RUSSIAN_WALK_MS = 2400;
const RUSSIAN_PICKUP_MS = 1400;
const RUSSIAN_DECIDE_MS = 15000;
const RUSSIAN_SKIP_MS = 800;
const RUSSIAN_TRIGGER_MS = 900;
const RUSSIAN_PUTDOWN_MS = 1000;
const RUSSIAN_DEAD_MS = 4200;
const RUSSIAN_RELOAD_MS = 2600;
// Si el jugador en turno se ha desconectado, dispara solo pasado este tiempo.
const RUSSIAN_AWAY_MS = 2500;

function loadRussianCylinder(russian) {
  russian.bullets = Math.min(RUSSIAN_MAX_BULLETS, russian.eliminated.length + 1);
  const slots = secureShuffle([...Array(RUSSIAN_CHAMBERS).keys()]).slice(0, russian.bullets);
  russian.chambers = Array.from({ length: RUSSIAN_CHAMBERS }, (_unused, index) => slots.includes(index));
  russian.chamber = 0;
  russian.load += 1;
}

function setupRussian(room) {
  const specialRound = room.match.specialRound;

  specialRound.russian = {
    stage: 'walking',
    order: secureShuffle(specialRound.participantIds),
    alive: new Set(specialRound.participantIds),
    eliminated: [],
    chambers: [],
    chamber: 0,
    bullets: 1,
    load: 0,
    turnIndex: -1,
    turnNumber: 0,
    currentPlayerId: null,
    turnStartsAt: null,
    arriveAt: null,
    decideStartsAt: null,
    decideEndsAt: null,
    lastShot: null,
    nextAt: null,
    outcome: null,
  };

  loadRussianCylinder(specialRound.russian);
  beginRussianTurn(room, 0, specialRound.introEndsAt);
}

/** Siguiente jugador vivo y presente desde `fromIndex`; la ronda acaba si queda uno (o ninguno) presente. */
function beginRussianTurn(room, fromIndex, startsAt) {
  const russian = room.match?.specialRound?.russian;

  if (!russian || russian.outcome) {
    return;
  }

  const active = (playerId) => room.players.get(playerId)?.active;
  const contenders = russian.order.filter((playerId) => russian.alive.has(playerId) && active(playerId));

  if (contenders.length <= 1) {
    finishRussian(room);
    return;
  }

  let index = fromIndex % russian.order.length;

  for (let step = 0; step < russian.order.length; step += 1) {
    const playerId = russian.order[index];

    if (russian.alive.has(playerId) && active(playerId)) {
      break;
    }

    index = (index + 1) % russian.order.length;
  }

  russian.turnIndex = index;
  russian.turnNumber += 1;
  russian.currentPlayerId = russian.order[index];
  russian.stage = 'walking';
  russian.turnStartsAt = Math.max(Date.now(), startsAt);
  russian.arriveAt = russian.turnStartsAt + RUSSIAN_WALK_MS;
  russian.decideStartsAt = russian.arriveAt + RUSSIAN_PICKUP_MS;
  russian.decideEndsAt = russian.decideStartsAt + RUSSIAN_DECIDE_MS;
  russian.nextAt = null;
  const turnNumber = russian.turnNumber;

  // Llega a la mesa, coge el revolver y se apunta: entonces tiene 15 s para decidir (si no, dispara).
  setRoomTimer(room, 'russian', russian.decideStartsAt, () => {
    if (russian.turnNumber !== turnNumber || russian.outcome) {
      return;
    }

    russian.stage = 'deciding';
    const deadline = active(russian.currentPlayerId) ? russian.decideEndsAt : Date.now() + RUSSIAN_AWAY_MS;
    setRoomTimer(room, 'russian', deadline, () => russianShoot(room, russian.currentPlayerId, 'shoot', turnNumber));
    emitMatchState(room);
  });
  emitMatchState(room);
}

/** Disparo (o salto de bala y disparo). El resultado lo decide el servidor con la recamara que toca. */
function russianShoot(room, playerId, action, turnNumber) {
  const russian = room.match?.specialRound?.russian;

  if (!russian || russian.outcome || russian.stage !== 'deciding' || russian.currentPlayerId !== playerId || russian.turnNumber !== turnNumber) {
    return false;
  }

  const skipped = action === 'skip';

  if (skipped) {
    russian.chamber = (russian.chamber + 1) % RUSSIAN_CHAMBERS;
  }

  const bang = russian.chambers[russian.chamber];
  const now = Date.now();
  const firesAt = now + (skipped ? RUSSIAN_SKIP_MS : 0) + RUSSIAN_TRIGGER_MS;
  russian.lastShot = { turnNumber, playerId, skipped, bang, at: now, firesAt };
  russian.stage = 'firing';

  if (bang) {
    russian.alive.delete(playerId);
    russian.eliminated.push({ playerId, turnNumber });
    // Se recarga con una bala mas (al terminar la animacion de la caida).
    russian.nextAt = firesAt + RUSSIAN_DEAD_MS + RUSSIAN_RELOAD_MS;
    setRoomTimer(room, 'russian', firesAt + RUSSIAN_DEAD_MS, () => {
      const contenders = russian.order.filter((id) => russian.alive.has(id) && room.players.get(id)?.active);

      if (contenders.length <= 1) {
        finishRussian(room);
        return;
      }

      loadRussianCylinder(russian);
      russian.stage = 'reload';
      setRoomTimer(room, 'russian', russian.nextAt, () => beginRussianTurn(room, russian.turnIndex + 1, Date.now()));
      emitMatchState(room);
    });
  } else {
    // En vacio: el tambor avanza; deja el arma y se va mientras el siguiente ya camina hacia la mesa.
    russian.chamber = (russian.chamber + 1) % RUSSIAN_CHAMBERS;
    russian.nextAt = firesAt + RUSSIAN_PUTDOWN_MS;
    setRoomTimer(room, 'russian', russian.nextAt, () => beginRussianTurn(room, russian.turnIndex + 1, Date.now()));
  }

  emitMatchState(room);
  return true;
}

function finishRussian(room) {
  const specialRound = room.match?.specialRound;
  const russian = specialRound?.russian;

  if (!russian || russian.outcome) {
    return;
  }

  clearRoomTimer(room, 'russian');
  russian.stage = 'finished';
  russian.currentPlayerId = null;
  // Primero quien sigue vivo (y presente); despues, cuanto mas tarde cayo, mejor.
  const survivors = russian.order.filter((playerId) => russian.alive.has(playerId));
  const ordered = [
    ...survivors.filter((playerId) => room.players.get(playerId)?.active),
    ...survivors.filter((playerId) => !room.players.get(playerId)?.active),
    ...[...russian.eliminated].reverse().map((entry) => entry.playerId),
  ];
  const ranking = ordered.map((playerId, index) => ({
    playerId,
    playerName: room.players.get(playerId)?.name || '',
    survived: russian.alive.has(playerId),
    position: index + 1,
    points: ladderPoints(index, ordered.length),
  }));
  russian.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.survived ? 1 : 0,
    answeredCount: 1,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

/** Si el jugador en turno se va mientras decide, dispara solo enseguida. */
function maybeRussianAway(room) {
  const russian = room.match?.specialRound?.russian;

  if (russian?.stage === 'deciding' && !room.players.get(russian.currentPlayerId)?.active) {
    const turnNumber = russian.turnNumber;
    setRoomTimer(room, 'russian', Date.now() + RUSSIAN_AWAY_MS, () => russianShoot(room, russian.currentPlayerId, 'shoot', turnNumber));
  }
}

function toPublicRussian(russian) {
  if (!russian) {
    return null;
  }

  // Las recamaras cargadas nunca salen del servidor: solo cuantas balas hay en esta carga.
  return {
    stage: russian.stage,
    order: russian.order,
    alive: russian.order.filter((playerId) => russian.alive.has(playerId)),
    eliminated: russian.eliminated,
    bullets: russian.bullets,
    chambers: RUSSIAN_CHAMBERS,
    load: russian.load,
    turnIndex: russian.turnIndex,
    turnNumber: russian.turnNumber,
    currentPlayerId: russian.currentPlayerId,
    turnStartsAt: russian.turnStartsAt,
    arriveAt: russian.arriveAt,
    decideStartsAt: russian.decideStartsAt,
    decideEndsAt: russian.decideEndsAt,
    lastShot: russian.lastShot,
    nextAt: russian.nextAt,
    timings: { walkMs: RUSSIAN_WALK_MS, pickupMs: RUSSIAN_PICKUP_MS, skipMs: RUSSIAN_SKIP_MS, triggerMs: RUSSIAN_TRIGGER_MS, putdownMs: RUSSIAN_PUTDOWN_MS, deadMs: RUSSIAN_DEAD_MS },
    outcome: russian.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Patata caliente                                                     */
/* ------------------------------------------------------------------ */
// - Todos en circulo (orden al azar). La bomba empieza en alguien al azar. Arriba sale una palabra y quien tiene
//   la bomba escribe otra que empiece por la ultima, las dos o las tres ultimas letras de la anterior (sin
//   repetir ninguna palabra en todo el minijuego; sin tildes ni mayusculas). Si vale, lanza la bomba al siguiente.
// - La mecha dura entre 10 y 50 s al azar (secreta: solo la conoce quien tiene la bomba, para su reloj) y solo
//   se consume mientras se puede escribir (los pases no cuentan). A quien le explota queda eliminado y empieza
//   otra ronda con una mecha y una palabra nuevas. Gana el ultimo en pie; el resto, por orden de caida.
// - Manda el cliente: comprueba la palabra y cuando se le acaba la mecha avisa de la explosion. El servidor
//   acepta la palabra aunque llegue un poco tarde (latencia) y solo explota por su cuenta si el cliente no avisa.

const BOMB_ORBIT_MS = 4200;
const BOMB_FUSE_MIN_MS = 10000;
const BOMB_FUSE_MAX_MS = 50000;
// Minimo de mecha que le queda al siguiente (para que al menos pueda intentarlo).
const BOMB_MIN_LEFT_MS = 1000;
const BOMB_PASS_MS = 1300;
const BOMB_SPAWN_MS = 1800;
// Margen para palabras que salen a tiempo pero llegan tarde (o si el cliente no avisa de la explosion).
const BOMB_GRACE_MS = 1500;
const BOMB_BOOM_MS = 5200;
// Quien tiene la bomba y se desconecta: explota a los pocos segundos.
const BOMB_AWAY_MS = 2500;
const BOMB_WORD_MIN = 3;
const BOMB_WORD_MAX = 24;
const BOMB_SEED_WORDS = [
  'casa', 'perro', 'gato', 'mesa', 'silla', 'coche', 'playa', 'libro', 'arbol', 'mano', 'tomate', 'queso',
  'reloj', 'camion', 'sol', 'luna', 'nube', 'lapiz', 'zapato', 'botella', 'ventana', 'puerta', 'pelota', 'leche',
  'manzana', 'naranja', 'plato', 'cuchara', 'raton', 'caballo', 'tigre', 'conejo', 'pajaro', 'barco', 'avion',
  'tren', 'bicicleta', 'guitarra', 'piano', 'camisa', 'sombrero', 'jardin', 'flor', 'hielo', 'fuego', 'agua',
  'montaña', 'rio', 'isla', 'castillo', 'princesa', 'dragon', 'pirata', 'tesoro', 'chocolate', 'galleta',
  'pizza', 'helado', 'cohete', 'robot', 'escuela', 'hospital', 'medico', 'bombero', 'payaso', 'circo', 'mago',
  'espejo', 'cama', 'almohada', 'cocina', 'nevera', 'tortuga', 'elefante', 'jirafa', 'pingüino', 'calcetin',
];

/**
 * Diccionario de espanol (unas 590.000 formas: plurales, femeninos, conjugaciones...), generado con
 * scripts/generate-dictionary.cjs a partir del diccionario libre de LibreOffice (RLA-ES). Se guarda como un unico
 * texto ordenado (una palabra por linea, sin tildes) y se busca con busqueda binaria: ocupa ~9 MB en memoria.
 * Si faltara el archivo, se aceptan todas las palabras (solo se comprueban las reglas).
 */
const BOMB_DICTIONARY = (() => {
  try {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'data', 'palabras-es.txt.gz'))).toString('utf8');
    const starts = [0];

    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
      starts.push(index + 1);
    }

    return { text, starts: Int32Array.from(starts) };
  } catch (error) {
    console.warn(`Patata caliente: no se pudo cargar el diccionario (${error.message}); se aceptan todas las palabras.`);
    return null;
  }
})();

function bombWordExists(word) {
  if (!BOMB_DICTIONARY) {
    return true;
  }

  const { text, starts } = BOMB_DICTIONARY;
  let low = 0;
  let high = starts.length - 1;

  while (low <= high) {
    const middle = (low + high) >> 1;
    const end = middle + 1 < starts.length ? starts[middle + 1] - 1 : text.length;
    const candidate = text.slice(starts[middle], end);

    if (candidate === word) {
      return true;
    }

    // Mismo orden que al generar la lista (sort() de JavaScript: por unidades de codigo).
    if (candidate < word) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return false;
}

/** Minusculas y sin tildes (la ñ se mantiene). Igual que en el cliente. */
function normalizeBombWord(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ñ/g, '\u0001')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'ñ');
}

/** null si la palabra vale; si no, el motivo. Mismas reglas que en el cliente. */
function bombWordProblem(word, previous, used) {
  if (!/^[a-zñ]+$/.test(word) || word.length < BOMB_WORD_MIN || word.length > BOMB_WORD_MAX || !/[aeiou]/.test(word) || /(.)\1\1/.test(word)) {
    return 'format';
  }

  // Empieza por la ultima, las dos o las tres ultimas letras de la anterior (vale aunque sea solo eso: "rio" tras "armario").
  const chains = [1, 2, 3].some((size) => size <= previous.length && word.startsWith(previous.slice(-size)));

  if (!chains) {
    return 'chain';
  }

  if (used.has(word)) {
    return 'used';
  }

  return bombWordExists(word) ? null : 'unknown';
}

function setupBomb(room) {
  const specialRound = room.match.specialRound;
  const order = secureShuffle(specialRound.participantIds);

  specialRound.bomb = {
    stage: 'intro',
    order,
    alive: new Set(order),
    eliminated: [],
    round: 0,
    turn: 0,
    holderId: null,
    fromId: null,
    seedWord: '',
    lastWord: '',
    chain: [],
    used: new Set(),
    wordCounts: new Map(),
    fuseLeftMs: 0,
    orbitEndsAt: specialRound.introEndsAt + BOMB_ORBIT_MS,
    passStartsAt: null,
    passEndsAt: null,
    typingStartsAt: null,
    explodeAt: null,
    boom: null,
    nextAt: null,
    outcome: null,
  };

  // Mientras la camara da la vuelta al circulo se elige al azar quien empieza.
  const starterId = order[crypto.randomInt(order.length)];
  setRoomTimer(room, 'bomb', specialRound.bomb.orbitEndsAt, () => startBombRound(room, starterId));
}

/** Ronda nueva: mecha y palabra nuevas; la bomba aparece en las manos de `holderId`. */
function startBombRound(room, holderId) {
  const bomb = room.match?.specialRound?.bomb;

  if (!bomb || bomb.outcome) {
    return;
  }

  const fresh = BOMB_SEED_WORDS.map(normalizeBombWord).filter((word) => !bomb.used.has(word));
  const seed = fresh.length ? fresh[crypto.randomInt(fresh.length)] : normalizeBombWord(BOMB_SEED_WORDS[crypto.randomInt(BOMB_SEED_WORDS.length)]);
  bomb.round += 1;
  bomb.seedWord = seed;
  bomb.lastWord = seed;
  bomb.chain = [];
  bomb.used.add(seed);
  bomb.fuseLeftMs = crypto.randomInt(BOMB_FUSE_MIN_MS, BOMB_FUSE_MAX_MS + 1);
  bomb.boom = null;
  passBomb(room, null, holderId, BOMB_SPAWN_MS);
}

/** La bomba va de `fromId` (null = aparece) a `toId`; durante el pase la mecha no corre. */
function passBomb(room, fromId, toId, durationMs) {
  const bomb = room.match.specialRound.bomb;
  const now = Date.now();
  bomb.stage = 'passing';
  bomb.fromId = fromId;
  bomb.holderId = toId;
  bomb.passStartsAt = now;
  bomb.passEndsAt = now + durationMs;
  bomb.typingStartsAt = null;
  bomb.explodeAt = null;
  bomb.nextAt = null;
  setRoomTimer(room, 'bomb', bomb.passEndsAt, () => startBombTyping(room));
  emitMatchState(room);
  sendPrivateStates(room);
}

function startBombTyping(room) {
  const bomb = room.match?.specialRound?.bomb;

  if (!bomb || bomb.outcome || bomb.stage !== 'passing') {
    return;
  }

  const now = Date.now();
  bomb.stage = 'typing';
  bomb.turn += 1;
  bomb.typingStartsAt = now;
  bomb.explodeAt = now + bomb.fuseLeftMs;
  scheduleBombFallback(room);
  emitMatchState(room);
  sendPrivateStates(room);
}

/** Explosion por si el cliente no avisa (o si quien tiene la bomba ya no esta). */
function scheduleBombFallback(room) {
  const bomb = room.match.specialRound.bomb;
  const turn = bomb.turn;
  const away = !room.players.get(bomb.holderId)?.active;
  const at = away ? Math.min(bomb.explodeAt + BOMB_GRACE_MS, Date.now() + BOMB_AWAY_MS) : bomb.explodeAt + BOMB_GRACE_MS;
  setRoomTimer(room, 'bomb', at, () => explodeBomb(room, turn));
}

/** Palabra valida (comprobada en el cliente, que ha medido cuanto ha tardado): la bomba pasa al siguiente. */
function acceptBombWord(room, playerId, rawWord, usedMs) {
  const bomb = room.match?.specialRound?.bomb;
  const now = Date.now();

  if (!bomb || bomb.outcome || bomb.stage !== 'typing' || bomb.holderId !== playerId) {
    return { ok: false, reason: 'Ahora no tienes la bomba.' };
  }

  if (now > bomb.explodeAt + BOMB_GRACE_MS) {
    return { ok: false, reason: '¡Demasiado tarde!' };
  }

  const word = normalizeBombWord(rawWord);
  const problem = bombWordProblem(word, bomb.lastWord, bomb.used);

  if (problem) {
    return { ok: false, reason: problem === 'unknown' ? `«${word.toUpperCase()}» no está en el diccionario.` : 'Esa palabra no vale.', problem };
  }

  // El tiempo lo mide el cliente (asi la latencia no le quita mecha); como mucho, lo que ha pasado de verdad.
  const spent = Math.max(0, Math.min(Number(usedMs) || 0, now - bomb.typingStartsAt));

  if (spent >= bomb.fuseLeftMs) {
    return { ok: false, reason: '¡Demasiado tarde!' };
  }

  bomb.fuseLeftMs = Math.max(BOMB_MIN_LEFT_MS, bomb.fuseLeftMs - spent);
  bomb.used.add(word);
  bomb.lastWord = word;
  bomb.chain.push({ word, playerId });
  bomb.wordCounts.set(playerId, (bomb.wordCounts.get(playerId) || 0) + 1);
  passBomb(room, playerId, nextBombHolder(room, playerId), BOMB_PASS_MS);
  return { ok: true };
}

/** Siguiente jugador vivo (y presente si hay alguno) en el circulo despues de `playerId`. */
function nextBombHolder(room, playerId) {
  const bomb = room.match.specialRound.bomb;
  const start = bomb.order.indexOf(playerId);
  const candidates = [];

  for (let step = 1; step <= bomb.order.length; step += 1) {
    const id = bomb.order[(start + step) % bomb.order.length];

    if (bomb.alive.has(id) && id !== playerId) {
      candidates.push(id);
    }
  }

  return candidates.find((id) => room.players.get(id)?.active) || candidates[0] || playerId;
}

function explodeBomb(room, turn) {
  const bomb = room.match?.specialRound?.bomb;

  if (!bomb || bomb.outcome || bomb.stage !== 'typing' || bomb.turn !== turn) {
    return false;
  }

  const victimId = bomb.holderId;
  const now = Date.now();
  bomb.stage = 'boom';
  bomb.boom = { playerId: victimId, at: now, round: bomb.round };
  bomb.alive.delete(victimId);
  bomb.eliminated.push({ playerId: victimId, round: bomb.round });
  bomb.explodeAt = null;
  bomb.nextAt = now + BOMB_BOOM_MS;
  setRoomTimer(room, 'bomb', bomb.nextAt, () => {
    if (room.match?.specialRound?.bomb !== bomb) {
      return;
    }

    const contenders = bomb.order.filter((id) => bomb.alive.has(id) && room.players.get(id)?.active);

    if (contenders.length <= 1) {
      finishBomb(room);
      return;
    }

    startBombRound(room, nextBombHolder(room, victimId));
  });
  emitMatchState(room);
  sendPrivateStates(room);
  return true;
}

function finishBomb(room) {
  const specialRound = room.match?.specialRound;
  const bomb = specialRound?.bomb;

  if (!bomb || bomb.outcome) {
    return;
  }

  clearRoomTimer(room, 'bomb');
  bomb.stage = 'finished';
  bomb.holderId = null;
  const survivors = bomb.order.filter((playerId) => bomb.alive.has(playerId));
  const ordered = [
    ...survivors.filter((playerId) => room.players.get(playerId)?.active),
    ...survivors.filter((playerId) => !room.players.get(playerId)?.active),
    ...[...bomb.eliminated].reverse().map((entry) => entry.playerId),
  ];
  const ranking = ordered.map((playerId, index) => ({
    playerId,
    playerName: room.players.get(playerId)?.name || '',
    survived: bomb.alive.has(playerId),
    words: bomb.wordCounts.get(playerId) || 0,
    position: index + 1,
    points: ladderPoints(index, ordered.length),
  }));
  bomb.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.survived ? 1 : 0,
    answeredCount: 1,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
  sendPrivateStates(room);
}

/** Si quien tiene la bomba se va mientras escribe, explota a los pocos segundos. */
function maybeBombAway(room) {
  const bomb = room.match?.specialRound?.bomb;

  if (bomb?.stage === 'typing' && !room.players.get(bomb.holderId)?.active) {
    scheduleBombFallback(room);
  }
}

function toPublicBomb(bomb) {
  if (!bomb) {
    return null;
  }

  // La mecha (cuanto queda) no sale de aqui: solo la recibe quien tiene la bomba, en su estado privado.
  return {
    stage: bomb.stage,
    order: bomb.order,
    alive: bomb.order.filter((playerId) => bomb.alive.has(playerId)),
    eliminated: bomb.eliminated,
    round: bomb.round,
    turn: bomb.turn,
    holderId: bomb.holderId,
    fromId: bomb.fromId,
    seedWord: bomb.seedWord,
    lastWord: bomb.lastWord,
    chain: bomb.chain,
    used: [...bomb.used],
    orbitEndsAt: bomb.orbitEndsAt,
    passStartsAt: bomb.passStartsAt,
    passEndsAt: bomb.passEndsAt,
    typingStartsAt: bomb.typingStartsAt,
    boom: bomb.boom,
    nextAt: bomb.nextAt,
    timings: { passMs: BOMB_PASS_MS, spawnMs: BOMB_SPAWN_MS, boomMs: BOMB_BOOM_MS, minWord: BOMB_WORD_MIN, maxWord: BOMB_WORD_MAX },
    outcome: bomb.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Canon                                                               */
/* ------------------------------------------------------------------ */
// - Uno al azar lleva el canon (en lo alto de una muralla) y el resto, abajo, eligen una de 4 zonas en 15 s (si
//   no eligen, una al azar). El canonero no ve donde se ponen. Despues el canonero tiene 15 s para elegir a que
//   zona dispara (si no, al azar). Se desvela quien esta en cada zona, dispara y los de esa zona salen volando.
// - Maximo 3 rondas (o hasta que no quede nadie abajo). Puntos: el canonero, 10 por cada uno que derriba si en
//   el minijuego hay 3 jugadores o menos (5 si hay mas); los de abajo, 10 por cada ronda que sobreviven.
// - Las zonas elegidas solo las reciben los de abajo (estado privado); el canonero no las ve hasta el disparo.

const CANNON_ROUNDS = 3;
const CANNON_ZONES = 4;
const CANNON_CHOOSE_MS = 15000;
// Si ya han elegido todos, la eleccion se cierra este rato despues del ultimo cambio.
const CANNON_SETTLE_MS = 2500;
const CANNON_AIM_MS = 15000;
const CANNON_AWAY_MS = 2500;
const CANNON_REVEAL_MS = 1800;
const CANNON_FLIGHT_MS = 900;
const CANNON_RESULT_MS = 4200;
const CANNON_SURVIVE_POINTS = 10;

function setupCannon(room) {
  const specialRound = room.match.specialRound;
  const ids = specialRound.participantIds;
  const cannoneerId = ids[crypto.randomInt(ids.length)];
  const victims = secureShuffle(ids.filter((playerId) => playerId !== cannoneerId));

  specialRound.cannon = {
    stage: 'choosing',
    cannoneerId,
    victims,
    alive: new Set(victims),
    round: 0,
    picks: new Map(),
    chooseStartsAt: null,
    chooseEndsAt: null,
    aimEndsAt: null,
    target: null,
    positions: [],
    fireAt: null,
    impactAt: null,
    nextAt: null,
    history: [],
    kills: 0,
    survived: new Map(victims.map((playerId) => [playerId, 0])),
    pointsPerKill: ids.length <= 3 ? 10 : 5,
    outcome: null,
  };

  startCannonRound(room, 1, specialRound.introEndsAt);
}

function startCannonRound(room, round, startsAt) {
  const cannon = room.match?.specialRound?.cannon;

  if (!cannon || cannon.outcome) {
    return;
  }

  cannon.round = round;
  cannon.stage = 'choosing';
  cannon.picks = new Map();
  cannon.chooseStartsAt = Math.max(Date.now(), startsAt);
  cannon.chooseEndsAt = cannon.chooseStartsAt + CANNON_CHOOSE_MS;
  cannon.aimEndsAt = null;
  cannon.target = null;
  cannon.positions = [];
  cannon.fireAt = null;
  cannon.impactAt = null;
  cannon.nextAt = null;
  setRoomTimer(room, 'cannon', cannon.chooseEndsAt, () => closeCannonChoosing(room, round));
  emitMatchState(room);
  sendPrivateStates(room);
}

function cannonVictimsInPlay(room) {
  const cannon = room.match.specialRound.cannon;
  return cannon.victims.filter((playerId) => cannon.alive.has(playerId));
}

/** Si ya han elegido todos los de abajo (presentes), se cierra poco despues del ultimo cambio. */
function maybeSettleCannonChoosing(room) {
  const cannon = room.match?.specialRound?.cannon;

  if (cannon?.stage !== 'choosing') {
    return;
  }

  const present = cannonVictimsInPlay(room).filter((playerId) => room.players.get(playerId)?.active);

  if (present.every((playerId) => cannon.picks.has(playerId))) {
    const round = cannon.round;
    setRoomTimer(room, 'cannon', Math.min(cannon.chooseEndsAt, Date.now() + CANNON_SETTLE_MS), () => closeCannonChoosing(room, round));
  }
}

function closeCannonChoosing(room, round) {
  const cannon = room.match?.specialRound?.cannon;

  if (!cannon || cannon.outcome || cannon.stage !== 'choosing' || cannon.round !== round) {
    return;
  }

  // Quien no ha elegido va a una zona al azar.
  cannon.positions = cannonVictimsInPlay(room).map((playerId) =>
    cannon.picks.has(playerId) ? { playerId, zone: cannon.picks.get(playerId), auto: false } : { playerId, zone: crypto.randomInt(CANNON_ZONES), auto: true },
  );
  cannon.stage = 'aiming';
  const away = !room.players.get(cannon.cannoneerId)?.active;
  cannon.aimEndsAt = Date.now() + (away ? CANNON_AWAY_MS : CANNON_AIM_MS);
  setRoomTimer(room, 'cannon', cannon.aimEndsAt, () => fireCannon(room, round, crypto.randomInt(CANNON_ZONES)));
  emitMatchState(room);
  sendPrivateStates(room);
}

function fireCannon(room, round, zone) {
  const cannon = room.match?.specialRound?.cannon;

  if (!cannon || cannon.outcome || cannon.stage !== 'aiming' || cannon.round !== round) {
    return false;
  }

  const now = Date.now();
  const hit = cannon.positions.filter((entry) => entry.zone === zone).map((entry) => entry.playerId);
  cannon.stage = 'firing';
  cannon.target = zone;
  cannon.fireAt = now + CANNON_REVEAL_MS;
  cannon.impactAt = cannon.fireAt + CANNON_FLIGHT_MS;
  cannon.nextAt = cannon.impactAt + CANNON_RESULT_MS;
  cannon.kills += hit.length;

  for (const entry of cannon.positions) {
    if (hit.includes(entry.playerId)) {
      cannon.alive.delete(entry.playerId);
    } else {
      cannon.survived.set(entry.playerId, (cannon.survived.get(entry.playerId) || 0) + 1);
    }
  }

  cannon.history.push({ round, target: zone, positions: cannon.positions, hit });
  const current = () => room.match?.specialRound?.cannon === cannon && !cannon.outcome;
  setRoomTimer(room, 'cannon', cannon.impactAt, () => {
    if (current()) {
      cannon.stage = 'result';
      emitMatchState(room);
    }
  });
  setRoomTimer(room, 'cannon-next', cannon.nextAt, () => {
    if (!current()) {
      return;
    }

    const remaining = cannonVictimsInPlay(room).filter((playerId) => room.players.get(playerId)?.active);

    if (round >= CANNON_ROUNDS || !remaining.length || !room.players.get(cannon.cannoneerId)) {
      finishCannon(room);
      return;
    }

    startCannonRound(room, round + 1, Date.now());
  });
  emitMatchState(room);
  sendPrivateStates(room);
  return true;
}

function finishCannon(room) {
  const specialRound = room.match?.specialRound;
  const cannon = specialRound?.cannon;

  if (!cannon || cannon.outcome) {
    return;
  }

  clearRoomTimer(room, 'cannon');
  clearRoomTimer(room, 'cannon-next');
  cannon.stage = 'finished';
  const rows = [
    { playerId: cannon.cannoneerId, role: 'cannoneer', kills: cannon.kills, rounds: 0, points: cannon.kills * cannon.pointsPerKill },
    ...cannon.victims.map((playerId) => {
      const rounds = cannon.survived.get(playerId) || 0;
      return { playerId, role: 'victim', kills: 0, rounds, survived: cannon.alive.has(playerId), points: rounds * CANNON_SURVIVE_POINTS };
    }),
  ];
  const levels = [...new Set(rows.map((row) => row.points))].sort((first, second) => second - first);
  const ranking = rows
    .map((row) => ({ ...row, playerName: room.players.get(row.playerId)?.name || '', position: levels.indexOf(row.points) + 1 }))
    .sort((first, second) => first.position - second.position);
  cannon.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.role === 'cannoneer' ? entry.kills : entry.rounds,
    answeredCount: entry.role === 'cannoneer' ? cannon.victims.length : CANNON_ROUNDS,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
  sendPrivateStates(room);
}

/** Si el canonero se va mientras apunta, dispara al azar enseguida; si se van los de abajo, puede cerrarse antes. */
function maybeCannonAway(room) {
  const cannon = room.match?.specialRound?.cannon;

  if (cannon?.stage === 'aiming' && !room.players.get(cannon.cannoneerId)?.active) {
    const round = cannon.round;
    setRoomTimer(room, 'cannon', Math.min(cannon.aimEndsAt, Date.now() + CANNON_AWAY_MS), () => fireCannon(room, round, crypto.randomInt(CANNON_ZONES)));
  }

  maybeSettleCannonChoosing(room);
}

function toPublicCannon(cannon) {
  if (!cannon) {
    return null;
  }

  // Donde se ha puesto cada uno no se publica hasta el disparo (los de abajo lo reciben en su estado privado).
  const revealed = cannon.stage === 'firing' || cannon.stage === 'result' || cannon.stage === 'finished';
  return {
    stage: cannon.stage,
    cannoneerId: cannon.cannoneerId,
    victims: cannon.victims,
    alive: cannon.victims.filter((playerId) => cannon.alive.has(playerId)),
    round: cannon.round,
    totalRounds: CANNON_ROUNDS,
    zones: CANNON_ZONES,
    chooseStartsAt: cannon.chooseStartsAt,
    chooseEndsAt: cannon.chooseEndsAt,
    aimEndsAt: cannon.aimEndsAt,
    pickedPlayerIds: [...cannon.picks.keys()],
    target: revealed ? cannon.target : null,
    positions: revealed ? cannon.positions : [],
    fireAt: cannon.fireAt,
    impactAt: cannon.impactAt,
    nextAt: cannon.nextAt,
    history: cannon.history,
    kills: cannon.kills,
    pointsPerKill: cannon.pointsPerKill,
    survivePoints: CANNON_SURVIVE_POINTS,
    outcome: cannon.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Bomberman                                                           */
/* ------------------------------------------------------------------ */
// - Arena cuadrada en cuadricula (11x11 hasta 5 jugadores; mas grande con mas): pared exterior, columnas fijas en
//   las casillas pares y piedras en todo lo demas salvo los spawns (la casilla y sus 4 vecinas).
// - Cada cliente mueve su personaje casilla a casilla (al instante en su pantalla) y envia solo la casilla nueva
//   al cambiar; el servidor la reenvia a los demas en un evento ligero (sin el estado completo).
// - Bombas: se envian una sola vez, con su hora de explosion en el reloj comun (puesta + 5 s). Cada cliente la
//   hace explotar a esa hora (todas a la vez) calculando la cruz con la misma regla; el servidor hace lo mismo y
//   publica el mapa resultante (piedras rotas, mejoras nuevas). Las mejoras solas las decide el servidor.
// - Cada cliente decide si su personaje esta en una llama (como los atropellos de la carretera) y lo avisa.
// - Gana el ultimo en pie (si caen todos a la vez, empatan). Tiempo maximo: si se acaba, empatan los vivos.

const BM_FUSE_MS = 5000;
const BM_START_RADIUS = 3;
const BM_START_BOMBS = 1;
// Probabilidad de que una piedra rota deje una mejora.
const BM_POWERUP_CHANCE = 0.3;
const BM_LEAD_MS = 3000;
const BM_DURATION_MS = 180000;
// Tras una baja se espera un poco por si caen mas en la misma explosion (empate).
const BM_SETTLE_MS = 1300;
// Margen para la hora de colocacion que envia el cliente (latencia).
const BM_PLACE_SLACK_MS = 400;
const BM_MIN_SPAWN_DISTANCE = 5;

function bombermanSize(players) {
  if (players <= 2) return 11;
  if (players <= 4) return 13;
  if (players <= 9) return 15;
  if (players <= 14) return 17;
  if (players <= 20) return 19;
  return 21;
}

/** Casillas de aparicion segun el numero de jugadores (todas en suelo: nunca en columnas). */
function bombermanSpawns(size, count) {
  const last = size - 2;
  const center = (size - 1) / 2;
  const fix = (x, y) => (x % 2 === 0 && y % 2 === 0 ? [x + 1, y + 1] : [x, y]);
  const corners = secureShuffle([
    [1, 1],
    [last, last],
    [last, 1],
    [1, last],
  ]);
  let spots;

  if (count === 2) {
    // Esquinas en diagonal.
    spots = [corners[0], [size - 1 - corners[0][0], size - 1 - corners[0][1]]];
  } else if (count <= 4) {
    spots = corners.slice(0, count);
  } else if (count === 5) {
    spots = [...corners, fix(center, center)];
  } else {
    const sides = secureShuffle([
      [center, 1],
      [1, center],
      [last, center],
      [center, last],
    ]).map(([x, y]) => fix(x, y));
    spots = [...corners, ...sides, fix(center, center)].slice(0, count);
  }

  // Si no hay bastantes, al azar a 5 casillas (o mas) de todos los demas. Se prueba varias veces antes de
  // conformarse con menos distancia (solo si el mapa no da para mas).
  const distance = (first, second) => Math.abs(first[0] - second[0]) + Math.abs(first[1] - second[1]);
  const fixed = spots;

  for (let minimum = BM_MIN_SPAWN_DISTANCE; minimum >= 1; minimum -= 1) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const placed = [...fixed];

      while (placed.length < count) {
        const free = [];

        for (let y = 1; y <= last; y += 1) {
          for (let x = 1; x <= last; x += 1) {
            if (!(x % 2 === 0 && y % 2 === 0) && placed.every((spot) => distance(spot, [x, y]) >= minimum)) {
              free.push([x, y]);
            }
          }
        }

        if (!free.length) {
          break;
        }

        placed.push(free[crypto.randomInt(free.length)]);
      }

      if (placed.length === count) {
        return placed;
      }
    }
  }

  return spots;
}

/**
 * Mapa inicial: 'W' pared exterior, 'C' columna, 'S' piedra, '.' suelo. Todo es piedra salvo las columnas y la
 * zona de cada spawn (su casilla y sus 4 vecinas ortogonales si no son pared ni columna).
 */
function bombermanMap(size, spawns) {
  const cells = [];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      cells.push(x === 0 || y === 0 || x === size - 1 || y === size - 1 ? 'W' : x % 2 === 0 && y % 2 === 0 ? 'C' : 'S');
    }
  }

  for (const [x, y] of spawns) {
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const index = (y + dy) * size + (x + dx);

      if (cells[index] === 'S') {
        cells[index] = '.';
      }
    }
  }

  return cells;
}

/**
 * Explosion (con reaccion en cadena) de un grupo de bombas sobre una foto del mapa: cada bomba hace una cruz de
 * su radio; las piedras se rompen y paran la llama, las columnas y la pared la paran sin romperse, y cualquier
 * otra bomba alcanzada explota en el acto. Como se calcula sobre la foto inicial, el orden no cambia el
 * resultado. Misma funcion en el cliente (bomberman-rules.ts).
 */
function bombermanBlast(size, cells, bombs, triggerIds) {
  const byCell = new Map(bombs.map((bomb) => [bomb.y * size + bomb.x, bomb]));
  const detonated = new Set();
  const queue = [...triggerIds];
  const hit = new Set();
  const stones = new Set();

  while (queue.length) {
    const id = queue.shift();

    if (detonated.has(id)) {
      continue;
    }

    const bomb = bombs.find((item) => item.id === id);

    if (!bomb) {
      continue;
    }

    detonated.add(id);
    hit.add(bomb.y * size + bomb.x);

    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      for (let step = 1; step <= bomb.radius; step += 1) {
        const x = bomb.x + dx * step;
        const y = bomb.y + dy * step;

        if (x < 0 || y < 0 || x >= size || y >= size) {
          break;
        }

        const index = y * size + x;
        const cell = cells[index];

        if (cell === 'W' || cell === 'C') {
          break;
        }

        hit.add(index);
        const other = byCell.get(index);

        if (other && !detonated.has(other.id)) {
          queue.push(other.id);
        }

        if (cell === 'S') {
          stones.add(index);
          break;
        }
      }
    }
  }

  return { detonated: [...detonated], hit: [...hit].sort((a, b) => a - b), stones: [...stones].sort((a, b) => a - b) };
}

function setupBomberman(room) {
  const specialRound = room.match.specialRound;
  const ids = secureShuffle(specialRound.participantIds);
  const size = bombermanSize(ids.length);
  const spawns = bombermanSpawns(size, ids.length);
  const startsAt = specialRound.introEndsAt + BM_LEAD_MS;

  specialRound.bomberman = {
    stage: 'playing',
    size,
    cells: bombermanMap(size, spawns),
    players: new Map(
      ids.map((playerId, index) => [
        playerId,
        { x: spawns[index][0], y: spawns[index][1], alive: true, radius: BM_START_RADIUS, capacity: BM_START_BOMBS, deathAt: null },
      ]),
    ),
    bombs: [],
    powerups: [],
    blasts: [],
    nextBombId: 1,
    nextBlastId: 1,
    lastBoomAt: 0,
    startsAt,
    endsAt: startsAt + BM_DURATION_MS,
    outcome: null,
  };

  setRoomTimer(room, 'bomberman-end', specialRound.bomberman.endsAt, () => finishBomberman(room));
}

/** Programa el temporizador para la proxima bomba que toque. */
function scheduleBombermanBoom(room) {
  const bm = room.match?.specialRound?.bomberman;

  if (!bm || bm.outcome) {
    return;
  }

  if (!bm.bombs.length) {
    clearRoomTimer(room, 'bomberman');
    return;
  }

  const next = Math.min(...bm.bombs.map((bomb) => bomb.explodeAt));
  setRoomTimer(room, 'bomberman', next, () => explodeBombermanBombs(room));
}

/** Explotan las bombas cuya hora ha llegado (y todas las que alcancen en cadena). */
function explodeBombermanBombs(room) {
  const bm = room.match?.specialRound?.bomberman;

  if (!bm || bm.outcome) {
    return;
  }

  const now = Date.now();
  const due = bm.bombs.filter((bomb) => bomb.explodeAt <= now + 5).sort((first, second) => first.explodeAt - second.explodeAt || first.id - second.id);

  if (!due.length) {
    scheduleBombermanBoom(room);
    return;
  }

  // Cada bomba vencida (si no la ha detonado ya otra) abre su propio grupo, a su hora.
  while (due.length) {
    const first = due.shift();

    if (!bm.bombs.includes(first)) {
      continue;
    }

    const result = bombermanBlast(bm.size, bm.cells, bm.bombs, [first.id]);
    const at = first.explodeAt;
    bm.bombs = bm.bombs.filter((bomb) => !result.detonated.includes(bomb.id));

    for (const index of result.stones) {
      bm.cells[index] = '.';
    }

    // Las mejoras alcanzadas se queman; despues aparecen las nuevas en las piedras rotas.
    bm.powerups = bm.powerups.filter((powerup) => !result.hit.includes(powerup.y * bm.size + powerup.x));
    const spawned = [];

    for (const index of result.stones) {
      if (crypto.randomInt(1000) < BM_POWERUP_CHANCE * 1000) {
        const powerup = { x: index % bm.size, y: Math.floor(index / bm.size), type: crypto.randomInt(2) ? 'radius' : 'bombs' };
        bm.powerups.push(powerup);
        spawned.push(powerup);
      }
    }

    bm.blasts.push({ id: bm.nextBlastId, at, bombIds: result.detonated, hit: result.hit, stones: result.stones, powerups: spawned });
    bm.blasts = bm.blasts.slice(-12);
    bm.nextBlastId += 1;
    bm.lastBoomAt = Math.max(bm.lastBoomAt, at);

    // Los que no estan conectados no pueden avisar: cuenta su ultima casilla conocida.
    for (const [playerId, player] of bm.players) {
      if (player.alive && !room.players.get(playerId)?.active && result.hit.includes(player.y * bm.size + player.x)) {
        eliminateBombermanPlayer(room, playerId, at);
      }
    }
  }

  emitMatchState(room);
  scheduleBombermanBoom(room);
}

function eliminateBombermanPlayer(room, playerId, at) {
  const bm = room.match.specialRound.bomberman;
  const player = bm.players.get(playerId);

  if (!player?.alive) {
    return false;
  }

  player.alive = false;
  player.deathAt = at;
  // Se espera un momento por si caen mas en la misma explosion antes de ver si ha terminado.
  setRoomTimer(room, 'bomberman-settle', Date.now() + BM_SETTLE_MS, () => {
    const alive = [...bm.players.entries()].filter(([id, entry]) => entry.alive && room.players.get(id)?.active);

    if (alive.length <= 1) {
      finishBomberman(room);
    }
  });
  return true;
}

function finishBomberman(room) {
  const specialRound = room.match?.specialRound;
  const bm = specialRound?.bomberman;

  if (!bm || bm.outcome) {
    return;
  }

  clearRoomTimer(room, 'bomberman');
  clearRoomTimer(room, 'bomberman-end');
  clearRoomTimer(room, 'bomberman-settle');
  bm.stage = 'finished';
  // Primero los que siguen en pie (empatados entre si); despues, cuanto mas tarde cayo, mejor. Los que caen en
  // la misma explosion empatan.
  const entries = [...bm.players.entries()].map(([playerId, player]) => ({ playerId, ...player, key: player.alive ? Infinity : player.deathAt }));
  const levels = [...new Set(entries.map((entry) => entry.key))].sort((first, second) => second - first);
  const ranking = entries
    .map((entry) => ({
      playerId: entry.playerId,
      playerName: room.players.get(entry.playerId)?.name || '',
      survived: entry.alive,
      position: levels.indexOf(entry.key) + 1,
      points: ladderPoints(levels.indexOf(entry.key), levels.length),
    }))
    .sort((first, second) => first.position - second.position);
  const winners = ranking.filter((row) => row.position === 1);
  bm.outcome = { ranking, draw: winners.length > 1, winnerId: winners.length === 1 ? winners[0].playerId : null };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.position === 1 ? 1 : 0,
    answeredCount: 1,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

/** Si quedan menos de dos conectados vivos (alguien se ha ido), se acaba. */
function maybeFinishBomberman(room) {
  const bm = room.match?.specialRound?.bomberman;

  if (bm && !bm.outcome && [...bm.players.entries()].filter(([id, player]) => player.alive && room.players.get(id)?.active).length <= 1) {
    setRoomTimer(room, 'bomberman-settle', Date.now() + BM_SETTLE_MS, () => {
      if ([...bm.players.entries()].filter(([id, player]) => player.alive && room.players.get(id)?.active).length <= 1) {
        finishBomberman(room);
      }
    });
  }
}

function toPublicBomberman(bm) {
  if (!bm) {
    return null;
  }

  return {
    stage: bm.stage,
    size: bm.size,
    cells: bm.cells.join(''),
    players: [...bm.players.entries()].map(([playerId, player]) => ({ playerId, ...player })),
    bombs: bm.bombs.map(({ id, owner, x, y, radius, explodeAt }) => ({ id, owner, x, y, radius, explodeAt })),
    powerups: bm.powerups,
    blasts: bm.blasts,
    lastBoomAt: bm.lastBoomAt,
    startsAt: bm.startsAt,
    endsAt: bm.endsAt,
    fuseMs: BM_FUSE_MS,
    outcome: bm.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Snake                                                               */
/* ------------------------------------------------------------------ */
// - Tablero cuadrado (mas grande cuantos mas jugadores) con una serpiente por jugador, repartidas en circulo.
// - Cada cliente mueve su serpiente al momento (paso fijo) y envia solo la casilla nueva de la cabeza; el servidor
//   la reenvia a los demas en un evento ligero y lleva el cuerpo de cada una (para quien llega tarde).
// - Frutas: siempre una por jugador; al comerse una aparece otra en una casilla libre. Cada fruta alarga 2.
// - Cada cliente decide si su cabeza choca (pared, otra serpiente o ella misma) y lo avisa.
// - Termina cuando queda una (o ninguna) o se acaba el tiempo. Primero los que siguen vivos (por largo); despues
//   los demas por el largo que tenian al caer (y, a igualdad, quien cayo mas tarde).

const SN_STEP_MS = 125;
const SN_START_LENGTH = 4;
const SN_GROW = 2;
const SN_LEAD_MS = 3000;
const SN_DURATION_MS = 150000;
const SN_SETTLE_MS = 1200;
// Quien se desconecta (sin volver en este tiempo) queda fuera.
const SN_AWAY_MS = 4000;

function snakeSize(players) {
  if (players <= 2) return 22;
  if (players <= 4) return 26;
  if (players <= 6) return 30;
  if (players <= 8) return 34;
  if (players <= 10) return 38;
  if (players <= 14) return 42;
  return 46;
}

/** Serpientes repartidas en un circulo, mirando en el sentido de las agujas del reloj (sin chocar al empezar). */
function snakeSpawns(size, count) {
  const center = (size - 1) / 2;
  const radius = size * 0.33;
  const offset = Math.random() * Math.PI * 2;
  return Array.from({ length: count }, (_unused, index) => {
    const angle = offset + (index / count) * Math.PI * 2;
    const x = Math.round(center + Math.cos(angle) * radius);
    const y = Math.round(center + Math.sin(angle) * radius);
    const tx = -Math.sin(angle);
    const ty = Math.cos(angle);
    const dir = Math.abs(tx) > Math.abs(ty) ? [Math.sign(tx), 0] : [0, Math.sign(ty)];
    // El cuerpo, detras de la cabeza.
    const body = Array.from({ length: SN_START_LENGTH }, (_value, step) => [x - dir[0] * step, y - dir[1] * step]);
    return { body, dir };
  });
}

function snakeOccupied(sn) {
  const cells = new Set();

  for (const player of sn.players.values()) {
    if (player.alive) {
      for (const [x, y] of player.body) {
        cells.add(y * sn.size + x);
      }
    }
  }

  for (const fruit of sn.fruits) {
    cells.add(fruit.y * sn.size + fruit.x);
  }

  return cells;
}

/** Fruta nueva en una casilla libre (lejos de las cabezas para que no aparezca en la boca de nadie). */
function spawnSnakeFruit(sn) {
  const occupied = snakeOccupied(sn);
  const heads = [...sn.players.values()].filter((player) => player.alive).map((player) => player.body[0]);

  for (let attempt = 0; attempt < 400; attempt += 1) {
    const x = crypto.randomInt(sn.size);
    const y = crypto.randomInt(sn.size);

    if (!occupied.has(y * sn.size + x) && heads.every(([hx, hy]) => Math.abs(hx - x) + Math.abs(hy - y) > 2)) {
      sn.fruits.push({ id: sn.nextFruitId, x, y });
      sn.nextFruitId += 1;
      return;
    }
  }
}

function setupSnake(room) {
  const specialRound = room.match.specialRound;
  const ids = secureShuffle(specialRound.participantIds);
  const size = snakeSize(ids.length);
  const spawns = snakeSpawns(size, ids.length);
  const startsAt = specialRound.introEndsAt + SN_LEAD_MS;

  specialRound.snake = {
    stage: 'playing',
    size,
    players: new Map(
      ids.map((playerId, index) => [
        playerId,
        { body: spawns[index].body, dir: spawns[index].dir, length: SN_START_LENGTH, alive: true, deathAt: null, eaten: 0, seq: 0 },
      ]),
    ),
    fruits: [],
    nextFruitId: 1,
    startsAt,
    endsAt: startsAt + SN_DURATION_MS,
    outcome: null,
  };

  for (let index = 0; index < ids.length; index += 1) {
    spawnSnakeFruit(specialRound.snake);
  }

  setRoomTimer(room, 'snake-end', specialRound.snake.endsAt, () => finishSnake(room));
}

function eliminateSnakePlayer(room, playerId, at) {
  const sn = room.match.specialRound.snake;
  const player = sn.players.get(playerId);

  if (!player?.alive) {
    return false;
  }

  player.alive = false;
  player.deathAt = at;
  setRoomTimer(room, 'snake-settle', Date.now() + SN_SETTLE_MS, () => {
    if ([...sn.players.values()].filter((entry) => entry.alive).length <= 1) {
      finishSnake(room);
    }
  });
  return true;
}

function finishSnake(room) {
  const specialRound = room.match?.specialRound;
  const sn = specialRound?.snake;

  if (!sn || sn.outcome) {
    return;
  }

  clearRoomTimer(room, 'snake-end');
  clearRoomTimer(room, 'snake-settle');
  sn.stage = 'finished';
  const entries = [...sn.players.entries()].map(([playerId, player]) => ({ playerId, ...player }));
  // Clave de orden: vivos antes que caidos; despues el largo; a igualdad, quien cayo mas tarde.
  const key = (entry) => `${entry.alive ? 1 : 0}:${String(entry.length).padStart(5, '0')}:${entry.alive ? '' : String(entry.deathAt).padStart(15, '0')}`;
  const levels = [...new Set(entries.map(key))].sort().reverse();
  const ranking = entries
    .map((entry) => ({
      playerId: entry.playerId,
      playerName: room.players.get(entry.playerId)?.name || '',
      survived: entry.alive,
      length: entry.length,
      eaten: entry.eaten,
      position: levels.indexOf(key(entry)) + 1,
      points: ladderPoints(levels.indexOf(key(entry)), levels.length),
    }))
    .sort((first, second) => first.position - second.position);
  sn.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.eaten,
    answeredCount: entry.eaten,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

/** Quien se desconecta en plena partida queda fuera si no vuelve enseguida. */
function maybeSnakeAway(room) {
  const sn = room.match?.specialRound?.snake;

  if (!sn || sn.outcome) {
    return;
  }

  for (const [playerId, player] of sn.players) {
    // Una sola cuenta por desconexion (si se vuelve a revisar, no se alarga).
    if (player.alive && !room.players.get(playerId)?.active && !room.timers?.has(`snake-away-${playerId}`)) {
      setRoomTimer(room, `snake-away-${playerId}`, Date.now() + SN_AWAY_MS, () => {
        if (room.match?.specialRound?.snake === sn && !room.players.get(playerId)?.active && eliminateSnakePlayer(room, playerId, Date.now())) {
          emitMatchState(room);
        }
      });
    }
  }
}

function toPublicSnake(sn) {
  if (!sn) {
    return null;
  }

  return {
    stage: sn.stage,
    size: sn.size,
    players: [...sn.players.entries()].map(([playerId, player]) => ({
      playerId,
      body: player.body,
      dir: player.dir,
      length: player.length,
      alive: player.alive,
      deathAt: player.deathAt,
      eaten: player.eaten,
    })),
    fruits: sn.fruits,
    startsAt: sn.startsAt,
    endsAt: sn.endsAt,
    stepMs: SN_STEP_MS,
    grow: SN_GROW,
    outcome: sn.outcome,
  };
}

/* ------------------------------------------------------------------ */
/* Carrera                                                             */
/* ------------------------------------------------------------------ */
// - Carrera 2D vista desde arriba en uno de los circuitos (al azar), a 2 vueltas. La geometria de los circuitos
//   y la fisica de los coches viven en el cliente.
// - Cada cliente conduce su coche al momento y envia su posicion ~10 veces por segundo (con lo que lleva
//   recorrido); el servidor la reenvia a los demas en un evento ligero. Al cruzar la meta, el cliente envia su
//   tiempo (medido con el reloj comun desde la salida) y eso es lo que cuenta.
// - Cada circuito tiene un tiempo maximo: quien no termina se queda sin terminar (-15). Entre los que terminan,
//   escalera de 30 (primero) a 0 (ultimo).

const RACE_MAPS = [
  { id: 'bosque', timeLimitMs: 600000 },
  { id: 'circuito', timeLimitMs: 600000 },
  { id: 'canon', timeLimitMs: 600000 },
];
const RACE_LAPS = 2;
// Semaforo de salida: 3, 2, 1, ¡ya!
const RACE_LEAD_MS = 4000;
const RACE_DNF_POINTS = -15;
// Tiempo minimo creible para terminar (para descartar envios imposibles).
const RACE_MIN_TIME_MS = 20000;
// Tras cruzar la meta el ultimo, un momento para verlo antes de los resultados.
const RACE_FINISH_DELAY_MS = 1500;

function setupRace(room) {
  const specialRound = room.match.specialRound;
  const map = RACE_MAPS[crypto.randomInt(RACE_MAPS.length)];
  const ids = secureShuffle(specialRound.participantIds);
  const startsAt = specialRound.introEndsAt + RACE_LEAD_MS;

  specialRound.race = {
    stage: 'racing',
    mapId: map.id,
    laps: RACE_LAPS,
    startsAt,
    endsAt: startsAt + map.timeLimitMs,
    players: new Map(ids.map((playerId, slot) => [playerId, { slot, x: null, y: null, a: 0, progress: 0, index: null, checkpoint: 0, finishMs: null, seq: 0 }])),
    outcome: null,
  };

  setRoomTimer(room, 'race-end', specialRound.race.endsAt, () => finishRace(room));
}

/** Si ya han llegado todos los que siguen conectados, se cierra la carrera. */
function maybeFinishRace(room) {
  const race = room.match?.specialRound?.race;

  if (!race || race.outcome) {
    return;
  }

  const pending = [...race.players.entries()].filter(([playerId, player]) => player.finishMs === null && room.players.get(playerId)?.active);

  if (!pending.length) {
    setRoomTimer(room, 'race-end', Date.now() + RACE_FINISH_DELAY_MS, () => finishRace(room));
  }
}

function finishRace(room) {
  const specialRound = room.match?.specialRound;
  const race = specialRound?.race;

  if (!race || race.outcome) {
    return;
  }

  clearRoomTimer(room, 'race-end');
  race.stage = 'finished';
  const entries = [...race.players.entries()].map(([playerId, player]) => ({ playerId, ...player }));
  const finishers = entries.filter((entry) => entry.finishMs !== null).sort((first, second) => first.finishMs - second.finishMs);
  const others = entries.filter((entry) => entry.finishMs === null).sort((first, second) => second.progress - first.progress);
  const levels = [...new Set(finishers.map((entry) => entry.finishMs))];
  const ranking = [
    ...finishers.map((entry) => ({ entry, level: levels.indexOf(entry.finishMs), points: ladderPoints(levels.indexOf(entry.finishMs), levels.length) })),
    ...others.map((entry, index) => ({ entry, level: levels.length + index, points: RACE_DNF_POINTS })),
  ].map(({ entry, level, points }) => ({
    playerId: entry.playerId,
    playerName: room.players.get(entry.playerId)?.name || '',
    finished: entry.finishMs !== null,
    timeMs: entry.finishMs,
    progress: entry.progress,
    position: level + 1,
    points,
  }));
  race.outcome = { ranking };
  specialRound.results = ranking.map((entry) => ({
    playerId: entry.playerId,
    playerName: entry.playerName,
    points: entry.points,
    correctCount: entry.finished ? 1 : 0,
    answeredCount: 1,
    finishedAt: null,
    submitted: true,
  }));
  specialRound.hasResults = true;
  emitMatchState(room);
}

function toPublicRace(race) {
  if (!race) {
    return null;
  }

  return {
    stage: race.stage,
    mapId: race.mapId,
    laps: race.laps,
    startsAt: race.startsAt,
    endsAt: race.endsAt,
    players: [...race.players.entries()].map(([playerId, player]) => ({
      playerId,
      slot: player.slot,
      x: player.x,
      y: player.y,
      a: player.a,
      progress: player.progress,
      index: player.index ?? null,
      checkpoint: player.checkpoint ?? 0,
      finishMs: player.finishMs,
    })),
    dnfPoints: RACE_DNF_POINTS,
    outcome: race.outcome,
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
  maybeCloseDanceRound(room);
  maybeFinishCount(room);
  maybeRevealStopwatch(room);
  maybeFinishTower(room);
  maybeStartBeerSlide(room);
  maybeRevealGolf(room);
  maybeCloseOrderRound(room);
  maybeStartBowlingRoll(room);
  maybeRevealWho(room);
  maybeFinishCrossy(room);
  maybeEndJavelin(room);
  maybeRevealQuiz(room);
  maybeLaunchPush(room);
  maybeRussianAway(room);
  maybeBombAway(room);
  maybeCannonAway(room);
  maybeFinishBomberman(room);
  maybeSnakeAway(room);
  maybeFinishRace(room);
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
  // Los plazos privados (p. ej. la mecha de la bomba) tambien se han desplazado.
  sendPrivateStates(room);
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
      // Minijuegos jugados en el ciclo actual (no se repiten hasta que se hayan jugado todos).
      cycleMinigameIds: [],
      playedMinigameIds: new Set(),
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

  // Pista de baile: el cliente juega solo y aqui solo avisa de como le ha ido en la ronda.
  const getDanceRequest = (payload, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const dance = room?.match?.specialRound?.dance;

    if (!room || !player || !dance || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay pista de baile en juego.' });
      return null;
    }

    if (dance.stage !== 'playing' || Number(payload.round) !== dance.round) {
      callback?.({ ok: false, reason: 'Esa ronda ya no esta en juego.' });
      return null;
    }

    if (!dance.alive.has(player.id)) {
      callback?.({ ok: false, reason: 'Ya estas fuera de la pista.' });
      return null;
    }

    return { room, player, dance };
  };

  socket.on('match:dance-done', (payload = {}, callback) => {
    const request = getDanceRequest(payload, callback);

    if (!request) {
      return;
    }

    const { room, player, dance } = request;
    const now = Date.now();
    const minimumMs = DANCE_LENGTHS[dance.round - 1] * DANCE_MIN_MS_PER_KEY;

    if (now < dance.roundStartsAt + minimumMs || now > dance.roundEndsAt + DANCE_GRACE_MS) {
      callback?.({ ok: false, reason: 'Secuencia fuera de tiempo.' });
      return;
    }

    // Terminar no se reparte a nadie (no hace falta): solo se apunta para no eliminarle al cerrar la ronda.
    dance.done.add(player.id);
    callback?.({ ok: true });
    maybeCloseDanceRound(room);
  });

  // ¿Cuantos hay?: una unica respuesta por jugador, solo cuando ya ha pasado todo el mundo.
  socket.on('match:count-answer', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const count = room?.match?.specialRound?.count;
    const value = Number(payload.value);

    if (!room || !player || !count || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay nada que contar ahora.' });
      return;
    }

    if (count.outcome || Date.now() < count.watchEndsAt || Date.now() > count.answerEndsAt + COUNT_GRACE_MS) {
      callback?.({ ok: false, reason: 'Ahora no se puede responder.' });
      return;
    }

    if (count.answers.has(player.id)) {
      callback?.({ ok: true, ignored: true, value: count.answers.get(player.id) });
      return;
    }

    if (!Number.isInteger(value) || value < 0 || value > 999) {
      callback?.({ ok: false, reason: 'Escribe un número entre 0 y 999.' });
      return;
    }

    count.stage = 'answering';
    count.answers.set(player.id, value);
    emitMatchState(room);
    callback?.({ ok: true, value });
    maybeFinishCount(room);
  });

  // Desenfundar: el cliente mide su reaccion desde que ve la senal y solo envia el resultado (o la falta).
  socket.on('match:duel-shot', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const duel = room?.match?.specialRound?.duel;

    if (!room || !player || !duel || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay duelo en juego.' });
      return;
    }

    if (duel.stage !== 'waiting' || Number(payload.round) !== duel.round) {
      callback?.({ ok: false, reason: 'Esa ronda ya ha terminado.' });
      return;
    }

    if (duel.shots.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    const foul = Boolean(payload.foul);
    const reactionMs = Math.round(Number(payload.reactionMs));

    if (!foul && (!Number.isFinite(reactionMs) || reactionMs < DUEL_MIN_REACTION_MS || reactionMs > 10000)) {
      callback?.({ ok: false, reason: 'Disparo no válido.' });
      return;
    }

    // No se reparte a nadie: el resultado de todos sale junto al acabar la ronda.
    duel.shots.set(player.id, foul ? { foul: true } : { reactionMs });
    callback?.({ ok: true });
  });

  // Para el cronometro: el tiempo lo mide el cliente; aqui solo se apunta (una vez por ronda).
  // Torre de cajas: cada caja colocada (o la caida) se apunta y se reparte para que el resto vea tu altura.
  socket.on('match:tower-progress', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const tower = room?.match?.specialRound?.tower;
    const level = Math.trunc(Number(payload.level));
    const now = Date.now();

    if (!room || !player || !tower || room.match.phase !== 'special-round' || !tower.levels.has(player.id)) {
      callback?.({ ok: false, reason: 'No hay torre en juego.' });
      return;
    }

    if (tower.stage !== 'playing' || tower.finished.has(player.id) || now > tower.endsAt + TOWER_GRACE_MS) {
      callback?.({ ok: false, reason: 'La torre ya está cerrada.' });
      return;
    }

    const maxPlausible = Math.floor(Math.max(0, now - tower.startsAt + 500) / TOWER_MIN_MS_PER_BOX);

    if (!Number.isInteger(level) || level < (tower.levels.get(player.id) || 0) || level > maxPlausible) {
      callback?.({ ok: false, reason: 'Altura no válida.' });
      return;
    }

    tower.levels.set(player.id, level);

    if (payload.lost) {
      tower.lost.add(player.id);
    }

    if (payload.lost || payload.finished) {
      tower.finished.add(player.id);
    }

    emitMatchState(room);
    callback?.({ ok: true });
    maybeFinishTower(room);
  });

  // Jarras: el medidor corre en el cliente; aqui solo llega la fuerza elegida (una vez).
  // Corta verduras: cada cliente cuenta sus clics y al acabar envia cuantas verduras ha cortado (una vez).
  // Mini golf: el cliente ya ha simulado su golpe; envia el tiro (para que los demas lo reproduzcan) y su resultado.
  socket.on('match:golf-shot', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const golf = room?.match?.specialRound?.golf;
    const angle = Number(payload.angle);
    const power = Number(payload.power);
    const distance = Number(payload.distance);

    if (!room || !player || !golf || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay golf en juego.' });
      return;
    }

    if (golf.stage !== 'aiming' || Number(payload.round) !== golf.round || Date.now() > golf.aimEndsAt + 1000) {
      callback?.({ ok: false, reason: 'Ya no se puede tirar en esta ronda.' });
      return;
    }

    if (golf.shots.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (![angle, power, distance].every(Number.isFinite) || power < 0 || power > 1 || distance < 0) {
      callback?.({ ok: false, reason: 'Tiro no válido.' });
      return;
    }

    const holed = Boolean(payload.holed);
    const rollMs = Number(payload.rollMs);
    golf.shots.set(player.id, {
      angle: Math.round(angle * 100000) / 100000,
      power: Math.round(power * 100000) / 100000,
      holed,
      distance: holed ? 0 : Math.min(GOLF_MISS_DISTANCE, Math.round(distance)),
      // Lo que tarda la bola en pararse (simulado en el cliente); sin dato se espera el tope.
      rollMs: Number.isFinite(rollMs) ? Math.max(0, Math.min(GOLF_ROLL_MS, Math.round(rollMs))) : GOLF_ROLL_MS,
    });
    emitMatchState(room);
    callback?.({ ok: true });
    maybeRevealGolf(room);
  });

  // Memoriza el pedido: resultado de la ronda en el cliente (completada o no y cuanto ha tardado).
  socket.on('match:order-report', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const order = room?.match?.specialRound?.order;
    const ms = Math.round(Number(payload.ms));

    if (!room || !player || !order || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay pedidos en juego.' });
      return;
    }

    if (order.stage !== 'showing' || Number(payload.round) !== order.round) {
      callback?.({ ok: false, reason: 'Esa ronda ya ha terminado.' });
      return;
    }

    if (order.reports.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    const minimumMs = ORDER_LAYERS[order.round - 1] * 120;
    const success = Boolean(payload.success) && Number.isFinite(ms) && ms >= minimumMs && ms <= ORDER_BUILD_MS + 500;
    order.reports.set(player.id, { success, ms: success ? ms : ORDER_BUILD_MS });
    emitMatchState(room);
    callback?.({ ok: true, success });
    maybeCloseOrderRound(room);
  });

  // Bolos: el cliente ha simulado su tirada; solo llegan los bolos derribados (y la tirada, por si acaso).
  socket.on('match:bowling-throw', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const bowling = room?.match?.specialRound?.bowling;
    const pins = Math.trunc(Number(payload.pins));

    if (!room || !player || !bowling || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay bolera en juego.' });
      return;
    }

    if (bowling.stage !== 'aiming') {
      callback?.({ ok: false, reason: 'Ya se han lanzado las bolas.' });
      return;
    }

    if (bowling.throws.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (!Number.isInteger(pins) || pins < 0 || pins > 10) {
      callback?.({ ok: false, reason: 'Número de bolos no válido.' });
      return;
    }

    bowling.throws.set(player.id, { pins, aim: Number(payload.aim) || 0, spin: Number(payload.spin) || 0 });
    emitMatchState(room);
    callback?.({ ok: true });
    maybeStartBowlingRoll(room);
  });

  // ¿Quien es quien?: voto secreto de la ronda (vale votarse a uno mismo; no se puede cambiar el voto).
  socket.on('match:who-vote', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const who = room?.match?.specialRound?.who;
    const targetId = String(payload.targetId || '');

    if (!room || !player || !who || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay votación en juego.' });
      return;
    }

    if (who.stage !== 'voting' || Number(payload.round) !== who.round) {
      callback?.({ ok: false, reason: 'Ahora no se puede votar.' });
      return;
    }

    if (who.votes.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    // Uno puede votarse a si mismo (si cree que la pregunta va por el).
    if (!room.match.specialRound.participantIds.includes(targetId)) {
      callback?.({ ok: false, reason: 'Voto no válido.' });
      return;
    }

    who.votes.set(player.id, targetId);
    emitMatchState(room);
    callback?.({ ok: true });
    maybeRevealWho(room);
  });

  // Cruza la carretera: el cliente manda su posicion (cada ~500 ms, o al morir / llegar a la meta). Los atropellos
  // los detecta el propio cliente; aqui solo se descartan avances imposibles.
  socket.on('match:crossy-move', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const crossy = room?.match?.specialRound?.crossy;
    const row = Math.trunc(Number(payload.row));
    const col = Math.trunc(Number(payload.col));
    const now = Date.now();

    if (!room || !player || !crossy || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay carretera en juego.' });
      return;
    }

    const state = crossy.players.get(player.id);

    if (crossy.stage !== 'playing' || !state || state.dead || state.finishedAt || now < crossy.startsAt - 500 || now > crossy.endsAt + 1000) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    const maxRow = Math.floor((now - crossy.startsAt + 500) / CROSSY_MIN_MS_PER_HOP);

    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > Math.min(CROSSY_FINISH_ROW, maxRow) || Math.abs(col) > 4) {
      callback?.({ ok: false, reason: 'Posición no válida.' });
      return;
    }

    state.row = row;
    state.col = col;
    state.best = Math.max(state.best, row);
    const finished = row >= CROSSY_FINISH_ROW;
    const dead = !finished && Boolean(payload.dead);

    if (finished) {
      state.finishedAt = now;
    }

    state.dead = dead;
    io.to(room.code).emit('match:crossy-move', { lobbyId: room.code, playerId: player.id, row, col, best: state.best, dead, finished });
    callback?.({ ok: true });

    if (dead || finished) {
      emitMatchState(room);
      maybeFinishCrossy(room);
    }
  });

  // Tiro de jabalina: el cliente ya ha simulado el tiro; llega el angulo y la fuerza (para que los demas lo repitan)
  // y donde ha caido.
  socket.on('match:javelin-throw', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const javelin = room?.match?.specialRound?.javelin;
    const angle = Number(payload.angle);
    const power = Number(payload.power);
    const landX = Number(payload.landX);
    const now = Date.now();

    if (!room || !player || !javelin || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay jabalinas en juego.' });
      return;
    }

    const throws = javelin.throws.get(player.id) || [];

    if (javelin.stage !== 'throwing' || now < javelin.startsAt - 500 || now > javelin.endsAt + 1000) {
      callback?.({ ok: false, reason: 'Ya no se puede lanzar.' });
      return;
    }

    if (throws.length >= JAVELIN_THROWS) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (![angle, power, landX].every(Number.isFinite) || power < 0 || power > 1 || angle < 0 || angle > Math.PI / 2 || landX < 0 || landX > 120) {
      callback?.({ ok: false, reason: 'Tiro no válido.' });
      return;
    }

    throws.push({
      angle: Math.round(angle * 100000) / 100000,
      power: Math.round(power * 100000) / 100000,
      landX: Math.round(landX * 100) / 100,
      distance: Math.round(Math.abs(landX - javelin.flagX) * 100) / 100,
      at: now,
    });
    javelin.throws.set(player.id, throws);
    emitMatchState(room);
    callback?.({ ok: true });
    maybeEndJavelin(room);
  });

  // Ruleta rusa: el jugador en turno dispara ('shoot') o salta una bala y dispara la siguiente ('skip').
  socket.on('match:russian-action', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const russian = room?.match?.specialRound?.russian;
    const action = payload.action === 'skip' ? 'skip' : payload.action === 'shoot' ? 'shoot' : null;

    if (!room || !player || !russian || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay ruleta rusa en juego.' });
      return;
    }

    if (!action) {
      callback?.({ ok: false, reason: 'Acción no válida.' });
      return;
    }

    if (russian.currentPlayerId !== player.id || Number(payload.turnNumber) !== russian.turnNumber) {
      callback?.({ ok: false, reason: 'No es tu turno.' });
      return;
    }

    if (russian.stage === 'firing' && russian.lastShot?.turnNumber === russian.turnNumber) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (!russianShoot(room, player.id, action, russian.turnNumber)) {
      callback?.({ ok: false, reason: 'Todavía no puedes disparar.' });
      return;
    }

    callback?.({ ok: true });
  });

  // Patata caliente: palabra (ya comprobada en el cliente, con lo que ha tardado) o aviso de que le ha explotado.
  socket.on('match:bomb-word', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const bomb = room?.match?.specialRound?.bomb;

    if (!room || !player || !bomb || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay patata caliente en juego.' });
      return;
    }

    if (Number(payload.turn) !== bomb.turn) {
      callback?.({ ok: false, reason: 'Ese turno ya ha pasado.' });
      return;
    }

    callback?.(acceptBombWord(room, player.id, payload.word, payload.usedMs));
  });

  socket.on('match:bomb-boom', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const bomb = room?.match?.specialRound?.bomb;

    if (!room || !player || !bomb || bomb.holderId !== player.id || Number(payload.turn) !== bomb.turn) {
      callback?.({ ok: false, reason: 'No tienes la bomba.' });
      return;
    }

    // Solo cuenta si de verdad se le ha acabado la mecha (con un margen por la diferencia de relojes).
    if (Date.now() < bomb.explodeAt - BOMB_GRACE_MS) {
      callback?.({ ok: false, reason: 'Aún queda mecha.' });
      return;
    }

    callback?.({ ok: explodeBomb(room, bomb.turn) });
  });

  // Reloj comun: el cliente mide la ida y vuelta y se queda con la mas rapida (para que todo pase a la vez).
  socket.on('clock:ping', (_payload, callback) => {
    callback?.({ serverTime: Date.now() });
  });

  // Bomberman: casilla nueva del jugador. Sin respuesta (es lo que mas se envia); se reenvia a los demas en un
  // evento ligero. Si en esa casilla hay una mejora, se la lleva el primero que llega.
  socket.on('match:bm-move', (payload = {}) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const bm = room?.match?.specialRound?.bomberman;
    const me = bm?.players.get(player?.id);
    const x = Number(payload.x);
    const y = Number(payload.y);

    if (!room || !me || bm.outcome || !me.alive || Date.now() < bm.startsAt - 500 || !Number.isInteger(x) || !Number.isInteger(y)) {
      return;
    }

    if (x < 1 || y < 1 || x >= bm.size - 1 || y >= bm.size - 1 || bm.cells[y * bm.size + x] === 'W' || bm.cells[y * bm.size + x] === 'C') {
      return;
    }

    me.x = x;
    me.y = y;
    socket.to(room.code).emit('match:bm-move', { lobbyId: room.code, playerId: player.id, x, y, s: Number(payload.s) || 0 });
    const powerup = bm.powerups.find((item) => item.x === x && item.y === y);

    if (powerup) {
      bm.powerups = bm.powerups.filter((item) => item !== powerup);

      if (powerup.type === 'radius') {
        me.radius += 1;
      } else {
        me.capacity += 1;
      }

      emitMatchState(room);
    }
  });

  // Carrera: posicion del coche (~10 por segundo, sin respuesta) con lo recorrido; se reenvia a los demas.
  socket.on('match:race-pos', (payload = {}) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const race = room?.match?.specialRound?.race;
    const me = race?.players.get(player?.id);
    const x = Number(payload.x);
    const y = Number(payload.y);
    const a = Number(payload.a);
    const p = Number(payload.p);
    const s = Number(payload.s) || 0;
    // i: punto de la linea central en el que esta (para saber si va por un puente); c: siguiente punto de control.
    const i = Math.max(0, Math.round(Number(payload.i) || 0));
    const c = Math.max(0, Math.round(Number(payload.c) || 0));

    if (!room || !me || race.outcome || ![x, y, a, p].every(Number.isFinite) || s <= me.seq) {
      return;
    }

    Object.assign(me, { x: Math.round(x), y: Math.round(y), a: Math.round(a * 1000) / 1000, progress: Math.round(p), index: i, checkpoint: c, seq: s });
    socket.to(room.code).emit('match:race-pos', { lobbyId: room.code, playerId: player.id, x: me.x, y: me.y, a: me.a, p: me.progress, i, c, s });
  });

  // Carrera: el cliente ha cruzado la meta en su ultima vuelta; su tiempo (reloj comun) es el que cuenta.
  socket.on('match:race-finish', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const race = room?.match?.specialRound?.race;
    const me = race?.players.get(player?.id);
    const timeMs = Math.round(Number(payload.timeMs));

    if (!room || !me || race.outcome) {
      callback?.({ ok: false, reason: 'No hay carrera en juego.' });
      return;
    }

    if (me.finishMs !== null) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (!Number.isFinite(timeMs) || timeMs < RACE_MIN_TIME_MS || timeMs > Date.now() - race.startsAt + 2000 || race.startsAt + timeMs > race.endsAt + 2000) {
      callback?.({ ok: false, reason: 'Tiempo no válido.' });
      return;
    }

    me.finishMs = timeMs;
    emitMatchState(room);
    maybeFinishRace(room);
    callback?.({ ok: true });
  });

  // Snake: casilla nueva de la cabeza (sin respuesta: es lo que mas se envia). Se reenvia a los demas y, si hay
  // una fruta, se la come quien llega primero.
  socket.on('match:sn-move', (payload = {}) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const sn = room?.match?.specialRound?.snake;
    const me = sn?.players.get(player?.id);
    const x = Number(payload.x);
    const y = Number(payload.y);

    if (!room || !me || sn.outcome || !me.alive || Date.now() < sn.startsAt - 500 || !Number.isInteger(x) || !Number.isInteger(y)) {
      return;
    }

    if (x < 0 || y < 0 || x >= sn.size || y >= sn.size) {
      return;
    }

    const [hx, hy] = me.body[0];
    me.dir = [Math.sign(x - hx), Math.sign(y - hy)];
    me.body.unshift([x, y]);
    me.seq = Number(payload.s) || me.seq + 1;
    const fruit = sn.fruits.find((item) => item.x === x && item.y === y);

    if (fruit) {
      sn.fruits = sn.fruits.filter((item) => item !== fruit);
      me.length += SN_GROW;
      me.eaten += 1;
      spawnSnakeFruit(sn);
    }

    me.body = me.body.slice(0, me.length);
    socket.to(room.code).emit('match:sn-move', { lobbyId: room.code, playerId: player.id, x, y, s: me.seq });

    if (fruit) {
      emitMatchState(room);
    }
  });

  // Snake: el cliente avisa de que su serpiente ha chocado (lo decide su pantalla).
  socket.on('match:sn-dead', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const sn = room?.match?.specialRound?.snake;

    if (!room || !sn?.players.has(player?.id) || sn.outcome) {
      callback?.({ ok: false });
      return;
    }

    const ok = eliminateSnakePlayer(room, player.id, Date.now());
    emitMatchState(room);
    callback?.({ ok });
  });

  // Bomberman: bomba nueva (se publica una sola vez, con su hora de explosion en el reloj comun).
  socket.on('match:bm-bomb', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const bm = room?.match?.specialRound?.bomberman;
    const me = bm?.players.get(player?.id);
    const x = Number(payload.x);
    const y = Number(payload.y);
    const now = Date.now();

    if (!room || !me || bm.outcome || !me.alive || now < bm.startsAt - 300) {
      callback?.({ ok: false, reason: 'Ahora no puedes poner bombas.' });
      return;
    }

    if (!Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x - me.x) + Math.abs(y - me.y) > 1 || bm.cells[y * bm.size + x] !== '.') {
      callback?.({ ok: false, reason: 'Ahí no se puede poner una bomba.' });
      return;
    }

    if (bm.bombs.some((bomb) => bomb.x === x && bomb.y === y)) {
      callback?.({ ok: false, reason: 'Ya hay una bomba ahí.' });
      return;
    }

    if (bm.bombs.filter((bomb) => bomb.owner === player.id).length >= me.capacity) {
      callback?.({ ok: false, reason: 'No te quedan bombas.' });
      return;
    }

    // La hora la pone el cliente (asi explota justo a los 5 s de verla), dentro de un margen.
    const placedAt = Math.max(now - BM_PLACE_SLACK_MS, Math.min(now, Number(payload.placedAt) || now));
    const bomb = { id: bm.nextBombId, owner: player.id, x, y, radius: me.radius, explodeAt: placedAt + BM_FUSE_MS };
    bm.nextBombId += 1;
    bm.bombs.push(bomb);
    scheduleBombermanBoom(room);
    emitMatchState(room);
    callback?.({ ok: true, bomb });
  });

  // Bomberman: el cliente avisa de que una llama ha alcanzado a su personaje (en su pantalla, sin lag).
  socket.on('match:bm-dead', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const bm = room?.match?.specialRound?.bomberman;
    const me = bm?.players.get(player?.id);
    const at = Number(payload.at);

    if (!room || !me || bm.outcome || !me.alive || !Number.isFinite(at)) {
      callback?.({ ok: false });
      return;
    }

    // Tiene que coincidir con una explosion real (ya hecha o a punto, segun el reloj del servidor).
    const times = [...bm.blasts.map((blast) => blast.at), ...bm.bombs.map((bomb) => bomb.explodeAt)];
    const closest = times.sort((first, second) => Math.abs(first - at) - Math.abs(second - at))[0];

    if (closest === undefined || Math.abs(closest - at) > 1500 || closest > Date.now() + 1500) {
      callback?.({ ok: false, reason: 'No hay ninguna explosión ahí.' });
      return;
    }

    eliminateBombermanPlayer(room, player.id, closest);
    emitMatchState(room);
    callback?.({ ok: true });
  });

  // Canon: los de abajo eligen zona (pueden cambiarla mientras dure la eleccion); el canonero elige donde dispara.
  socket.on('match:cannon-pick', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const cannon = room?.match?.specialRound?.cannon;
    const zone = Number(payload.zone);

    if (!room || !player || !cannon || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay cañón en juego.' });
      return;
    }

    if (!Number.isInteger(zone) || zone < 0 || zone >= CANNON_ZONES || Number(payload.round) !== cannon.round) {
      callback?.({ ok: false, reason: 'Zona no válida.' });
      return;
    }

    if (player.id === cannon.cannoneerId) {
      if (cannon.stage !== 'aiming') {
        callback?.({ ok: false, reason: 'Todavía no puedes disparar.' });
        return;
      }

      callback?.({ ok: fireCannon(room, cannon.round, zone) });
      return;
    }

    if (cannon.stage !== 'choosing' || !cannon.alive.has(player.id)) {
      callback?.({ ok: false, reason: 'Ya no puedes cambiar de zona.' });
      return;
    }

    cannon.picks.set(player.id, zone);
    emitMatchState(room);
    sendPrivateStates(room);
    maybeSettleCannonChoosing(room);
    callback?.({ ok: true });
  });

  // Preguntas y respuestas: una respuesta por ronda (0-3), sin poder cambiarla.
  socket.on('match:quiz-answer', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const quiz = room?.match?.specialRound?.quiz;
    const choice = Math.trunc(Number(payload.choice));

    if (!room || !player || !quiz || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay preguntas en juego.' });
      return;
    }

    if (quiz.stage !== 'answering' || Number(payload.round) !== quiz.round || Date.now() < quiz.questionAt) {
      callback?.({ ok: false, reason: 'Ahora no se puede contestar.' });
      return;
    }

    if (quiz.answers.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (!Number.isInteger(choice) || choice < 0 || choice > 3) {
      callback?.({ ok: false, reason: 'Respuesta no válida.' });
      return;
    }

    quiz.answers.set(player.id, choice);
    emitMatchState(room);
    callback?.({ ok: true });
    maybeRevealQuiz(room);
  });

  // Empujar: direccion y fuerza confirmadas (como velocidad inicial vx, vy). 0, 0 = no moverse.
  socket.on('match:push-aim', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const push = room?.match?.specialRound?.push;
    const vx = Number(payload.vx);
    const vy = Number(payload.vy);

    if (!room || !player || !push || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay pista en juego.' });
      return;
    }

    if (push.stage !== 'aiming' || Number(payload.round) !== push.round || !push.players.get(player.id)?.alive) {
      callback?.({ ok: false, reason: 'Ahora no se puede apuntar.' });
      return;
    }

    if (push.aims.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (![vx, vy].every(Number.isFinite) || Math.hypot(vx, vy) > PUSH_MAX_SPEED * 1.001) {
      callback?.({ ok: false, reason: 'Impulso no válido.' });
      return;
    }

    const round4 = (value) => Math.round(value * 10000) / 10000;
    const aim = { vx: round4(vx), vy: round4(vy) };

    // Sin confirmar: se guarda como borrador (se puede cambiar); si se acaba el tiempo, sale con esa.
    if (payload.confirm === false) {
      push.drafts.set(player.id, aim);
      callback?.({ ok: true, draft: true });
      return;
    }

    push.aims.set(player.id, aim);
    emitMatchState(room);
    callback?.({ ok: true });
    maybeLaunchPush(room);
  });

  // Empujar: resultado de la simulacion de la ronda. Todos los clientes calculan lo mismo; vale el primero que llega.
  socket.on('match:push-result', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const push = room?.match?.specialRound?.push;

    if (!room || !player || !push || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay pista en juego.' });
      return;
    }

    if (push.stage !== 'launching' || Number(payload.round) !== push.round) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    const alive = alivePushIds(push);
    const positions = Array.isArray(payload.positions) ? payload.positions : [];
    const falls = Array.isArray(payload.falls) ? payload.falls : [];
    const steps = Math.trunc(Number(payload.steps));
    const reported = [...positions.map((body) => body?.playerId), ...falls.map((fall) => fall?.playerId)];
    const limit = push.arenaRadius + PUSH_DISC_RADIUS + 0.01;
    const valid =
      Number.isInteger(steps) &&
      steps >= 0 &&
      steps <= PUSH_MAX_STEPS &&
      reported.length === alive.length &&
      new Set(reported).size === alive.length &&
      reported.every((playerId) => alive.includes(playerId)) &&
      positions.every((body) => [body.x, body.y].every(Number.isFinite) && Math.hypot(body.x, body.y) <= limit) &&
      falls.every((fall) => Number.isInteger(fall.step) && fall.step >= 0 && fall.step <= steps);

    if (!valid) {
      callback?.({ ok: false, reason: 'Resultado no válido.' });
      return;
    }

    const round4 = (value) => Math.round(value * 10000) / 10000;
    applyPushResult(room, push.round, {
      positions: positions.map((body) => ({ playerId: body.playerId, x: round4(body.x), y: round4(body.y) })),
      falls: falls.map((fall) => ({ playerId: fall.playerId, step: fall.step })),
      steps,
    });
    callback?.({ ok: true });
  });

  socket.on('match:chop-report', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const chop = room?.match?.specialRound?.chop;
    const veggies = Math.trunc(Number(payload.veggies));
    const now = Date.now();

    if (!room || !player || !chop || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay cocina en juego.' });
      return;
    }

    if (chop.outcome || now < chop.endsAt - 1000 || now > chop.resultsAt) {
      callback?.({ ok: false, reason: 'Ahora no se pueden entregar las verduras.' });
      return;
    }

    if (chop.veggies.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (!Number.isInteger(veggies) || veggies < 0 || veggies > CHOP_MAX_VEGGIES) {
      callback?.({ ok: false, reason: 'Número de verduras no válido.' });
      return;
    }

    chop.veggies.set(player.id, veggies);
    callback?.({ ok: true });
  });

  // Salto con cuerda: el jugador en turno se suelta; llega el angulo y el sentido del balanceo en su pantalla.
  socket.on('match:swing-release', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const swing = room?.match?.specialRound?.swing;
    const angle = Number(payload.angle);
    const dir = Number(payload.dir) >= 0 ? 1 : -1;

    if (!room || !player || !swing || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay cuerda en juego.' });
      return;
    }

    if (swing.stage !== 'swinging' || swing.order[swing.turnIndex] !== player.id || Number(payload.turnIndex) !== swing.turnIndex) {
      callback?.({ ok: false, reason: 'No es tu turno.' });
      return;
    }

    if (!Number.isFinite(angle) || angle < -SWING_AMPLITUDE || angle > SWING_AMPLITUDE) {
      callback?.({ ok: false, reason: 'Ángulo no válido.' });
      return;
    }

    releaseSwing(room, swing.turnIndex, angle, dir);
    callback?.({ ok: true, jump: swing.jumps[swing.jumps.length - 1] });
  });

  socket.on('match:beer-throw', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const beer = room?.match?.specialRound?.beer;
    const power = Number(payload.power);

    if (!room || !player || !beer || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay jarras en juego.' });
      return;
    }

    if (beer.stage !== 'aiming' || (payload.round !== undefined && Number(payload.round) !== beer.round)) {
      callback?.({ ok: false, reason: 'Las jarras ya se han lanzado.' });
      return;
    }

    if (beer.powers.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (!Number.isFinite(power) || power < 0 || power > 1) {
      callback?.({ ok: false, reason: 'Fuerza no válida.' });
      return;
    }

    beer.powers.set(player.id, Math.round(power * 1000) / 1000);
    emitMatchState(room);
    callback?.({ ok: true });
    maybeStartBeerSlide(room);
  });

  socket.on('match:stopwatch-stop', (payload = {}, callback) => {
    const room = getRoomFromPayload(payload);
    const player = getRequestPlayer(room, payload);
    const stopwatch = room?.match?.specialRound?.stopwatch;
    const elapsedMs = Math.round(Number(payload.elapsedMs));

    if (!room || !player || !stopwatch || room.match.phase !== 'special-round' || !room.match.specialRound.participantIds.includes(player.id)) {
      callback?.({ ok: false, reason: 'No hay cronómetro en juego.' });
      return;
    }

    if (stopwatch.stage !== 'running' || Number(payload.round) !== stopwatch.round) {
      callback?.({ ok: false, reason: 'Esa ronda ya ha terminado.' });
      return;
    }

    if (stopwatch.stops.has(player.id)) {
      callback?.({ ok: true, ignored: true });
      return;
    }

    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > stopwatch.targetMs + STOPWATCH_MAX_ERROR_MS + 1000) {
      callback?.({ ok: false, reason: 'Tiempo no válido.' });
      return;
    }

    stopwatch.stops.set(player.id, elapsedMs);
    emitMatchState(room);
    callback?.({ ok: true });
    maybeRevealStopwatch(room);
  });

  socket.on('match:dance-fail', (payload = {}, callback) => {
    const request = getDanceRequest(payload, callback);

    if (!request) {
      return;
    }

    const { room, player, dance } = request;

    if (dance.done.has(player.id)) {
      callback?.({ ok: false, reason: 'Ya habias terminado la secuencia.' });
      return;
    }

    // Lo unico que se reparte durante la ronda: quien ha caido, para que todos le vean derrumbarse.
    eliminateDancer(dance, player.id);
    emitMatchState(room);
    callback?.({ ok: true });
    maybeCloseDanceRound(room);
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
