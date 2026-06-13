const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const LOCAL_DEV_PORT = 8080;
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
const SPECIAL_QUESTION_PROBABILITY = 1;
const CUSTOM_QUESTION_EXTRA_MS = 30000;
const SPECIAL_ROUND_COIN_PROBABILITY = 0.5;
// Minigames stay registered centrally so the server can coordinate one shared choice for every client.
const MINIGAMES = require('./config/minigames.json');

function getMinigameConfig(minigameId) {
  return MINIGAMES.find((minigame) => minigame.id === minigameId) || null;
}
const SPECIAL_QUESTION_OPTION = {
  id: 'special-custom-question',
  text: 'Pregunta especial: escribe tu propia pregunta',
  special: true,
};
const QUESTION_OPTIONS = [
  { id: 'has-glasses', text: 'Tu personaje tiene gafas?' },
  { id: 'has-hat', text: 'Tu personaje lleva sombrero?' },
  { id: 'is-real', text: 'Tu personaje es real?' },
  { id: 'can-fly', text: 'Tu personaje puede volar?' },
  { id: 'appears-in-movies', text: 'Tu personaje aparece en peliculas?' },
  { id: 'has-powers', text: 'Tu personaje tiene poderes?' },
  { id: 'is-human', text: 'Tu personaje es humano?' },
  { id: 'wears-armor', text: 'Tu personaje lleva armadura?' },
  { id: 'is-fictional', text: 'Tu personaje es ficticio?' },
  { id: 'uses-magic', text: 'Tu personaje usa magia?' },
  { id: 'is-famous', text: 'Tu personaje es famoso?' },
  { id: 'is-an-object', text: 'Tu personaje es un objeto?' },
  { id: 'is-from-history', text: 'Tu personaje pertenece a la historia?' },
  { id: 'is-animated', text: 'Tu personaje es animado?' },
  { id: 'has-animal-traits', text: 'Tu personaje tiene rasgos de animal?' },
  { id: 'uses-technology', text: 'Tu personaje usa tecnologia?' },
  { id: 'is-from-space', text: 'Tu personaje viene del espacio?' },
  { id: 'has-weapon', text: 'Tu personaje lleva un arma?' },
];
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

function pickRandomListValue(values, fallbackValues) {
  const candidates = Array.isArray(values) && values.length ? values : fallbackValues;
  return candidates[Math.floor(Math.random() * candidates.length)] || fallbackValues[0] || '';
}

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';

  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (gameState.rooms.has(code));

  return code;
}

function generateSpecialRounds(totalRounds) {
  const maxSpecialRounds = Math.floor(totalRounds / 2);
  const specialRounds = [];
  let previousWasSpecial = false;

  for (let roundNumber = 2; roundNumber <= totalRounds; roundNumber += 1) {
    if (specialRounds.length >= maxSpecialRounds) {
      break;
    }

    if (previousWasSpecial) {
      previousWasSpecial = false;
      continue;
    }

    if (Math.random() <= SPECIAL_ROUND_COIN_PROBABILITY) {
      specialRounds.push(roundNumber);
      previousWasSpecial = true;
    } else {
      previousWasSpecial = false;
    }
  }

  return specialRounds;
}

function generateAllMinigameRounds(totalRounds) {
  return Array.from({ length: totalRounds + 1 }, (_unused, index) => index);
}

function normalizeRoomSettings(settings = {}) {
  const totalRounds = Number(settings.rounds || 5);

  return {
    ...settings,
    rounds: totalRounds,
    minigamesOnly: Boolean(settings.minigamesOnly),
    specialRounds: settings.minigamesOnly ? generateAllMinigameRounds(totalRounds) : settings.specialRounds || [],
  };
}

function selectRandomMinigame(room) {
  const previousMinigameId = room.match?.lastMinigameId || '';
  const candidates =
    MINIGAMES.length > 1 ? MINIGAMES.filter((minigame) => minigame.id !== previousMinigameId) : MINIGAMES;
  const selectedMinigame = candidates[Math.floor(Math.random() * candidates.length)] || MINIGAMES[0];
  room.match.lastMinigameId = selectedMinigame.id;
  return selectedMinigame;
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
    questionRoundNumber: room.match.questionBatch?.roundNumber || 0,
    questionSelectionEndsAt: room.match.questionBatch?.questionSelectionEndsAt || null,
    selectedQuestions: room.match.questionBatch
      ? Array.from(room.match.questionBatch.selections.entries()).map(([playerId, question]) => ({
        playerId,
        questionId: question.questionId,
        question: question.question,
        questionType: question.questionType,
      }))
      : [],
    questionOptionsByPlayer: room.match.questionBatch
      ? Array.from(room.match.questionBatch.optionsByPlayer.entries()).map(([playerId, options]) => ({
        playerId,
        options,
      }))
      : [],
    questionHistory: room.match.questionHistory || [],
    customQuestionEditingPlayerIds: room.match.questionBatch
      ? Array.from(room.match.questionBatch.customEditingDeadlines.keys())
      : [],
    customQuestionDeadlineByPlayer: room.match.questionBatch
      ? Array.from(room.match.questionBatch.customEditingDeadlines.entries()).map(([playerId, deadline]) => ({
        playerId,
        deadline,
      }))
      : [],
    currentAnswer: getCurrentAnswerPayload(room),
    answerEndsAt: room.match.questionBatch?.answerEndsAt || null,
    answerResults: room.match.questionBatch ? Array.from(room.match.questionBatch.results.values()) : [],
    waitingQuestionBatchPlayerIds: Array.from(room.match.waitingQuestionBatchPlayerIds || []),
    scoreboard: room.match.scoreboard || null,
    specialRounds: room.match.specialRounds || [],
    specialRound: toPublicSpecialRound(room.match.specialRound),
  };
}

function toPublicSpecialRound(specialRound) {
  if (!specialRound) {
    return null;
  }

  const { submissions: _submissions, ...publicRound } = specialRound;

  return {
    ...publicRound,
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
    gameEndsAt: specialRound.gameEndsAt || null,
    hostMinigameData: specialRound.hostMinigameData ?? null,
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

function getQuestionById(questionId) {
  return QUESTION_OPTIONS.find((question) => question.id === questionId) || null;
}

function getQuestionByText(questionText) {
  return QUESTION_OPTIONS.find((question) => question.text === questionText) || null;
}

function getActiveMatchPlayers(room) {
  const waitingQuestionIds = room.match?.waitingQuestionBatchPlayerIds || new Set();
  return Array.from(room.players.values()).filter((player) => player.active && !waitingQuestionIds.has(player.id));
}

function buildQuestionOptionsForPlayer(room, playerId) {
  const history = room.match?.questionHistory || [];
  const playerHistory = history.filter((entry) => entry.ownerPlayerId === playerId);
  const usedRoundByQuestionId = new Map();

  for (const entry of playerHistory) {
    usedRoundByQuestionId.set(entry.questionId, entry.roundNumber);
  }

  const unusedQuestions = QUESTION_OPTIONS.filter((question) => !usedRoundByQuestionId.has(question.id));
  const usedLeastRecentQuestions = QUESTION_OPTIONS.filter((question) => usedRoundByQuestionId.has(question.id)).sort(
    (firstQuestion, secondQuestion) =>
      (usedRoundByQuestionId.get(firstQuestion.id) || 0) - (usedRoundByQuestionId.get(secondQuestion.id) || 0),
  );
  let selectedQuestions = [...unusedQuestions, ...usedLeastRecentQuestions].slice(0, 6);

  if (
    (room.match?.questionBatch?.roundNumber || 1) >= 2 &&
    Math.random() <= SPECIAL_QUESTION_PROBABILITY
  ) {
    selectedQuestions = [SPECIAL_QUESTION_OPTION, ...selectedQuestions.filter((question) => !question.special)].slice(
      0,
      6,
    );
  }

  if (selectedQuestions.length >= 6) {
    return selectedQuestions;
  }

  const selectedIds = new Set(selectedQuestions.map((question) => question.id));
  return [
    ...selectedQuestions,
    ...QUESTION_OPTIONS.filter((question) => !selectedIds.has(question.id)).slice(0, 6 - selectedQuestions.length),
  ];
}

function buildQuestionOptionsByPlayer(room) {
  return getActiveMatchPlayers(room).map((player) => ({
    playerId: player.id,
    options: buildQuestionOptionsForPlayer(room, player.id),
  }));
}

function assignAutomaticQuestion(room, playerId) {
  const batch = room.match?.questionBatch;

  if (!batch || batch.selections.has(playerId)) {
    return;
  }

  const normalOptions = (batch.optionsByPlayer.get(playerId) || []).filter((option) => !option.special);
  const fallbackOptions = normalOptions.length ? normalOptions : QUESTION_OPTIONS;
  const selectedOption = fallbackOptions[Math.floor(Math.random() * fallbackOptions.length)];

  batch.customEditingDeadlines.delete(playerId);
  batch.selections.set(playerId, {
    questionId: selectedOption.id,
    question: selectedOption.text,
    questionType: 'auto-assigned',
  });
}

function assignTimedOutQuestions(room) {
  const batch = room.match?.questionBatch;

  if (!batch) {
    return;
  }

  const now = Date.now();

  for (const player of getActiveMatchPlayers(room)) {
    if (batch.selections.has(player.id)) {
      continue;
    }

    const customDeadline = batch.customEditingDeadlines.get(player.id);

    if (customDeadline && now < customDeadline) {
      continue;
    }

    if ((batch.questionSelectionEndsAt && now >= batch.questionSelectionEndsAt) || customDeadline) {
      assignAutomaticQuestion(room, player.id);
    }
  }
}

function getCurrentAnswerPayload(room) {
  const batch = room.match?.questionBatch;

  if (!batch || batch.currentAnswerIndex < 0 || batch.currentAnswerIndex >= batch.answerOrder.length) {
    return null;
  }

  const ownerPlayerId = batch.answerOrder[batch.currentAnswerIndex];
  const ownerPlayer = room.players.get(ownerPlayerId);
  const question = batch.selections.get(ownerPlayerId);
  const imageUrl = room.match.characterImages?.get(ownerPlayerId) || '';

  if (!ownerPlayer || !question) {
    return null;
  }

  return {
    ownerPlayerId,
    ownerPlayerName: ownerPlayer.name,
    questionId: question.questionId,
    question: question.question,
    questionType: question.questionType,
    imageUrl,
  };
}

function emitQuestionState(room) {
  io.to(room.code).emit('match:question-state', toMatchState(room));
}

function emitQuestionBackup(room) {
  const batch = room.match?.questionBatch;

  if (!batch) {
    return;
  }

  io.to(room.code).emit('match:question-backup-updated', {
    lobbyId: room.code,
    roundNumber: batch.roundNumber,
    questions: Array.from(batch.selections.entries()).map(([ownerPlayerId, selectedQuestion]) => {
      const result = batch.results.get(ownerPlayerId);
      return {
        ownerPlayerId,
        questionId: selectedQuestion.questionId,
        selectedQuestion: selectedQuestion.question,
        questionType: selectedQuestion.questionType,
        finalAnswer: result?.finalAnswer || null,
      };
    }),
    history: room.match.questionHistory || [],
  });
}

function emitScoreboardState(room) {
  io.to(room.code).emit('match:scoreboard-sync', {
    lobbyId: room.code,
    scoreboard: room.match?.scoreboard || null,
  });
  emitQuestionState(room);
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
  if (
    !room.match ||
    room.match.phase === 'image-selection-complete' ||
    room.match.phase === 'question-selection' ||
    room.match.phase === 'answer-phase' ||
    room.match.phase === 'scoreboard'
  ) {
    return;
  }

  if (getUnconfirmedPlayers(room).length > 0) {
    return;
  }

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
  room.match.characterImages = new Map(selectedImages.map((selection) => [selection.playerId, selection.imageUrl]));
  room.match.phase = 'image-selection-complete';
  if ((room.match.specialRounds || []).includes(0) || (room.match.specialRounds || []).includes(1)) {
    startSpecialRound(room, room.match.specialRounds.includes(0) ? 0 : 1);
  } else {
    startQuestionBatch(room);
  }
}

function startQuestionBatch(room, forcedRoundNumber = null) {
  if (!room.match) {
    return;
  }

  room.match.waitingQuestionBatchPlayerIds = room.match.waitingQuestionBatchPlayerIds || new Set();
  for (const playerId of [...room.match.waitingQuestionBatchPlayerIds]) {
    if (room.players.get(playerId)?.active) {
      room.match.waitingQuestionBatchPlayerIds.delete(playerId);
    }
  }

  const nextRoundNumber = forcedRoundNumber || (room.match.questionBatch?.roundNumber || 0) + 1;
  room.match.phase = 'question-selection';
  room.match.specialRound = null;
  room.match.questionBatch = {
    roundNumber: nextRoundNumber,
    selections: new Map(),
    results: new Map(),
    answerOrder: [],
    currentAnswerIndex: -1,
    votes: new Map(),
    optionsByPlayer: new Map(),
    customEditingDeadlines: new Map(),
    questionSelectionEndsAt: Date.now() + Number(room.settings.questionDuration || 30) * 1000,
    answerEndsAt: null,
  };
  room.match.questionBatch.optionsByPlayer = new Map(
    buildQuestionOptionsByPlayer(room).map((entry) => [entry.playerId, entry.options]),
  );

  emitQuestionState(room);
}

function startAnswerPhase(room) {
  const batch = room.match?.questionBatch;

  if (!batch || room.match.phase === 'answer-phase') {
    return;
  }

  assignTimedOutQuestions(room);
  const activePlayerIds = getActiveMatchPlayers(room).map((player) => player.id);
  batch.answerOrder = activePlayerIds.filter((playerId) => batch.selections.has(playerId));
  batch.currentAnswerIndex = 0;

  if (!batch.answerOrder.length) {
    startQuestionBatch(room);
    return;
  }

  room.match.phase = 'answer-phase';
  emitQuestionBackup(room);
  startCurrentAnswerTurn(room);
}

function startCurrentAnswerTurn(room) {
  const batch = room.match?.questionBatch;

  if (!batch || batch.currentAnswerIndex >= batch.answerOrder.length) {
    startScoreboardPhase(room);
    return;
  }

  batch.votes = new Map();
  batch.answerEndsAt = Date.now() + Number(room.settings.respondQuestionTime || 5) * 1000;
  emitQuestionState(room);
}

function startScoreboardPhase(room) {
  const batch = room.match?.questionBatch;

  if (!room.match || !batch) {
    return;
  }

  room.match.phase = 'scoreboard';
  room.match.scoreboard = room.match.scoreboard || {
    lobbyId: room.code,
    roundNumber: batch.roundNumber,
    scores: [],
  };

  io.to(room.code).emit('match:question-batch-finished', {
    lobbyId: room.code,
    roundNumber: batch.roundNumber,
  });
  io.to(room.code).emit('match:scoreboard-calculate', {
    lobbyId: room.code,
    roundNumber: batch.roundNumber,
    results: Array.from(batch.results.values()),
  });
  emitQuestionState(room);
}

function finishQuestionsPhase(room) {
  if (!room.match) {
    return;
  }

  room.match.phase = 'questions-complete';
  io.to(room.code).emit('match:questions-complete', {
    lobbyId: room.code,
    roundNumber: room.match.questionBatch?.roundNumber || 0,
  });
  emitQuestionState(room);
}

function startSpecialRound(room, roundNumber) {
  if (!room.match) {
    return;
  }

  const selectedMinigame = selectRandomMinigame(room);
  room.match.phase = 'special-round';
  room.match.specialRound = {
    roundNumber,
    minigameId: selectedMinigame.id,
    title: selectedMinigame.title,
    description: selectedMinigame.description,
    preparedByHost: false,
    operations: [],
    submissions: new Map(),
    progress: new Map(),
    results: [],
    paintTarget: null,
    paintPhase: selectedMinigame.id === 'paint' ? 'preparing' : null,
    paintEndsAt: null,
    paintVoteEndsAt: null,
    paintSubmissions: new Map(),
    paintVotes: new Map(),
  };
  io.to(room.code).emit('match:special-round-started', {
    lobbyId: room.code,
    specialRound: toPublicSpecialRound(room.match.specialRound),
  });
  emitQuestionState(room);
}

function calculateMathMinigameResults(room) {
  const specialRound = room.match?.specialRound;

  if (!specialRound || !Array.isArray(specialRound.operations)) {
    return [];
  }

  return getActiveMatchPlayers(room).map((player) => {
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
  if (!room.match || !room.match.specialRound) {
    return;
  }

  if (room.match.phase === 'scoreboard' && room.match.scoreboardSource === 'minigame') {
    return;
  }

  room.match.specialRound.results = calculateMathMinigameResults(room);
  room.match.phase = 'scoreboard';
  room.match.scoreboardSource = 'minigame';
  room.match.scoreboard = {
    lobbyId: room.code,
    roundNumber: room.match.specialRound.roundNumber,
    scores: [],
  };

  io.to(room.code).emit('match:scoreboard-calculate', {
    lobbyId: room.code,
    roundNumber: room.match.specialRound.roundNumber,
    source: 'minigame',
    results: room.match.specialRound.results,
  });
  emitQuestionState(room);
}

function startPaintVotingPhase(room) {
  const specialRound = room.match?.specialRound;

  if (!room.match || !specialRound || specialRound.minigameId !== 'paint' || specialRound.paintPhase !== 'drawing') {
    return;
  }

  const minigameConfig = getMinigameConfig(specialRound.minigameId);
  const votingDurationSeconds = minigameConfig?.minigameData?.votingDurationSeconds || 20;

  specialRound.paintPhase = 'voting';
  specialRound.paintVoteEndsAt = Date.now() + (votingDurationSeconds * 1000);
  io.to(room.code).emit('match:paint-voting-started', {
    lobbyId: room.code,
    specialRound: toPublicSpecialRound(specialRound),
  });
  emitQuestionState(room);
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

  return getActiveMatchPlayers(room).map((player) => ({
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

  if (!room.match || !specialRound || specialRound.minigameId !== 'paint') {
    return;
  }

  if (room.match.phase === 'scoreboard' && room.match.scoreboardSource === 'minigame') {
    return;
  }

  specialRound.results = calculatePaintResults(room);
  specialRound.paintPhase = 'finished';
  room.match.phase = 'scoreboard';
  room.match.scoreboardSource = 'minigame';
  room.match.scoreboard = {
    lobbyId: room.code,
    roundNumber: specialRound.roundNumber,
    scores: [],
  };

  io.to(room.code).emit('match:paint-results-ready', {
    lobbyId: room.code,
    specialRound: toPublicSpecialRound(specialRound),
  });
  io.to(room.code).emit('match:scoreboard-calculate', {
    lobbyId: room.code,
    roundNumber: specialRound.roundNumber,
    source: 'minigame',
    results: specialRound.results,
  });
  emitQuestionState(room);
}

function finalizeCurrentAnswer(room) {
  const batch = room.match?.questionBatch;
  const currentAnswer = getCurrentAnswerPayload(room);

  if (!batch || !currentAnswer || batch.results.has(currentAnswer.ownerPlayerId)) {
    return;
  }

  let yesVotes = 0;
  let noVotes = 0;

  for (const vote of batch.votes.values()) {
    if (vote === 'yes') {
      yesVotes += 1;
    } else {
      noVotes += 1;
    }
  }

  const finalAnswer = yesVotes === noVotes ? 'maybe' : yesVotes > noVotes ? 'yes' : 'no';
  const result = {
    ownerPlayerId: currentAnswer.ownerPlayerId,
    questionId: currentAnswer.questionId,
    selectedQuestion: currentAnswer.question,
    questionType: currentAnswer.questionType,
    finalAnswer,
  };

  batch.results.set(currentAnswer.ownerPlayerId, result);
  room.match.questionHistory = (room.match.questionHistory || []).filter(
    (entry) =>
      !(entry.roundNumber === batch.roundNumber && entry.ownerPlayerId === currentAnswer.ownerPlayerId),
  );
  room.match.questionHistory.push({
    ownerPlayerId: currentAnswer.ownerPlayerId,
    questionId: currentAnswer.questionId,
    question: currentAnswer.question,
    questionType: currentAnswer.questionType,
    answer: finalAnswer,
    roundNumber: batch.roundNumber,
  });
  io.to(room.code).emit('match:answer-result', {
    lobbyId: room.code,
    result,
  });
  emitQuestionBackup(room);

  setTimeout(() => {
    if (!gameState.rooms.has(room.code) || room.match?.hostPaused) {
      return;
    }

    batch.currentAnswerIndex += 1;
    startCurrentAnswerTurn(room);
  }, 2200);
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
    const promptType = Math.random() < 0.5 ? 'theme' : 'characterType';
    const theme = pickRandomListValue(settings.themeCategories, FALLBACK_THEMES);
    const characterType = pickRandomListValue(settings.characterTypes, FALLBACK_CHARACTER_TYPES);

    assignments.set(player.id, {
      playerId: player.id,
      targetPlayerId: shuffledTargets[index].id,
      targetPlayerName: shuffledTargets[index].name,
      theme,
      characterType,
      promptType,
      promptLabel: promptType === 'theme' ? theme : characterType,
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

  const pausedDuration = room.match.hostPauseStartedAt ? Date.now() - room.match.hostPauseStartedAt : 0;
  room.match.hostPaused = false;
  room.match.hostPauseStartedAt = null;
  room.match.hostPauseDeadline = null;

  if (room.match.phase === 'question-selection' && room.match.questionBatch?.questionSelectionEndsAt) {
    room.match.questionBatch.questionSelectionEndsAt += pausedDuration;
  }

  if (room.match.phase === 'answer-phase' && room.match.questionBatch?.answerEndsAt) {
    room.match.questionBatch.answerEndsAt += pausedDuration;
  }

  io.to(room.code).emit('match:host-resumed', {
    lobbyId: room.code,
    imageSelectionEndsAt: room.match.imageSelectionEndsAt,
  });

  if (room.match.phase === 'countdown' || room.match.phase === 'image-selection') {
    resetImageSelectionTimer(room);
  } else {
    emitQuestionState(room);
  }
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
    if (!room.match || room.match.phase === 'countdown' || room.match.phase === 'image-selection') {
      existingPlayer.ready = room.match ? false : existingPlayer.ready;
    }
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
      settings: normalizeRoomSettings(payload.settings || {}),
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

    if (room.match?.waitingQuestionBatchPlayerIds?.has(playerId)) {
      upsertPlayer(room, socket, playerId, playerName);
      socket.join(code);
      socket.emit('match:question-state', toMatchState(room));
      socket.emit('match:waiting-next-question-batch', {
        lobbyId: code,
        reason: 'Espera a la siguiente tanda de preguntas.',
      });
      callback?.({
        ok: true,
        lobby: toLobby(room),
        match: toMatchState(room),
        waitingQuestionBatch: true,
      });
      return;
    }

    const playerWasInactive = room.players.has(playerId) && !room.players.get(playerId).active;
    upsertPlayer(room, socket, playerId, playerName);
    socket.join(code);

    if (isHostRejoining && room.match?.hostPaused) {
      resumeHostPause(room);
    }

    if (room.match && (room.match.phase === 'countdown' || room.match.phase === 'image-selection')) {
      room.match.selections.delete(playerId);

      if (!isHostRejoining || playerWasInactive) {
        resetImageSelectionTimer(room);
      }
    } else if (
      room.match &&
      (room.match.phase === 'question-selection' || room.match.phase === 'answer-phase') &&
      playerWasInactive &&
      !isHostRejoining
    ) {
      room.match.waitingQuestionBatchPlayerIds = room.match.waitingQuestionBatchPlayerIds || new Set();
      room.match.waitingQuestionBatchPlayerIds.add(playerId);
      socket.emit('match:waiting-next-question-batch', {
        lobbyId: code,
        reason: 'Espera a la siguiente tanda de preguntas.',
      });
      emitQuestionState(room);
    }

    broadcastLobby(room);

    if (room.match && room.match.phase !== 'lobby') {
      socket.emit('match:started', toMatchState(room));
      if (room.match.phase === 'countdown' || room.match.phase === 'image-selection') {
        broadcastImageSelectionUpdate(room);
      } else {
        emitQuestionState(room);
      }
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

      if (playerId === room.hostId && room.match.hostPaused) {
        resumeHostPause(room);
      } else if (room.match.phase === 'question-selection' || room.match.phase === 'answer-phase') {
        room.match.waitingQuestionBatchPlayerIds = room.match.waitingQuestionBatchPlayerIds || new Set();
        room.match.waitingQuestionBatchPlayerIds.add(playerId);
        socket.emit('match:waiting-next-question-batch', {
          lobbyId: code,
          reason: 'Espera a la siguiente tanda de preguntas.',
        });
        emitQuestionState(room);
      } else {
        room.match.selections.delete(playerId);
        resetImageSelectionTimer(room);
      }

      broadcastLobby(room);
      if (room.match.phase === 'countdown' || room.match.phase === 'image-selection') {
        broadcastImageSelectionUpdate(room);
      }
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

    room.settings = normalizeRoomSettings(payload.settings || room.settings);
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

    const totalRounds = Number(room.settings.rounds || 5);
    const specialRounds = room.settings.minigamesOnly ? generateAllMinigameRounds(totalRounds) : generateSpecialRounds(totalRounds);
    room.settings = {
      ...room.settings,
      minigamesOnly: Boolean(room.settings.minigamesOnly),
      specialRounds,
    };

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
      waitingQuestionBatchPlayerIds: new Set(),
      characterImages: new Map(),
      questionHistory: [],
      scoreboard: null,
      specialRounds,
      specialRound: null,
      questionBatch: null,
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

  socket.on('match:select-question', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const questionId = String(payload.questionId || '').trim();
    const questionText = String(payload.question || '').trim();
    const customQuestion = String(payload.customQuestion || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);
    const batch = room?.match?.questionBatch;

    if (!room || !player || !room.match || !batch || room.match.phase !== 'question-selection') {
      callback?.({ ok: false, reason: 'No hay una tanda de preguntas activa.' });
      return;
    }

    const question =
      questionId === SPECIAL_QUESTION_OPTION.id ? SPECIAL_QUESTION_OPTION : questionId ? getQuestionById(questionId) : getQuestionByText(questionText);
    const allowedOptionIds = new Set((batch.optionsByPlayer.get(playerId) || []).map((option) => option.id));

    if (!question || !allowedOptionIds.has(question.id)) {
      callback?.({ ok: false, reason: 'Selecciona una pregunta valida.' });
      return;
    }

    if (room.match.waitingQuestionBatchPlayerIds?.has(playerId) || !player.active) {
      callback?.({ ok: false, reason: 'Espera a la siguiente tanda de preguntas.' });
      return;
    }

    if (question.special) {
      if (customQuestion.length < 8) {
        callback?.({ ok: false, reason: 'Escribe una pregunta personalizada mas clara.' });
        return;
      }

      batch.customEditingDeadlines.delete(playerId);
      batch.selections.set(playerId, {
        questionId: `${SPECIAL_QUESTION_OPTION.id}:${playerId}:${batch.roundNumber}`,
        question: customQuestion,
        questionType: 'custom',
      });
    } else {
      batch.customEditingDeadlines.delete(playerId);
      batch.selections.set(playerId, {
        questionId: question.id,
        question: question.text,
        questionType: 'normal',
      });
    }
    emitQuestionState(room);
    emitQuestionBackup(room);

    const activePlayerIds = getActiveMatchPlayers(room).map((activePlayer) => activePlayer.id);
    const allActiveSelected = activePlayerIds.length > 0 && activePlayerIds.every((activePlayerId) => batch.selections.has(activePlayerId));

    if (allActiveSelected) {
      startAnswerPhase(room);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:player-custom-question-editing', (payload = {}, callback) => {
    const code = String(payload.code || payload.lobbyId || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);
    const batch = room?.match?.questionBatch;

    if (!room || !player || !room.match || !batch || room.match.phase !== 'question-selection') {
      callback?.({ ok: false, reason: 'No hay una tanda de preguntas activa.' });
      return;
    }

    const allowedOptionIds = new Set((batch.optionsByPlayer.get(playerId) || []).map((option) => option.id));

    if (!allowedOptionIds.has(SPECIAL_QUESTION_OPTION.id)) {
      callback?.({ ok: false, reason: 'La pregunta especial no esta disponible en esta tanda.' });
      return;
    }

    if (!batch.customEditingDeadlines.has(playerId)) {
      batch.customEditingDeadlines.set(playerId, Date.now() + CUSTOM_QUESTION_EXTRA_MS);
    }

    io.to(room.code).emit('player-custom-question-editing', {
      lobbyId: room.code,
      playerId,
      extraTime: CUSTOM_QUESTION_EXTRA_MS / 1000,
    });
    emitQuestionState(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:submit-answer', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const answer = String(payload.answer || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);
    const batch = room?.match?.questionBatch;
    const currentAnswer = room ? getCurrentAnswerPayload(room) : null;

    if (!room || !player || !room.match || !batch || room.match.phase !== 'answer-phase' || !currentAnswer) {
      callback?.({ ok: false, reason: 'No hay una pregunta activa para responder.' });
      return;
    }

    if (!['yes', 'no'].includes(answer)) {
      callback?.({ ok: false, reason: 'Respuesta no valida.' });
      return;
    }

    if (playerId === currentAnswer.ownerPlayerId) {
      callback?.({ ok: false, reason: 'No puedes votar tu propia pregunta.' });
      return;
    }

    if (!player.active || room.match.waitingQuestionBatchPlayerIds?.has(playerId)) {
      callback?.({ ok: false, reason: 'Espera a la siguiente tanda de preguntas.' });
      return;
    }

    batch.votes.set(playerId, answer);
    emitQuestionState(room);

    const expectedVoters = getActiveMatchPlayers(room).filter((activePlayer) => activePlayer.id !== currentAnswer.ownerPlayerId);
    const allVoted = expectedVoters.every((activePlayer) => batch.votes.has(activePlayer.id));

    if (allVoted) {
      finalizeCurrentAnswer(room);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:scoreboard-updated', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);
    const scores = Array.isArray(payload.scores) ? payload.scores : [];

    if (!room || !room.match || room.match.phase !== 'scoreboard') {
      callback?.({ ok: false, reason: 'No hay un scoreboard activo.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede sincronizar el scoreboard.' });
      return;
    }

    room.match.scoreboard = {
      lobbyId: code,
      roundNumber:
        room.match.scoreboardSource === 'minigame'
          ? room.match.specialRound?.roundNumber || Number(payload.roundNumber || 0)
          : room.match.questionBatch?.roundNumber || Number(payload.roundNumber || 0),
      scores: scores
        .map((scoreEntry) => ({
          playerId: String(scoreEntry.playerId || ''),
          playerName: String(scoreEntry.playerName || ''),
          score: Number(scoreEntry.score || 0),
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

    emitScoreboardState(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:scoreboard-continue', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room || !room.match || room.match.phase !== 'scoreboard') {
      callback?.({ ok: false, reason: 'No hay un scoreboard activo.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede continuar a la siguiente tanda.' });
      return;
    }

    if (room.match.scoreboardSource === 'minigame') {
      const specialRoundNumber = room.match.specialRound?.roundNumber || (room.match.questionBatch?.roundNumber || 0) + 1;
      room.match.scoreboardSource = null;

      if (room.settings.minigamesOnly) {
        const maxRounds = Number(room.settings.rounds || 5);
        const nextRoundNumber = specialRoundNumber + 1;

        if (specialRoundNumber >= maxRounds) {
          finishQuestionsPhase(room);
        } else {
          startSpecialRound(room, nextRoundNumber);
        }
      } else {
        startQuestionBatch(room, specialRoundNumber);
      }

      callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
      return;
    }

    const currentRoundNumber = room.match.questionBatch?.roundNumber || 0;
    const maxRounds = Number(room.settings.rounds || 5);

    const nextRoundNumber = currentRoundNumber + 1;

    if (currentRoundNumber >= maxRounds) {
      finishQuestionsPhase(room);
    } else if ((room.match.specialRounds || []).includes(nextRoundNumber)) {
      startSpecialRound(room, nextRoundNumber);
    } else {
      startQuestionBatch(room, nextRoundNumber);
    }
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:special-round-continue', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);

    if (!room || !room.match || room.match.phase !== 'special-round') {
      callback?.({ ok: false, reason: 'No hay una ronda especial activa.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede saltar el minijuego.' });
      return;
    }

    const specialRoundNumber = room.match.specialRound?.roundNumber || (room.match.questionBatch?.roundNumber || 0) + 1;

    if (room.settings.minigamesOnly) {
      const maxRounds = Number(room.settings.rounds || 5);
      const nextRoundNumber = specialRoundNumber + 1;

      if (specialRoundNumber >= maxRounds) {
        finishQuestionsPhase(room);
      } else {
        startSpecialRound(room, nextRoundNumber);
      }
    } else {
      startQuestionBatch(room, specialRoundNumber);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:minigame-prepared', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);
    const specialRound = room?.match?.specialRound;
    const operations = Array.isArray(payload.operations) ? payload.operations : [];

    if (!room || !room.match || room.match.phase !== 'special-round' || !specialRound) {
      callback?.({ ok: false, reason: 'No hay un minijuego activo.' });
      return;
    }

    if (room.hostId !== hostId) {
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
    emitQuestionState(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  // Handler para minijuegos genéricos del registry (sin operations).
  // El host emite este evento para marcar preparedByHost = true y arrancar la ronda.
  socket.on('match:minigame-generic-prepared', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);
    const specialRound = room?.match?.specialRound;

    if (!room || !room.match || room.match.phase !== 'special-round' || !specialRound) {
      callback?.({ ok: false, reason: 'No hay un minijuego activo.' });
      return;
    }

    if (room.hostId !== hostId) {
      callback?.({ ok: false, reason: 'Solo el host puede preparar el minijuego.' });
      return;
    }

    if (specialRound.preparedByHost) {
      callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
      return;
    }

    specialRound.preparedByHost = true;
    specialRound.progress = new Map();
    specialRound.results = [];
    specialRound.gameEndsAt = Number(payload.gameEndsAt) || (Date.now() + 60000);
    specialRound.hostMinigameData = payload.hostMinigameData ?? null;

    io.to(room.code).emit('match:minigame-prepared', {
      lobbyId: room.code,
      specialRound: toPublicSpecialRound(specialRound),
    });
    emitQuestionState(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:minigame-submit', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);
    const specialRound = room?.match?.specialRound;
    const answers = Array.isArray(payload.answers) ? payload.answers : [];

    if (!room || !player || !room.match || room.match.phase !== 'special-round' || !specialRound) {
      callback?.({ ok: false, reason: 'No hay un minijuego activo.' });
      return;
    }

    if (!specialRound.preparedByHost || !Array.isArray(specialRound.operations) || !specialRound.operations.length) {
      callback?.({ ok: false, reason: 'El minijuego todavia se esta preparando.' });
      return;
    }

    if (!player.active || room.match.waitingQuestionBatchPlayerIds?.has(playerId)) {
      callback?.({ ok: false, reason: 'Espera a la siguiente tanda de preguntas.' });
      return;
    }

    if (!specialRound.submissions) {
      specialRound.submissions = new Map();
    }

    if (specialRound.submissions.has(playerId)) {
      callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
      return;
    }

    specialRound.submissions.set(playerId, {
      playerId,
      answers: answers.map((answer) => ({
        operationId: String(answer.operationId || ''),
        answer: Number(answer.answer),
      })),
      finishedAt: Date.now(),
    });

    const expectedPlayerIds = getActiveMatchPlayers(room).map((activePlayer) => activePlayer.id);
    const allSubmitted =
      expectedPlayerIds.length > 0 && expectedPlayerIds.every((activePlayerId) => specialRound.submissions.has(activePlayerId));

    io.to(room.code).emit('match:minigame-submission-updated', {
      lobbyId: room.code,
      submittedPlayerIds: Array.from(specialRound.submissions.keys()),
      totalPlayers: expectedPlayerIds.length,
    });

    if (allSubmitted) {
      startMinigameScoreboardPhase(room);
    } else {
      emitQuestionState(room);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:minigame-answer', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const answeredCount = Math.max(0, Number(payload.answeredCount || 0));
    const correctCount = Math.max(0, Number(payload.correctCount || 0));
    const completed = Boolean(payload.completed);
    const finishedAt = payload.finishedAt ? Number(payload.finishedAt) : null;
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);
    const specialRound = room?.match?.specialRound;

    if (!room || !player || !room.match || room.match.phase !== 'special-round' || !specialRound) {
      callback?.({ ok: false, reason: 'No hay un minijuego activo.' });
      return;
    }

    if (!specialRound.preparedByHost) {
      callback?.({ ok: false, reason: 'El minijuego todavia se esta preparando.' });
      return;
    }

    // math-operations exige operations; minijuegos genéricos del registry no las tienen.
    const isMathMinigame = specialRound.minigameId === 'math-operations';
    if (isMathMinigame && (!Array.isArray(specialRound.operations) || !specialRound.operations.length)) {
      callback?.({ ok: false, reason: 'El minijuego todavia se esta preparando.' });
      return;
    }

    if (!Number.isFinite(answeredCount) || !Number.isFinite(correctCount)) {
      callback?.({ ok: false, reason: 'Progreso de minijuego no valido.' });
      return;
    }

    if (!player.active || room.match.waitingQuestionBatchPlayerIds?.has(playerId)) {
      callback?.({ ok: false, reason: 'Espera a la siguiente tanda de preguntas.' });
      return;
    }

    specialRound.progress = specialRound.progress || new Map();
    const currentProgress = specialRound.progress.get(playerId) || {
      playerId,
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

    // Para math-operations se clampea el progreso al número de operaciones.
    // Para minijuegos genéricos se acepta el progreso tal como llega.
    const operationCount = isMathMinigame ? specialRound.operations.length : Math.max(answeredCount, 1);
    const clampedAnsweredCount = Math.min(answeredCount, operationCount);
    const clampedCorrectCount = Math.min(correctCount, clampedAnsweredCount);
    currentProgress.answers = Array.from({ length: clampedAnsweredCount }, (_unused, index) => ({
      operationId: specialRound.operations?.[index]?.id || `step-${index + 1}`,
      answer: null,
      correct: index < clampedCorrectCount,
    }));
    currentProgress.correctCount = clampedCorrectCount;
    currentProgress.completed = completed || (isMathMinigame && clampedAnsweredCount >= operationCount);
    currentProgress.finishedAt = currentProgress.completed ? finishedAt || Date.now() : null;

    specialRound.progress.set(playerId, currentProgress);

    io.to(room.code).emit('match:minigame-progress-updated', {
      lobbyId: room.code,
      progress: toPublicSpecialRound(specialRound).progress,
    });

    if (currentProgress.completed) {
      startMinigameScoreboardPhase(room);
    } else {
      emitQuestionState(room);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:paint-prepared', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const hostId = String(payload.hostId || '').trim();
    const room = gameState.rooms.get(code);
    const specialRound = room?.match?.specialRound;
    const rawTarget = payload.paintTarget || {};
    const label = String(rawTarget.label || '').trim();

    if (!room || !room.match || room.match.phase !== 'special-round' || !specialRound || specialRound.minigameId !== 'paint') {
      callback?.({ ok: false, reason: 'No hay una ronda de dibujo activa.' });
      return;
    }

    if (room.hostId !== hostId) {
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
    const minigameConfig = getMinigameConfig(specialRound.minigameId);
    const durationSeconds = minigameConfig ? minigameConfig.durationSeconds : 60;

    specialRound.preparedByHost = true;
    specialRound.paintTarget = {
      id: String(rawTarget.id || label.toLowerCase().replace(/\s+/g, '-')),
      label,
    };
    specialRound.paintPhase = 'drawing';
    specialRound.paintEndsAt = Date.now() + (durationSeconds * 1000);
    specialRound.paintVoteEndsAt = null;
    specialRound.paintSubmissions = new Map();
    specialRound.paintVotes = new Map();
    specialRound.results = [];

    io.to(room.code).emit('match:paint-prepared', {
      lobbyId: room.code,
      specialRound: toPublicSpecialRound(specialRound),
    });
    emitQuestionState(room);
    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:paint-submit', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const playerId = String(payload.playerId || '').trim();
    const imageDataUrl = String(payload.imageDataUrl || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(playerId);
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
    specialRound.paintSubmissions.set(playerId, {
      playerId,
      playerName: player.name,
      imageDataUrl,
      submittedAt: Date.now(),
    });

    const activePlayerIds = getActiveMatchPlayers(room).map((activePlayer) => activePlayer.id);
    const allSubmitted =
      activePlayerIds.length > 0 && activePlayerIds.every((activePlayerId) => specialRound.paintSubmissions.has(activePlayerId));

    io.to(room.code).emit('match:paint-submission-updated', {
      lobbyId: room.code,
      specialRound: toPublicSpecialRound(specialRound),
    });

    if (allSubmitted) {
      startPaintVotingPhase(room);
    } else {
      emitQuestionState(room);
    }

    callback?.({ ok: true, lobby: toLobby(room), match: toMatchState(room) });
  });

  socket.on('match:paint-vote', (payload = {}, callback) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const voterPlayerId = String(payload.playerId || '').trim();
    const targetPlayerId = String(payload.targetPlayerId || '').trim();
    const room = gameState.rooms.get(code);
    const player = room?.players.get(voterPlayerId);
    const specialRound = room?.match?.specialRound;

    if (!room || !player || !room.match || room.match.phase !== 'special-round' || !specialRound || specialRound.minigameId !== 'paint') {
      callback?.({ ok: false, reason: 'No hay una votacion de dibujo activa.' });
      return;
    }

    if (specialRound.paintPhase !== 'voting') {
      callback?.({ ok: false, reason: 'La votacion todavia no esta activa.' });
      return;
    }

    if (voterPlayerId === targetPlayerId) {
      callback?.({ ok: false, reason: 'No puedes votar tu propio dibujo.' });
      return;
    }

    if (!specialRound.paintSubmissions?.has(targetPlayerId)) {
      callback?.({ ok: false, reason: 'Selecciona un dibujo valido.' });
      return;
    }

    specialRound.paintVotes = specialRound.paintVotes || new Map();
    specialRound.paintVotes.set(voterPlayerId, targetPlayerId);

    const expectedVoterIds = getActiveMatchPlayers(room)
      .map((activePlayer) => activePlayer.id)
      .filter((activePlayerId) =>
        Array.from(specialRound.paintSubmissions.keys()).some((targetId) => targetId !== activePlayerId),
      );
    const allVoted =
      expectedVoterIds.length > 0 && expectedVoterIds.every((activePlayerId) => specialRound.paintVotes.has(activePlayerId));

    emitQuestionState(room);

    if (allVoted) {
      startPaintScoreboardPhase(room);
    }

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

    if (!room.match?.hostPaused && room.match?.phase === 'question-selection') {
      const batch = room.match.questionBatch;
      assignTimedOutQuestions(room);
      const activePlayerIds = getActiveMatchPlayers(room).map((player) => player.id);
      const allActiveSelected =
        activePlayerIds.length > 0 && activePlayerIds.every((playerId) => batch?.selections.has(playerId));

      if (allActiveSelected) {
        startAnswerPhase(room);
      } else if (batch?.questionSelectionEndsAt && Date.now() >= batch.questionSelectionEndsAt) {
        emitQuestionState(room);
        emitQuestionBackup(room);
      }
    }

    if (!room.match?.hostPaused && room.match?.phase === 'answer-phase') {
      const batch = room.match.questionBatch;
      const currentAnswer = getCurrentAnswerPayload(room);

      if (batch && currentAnswer) {
        const expectedVoters = getActiveMatchPlayers(room).filter((player) => player.id !== currentAnswer.ownerPlayerId);
        const allVoted = expectedVoters.every((player) => batch.votes.has(player.id));

        if (allVoted || (batch.answerEndsAt && Date.now() >= batch.answerEndsAt)) {
          finalizeCurrentAnswer(room);
        }
      }
    }

    if (!room.match?.hostPaused && room.match?.phase === 'special-round' && room.match.specialRound?.minigameId === 'paint') {
      const specialRound = room.match.specialRound;

      if (specialRound.paintPhase === 'drawing' && specialRound.paintEndsAt && Date.now() >= specialRound.paintEndsAt) {
        startPaintVotingPhase(room);
      }

      if (specialRound.paintPhase === 'voting' && specialRound.paintVoteEndsAt && Date.now() >= specialRound.paintVoteEndsAt) {
        startPaintScoreboardPhase(room);
      }
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
        if (room.match.phase === 'countdown' || room.match.phase === 'image-selection') {
          room.match.selections.delete(playerId);
        }
        broadcastImageSelectionUpdate(room);
        startHostPause(room);
        continue;
      }

      if (room.match && room.match.phase !== 'lobby') {
        player.active = false;
        player.ready = false;
        if (room.match.phase === 'question-selection' || room.match.phase === 'answer-phase') {
          room.match.waitingQuestionBatchPlayerIds = room.match.waitingQuestionBatchPlayerIds || new Set();
          room.match.waitingQuestionBatchPlayerIds.add(playerId);
          emitQuestionState(room);
        } else {
          room.match.selections.delete(playerId);
          broadcastImageSelectionUpdate(room);
        }
        broadcastLobby(room);
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