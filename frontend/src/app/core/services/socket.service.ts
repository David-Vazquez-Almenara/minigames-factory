import { Injectable, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';

interface ServerReadyPayload {
  socketId: string;
  message: string;
  minigames?: MinigameInfo[];
}

export interface CreateRoomSettings {
  rounds: number;
  enabledMinigames: string[];
}

export interface MinigameInfo {
  id: string;
  title: string;
  description: string;
  image: string;
  accent: string;
  minPlayers: number;
}

export interface LobbyPlayer {
  id: string;
  name: string;
  avatarUrl: string;
  color: string;
  joinedAt: string;
  active: boolean;
  ready: boolean;
}

export interface LobbyState {
  code: string;
  hostId: string;
  settings: CreateRoomSettings;
  players: LobbyPlayer[];
  createdAt: string;
}

export type MatchPhase = 'countdown' | 'roulette' | 'special-round' | 'scoreboard' | 'finished';

export interface RouletteState {
  roundNumber: number;
  options: MinigameInfo[];
  winnerId: string;
  winnerIndex: number;
  spinStartsAt: number;
  spinDurationMs: number;
  landingOffset: number;
}

export interface MatchState {
  lobbyId: string;
  phase: MatchPhase;
  roundNumber: number;
  totalRounds: number;
  totalPlayers: number;
  hostPaused: boolean;
  hostPauseDeadline: number | null;
  countdownEndsAt: number;
  roulette: RouletteState | null;
  scoreboard: ScoreboardPayload | null;
  scoreboardRequest: ScoreboardCalculateRequest | null;
  finalStandings: ScoreboardEntry[] | null;
  specialRound: SpecialRoundPayload | null;
  serverTime: number;
}

export interface SpecialRoundPayload {
  roundNumber: number;
  minigameId: string;
  title: string;
  description: string;
  /** Tiempos de la intro en el reloj del servidor: titulo "Minijuego" y despues la explicacion. */
  startedAt?: number;
  introMs?: number;
  titleEndsAt?: number;
  introEndsAt?: number;
  participantIds: string[];
  hasResults: boolean;
  /** Si el host no pulsa "Ver marcador", el servidor lo abre solo en este momento. */
  autoScoreboardAt?: number | null;
  preparedByHost?: boolean;
  operations?: MathOperationPayload[];
  submittedPlayerIds?: string[];
  paintTarget?: PaintTargetPayload | null;
  paintPhase?: 'preparing' | 'drawing' | 'voting' | 'finished' | null;
  paintEndsAt?: number | null;
  paintVoteEndsAt?: number | null;
  paintSubmissions?: PaintSubmissionPayload[];
  paintVotes?: PaintVotePayload[];
  progress?: MinigameProgressPayload[];
  results?: MinigameResultPayload[];
  impostor: ImpostorPublicState | null;
  tenBut: TenButPublicState | null;
  pinturillo: PinturilloPublicState | null;
  pogo: PogoPublicState | null;
  blackjack?: BlackjackPublicState | null;
  barrels?: BarrelsPublicState | null;
  balloon?: BalloonPublicState | null;
  cups?: CupsPublicState | null;
  cars?: CarsPublicState | null;
  dance?: DancePublicState | null;
  count?: CountPublicState | null;
  duel?: DuelPublicState | null;
  stopwatch?: StopwatchPublicState | null;
  tower?: TowerPublicState | null;
  beer?: BeerPublicState | null;
  chop?: ChopPublicState | null;
  swing?: SwingPublicState | null;
  golf?: GolfPublicState | null;
  order?: OrderPublicState | null;
  bowling?: BowlingPublicState | null;
  who?: WhoPublicState | null;
  crossy?: CrossyPublicState | null;
  javelin?: JavelinPublicState | null;
  quiz?: QuizPublicState | null;
  push?: PushPublicState | null;
  russian?: RussianPublicState | null;
}

export interface RussianPublicState {
  stage: 'walking' | 'deciding' | 'firing' | 'reload' | 'finished';
  order: string[];
  alive: string[];
  eliminated: Array<{ playerId: string; turnNumber: number }>;
  /** Balas en el tambor en esta carga (de 6 recamaras). */
  bullets: number;
  chambers: number;
  load: number;
  turnIndex: number;
  turnNumber: number;
  currentPlayerId: string | null;
  turnStartsAt: number | null;
  arriveAt: number | null;
  decideStartsAt: number | null;
  decideEndsAt: number | null;
  lastShot: { turnNumber: number; playerId: string; skipped: boolean; bang: boolean; at: number; firesAt: number } | null;
  nextAt: number | null;
  timings: { walkMs: number; pickupMs: number; skipMs: number; triggerMs: number; putdownMs: number; deadMs: number };
  outcome: { ranking: Array<{ playerId: string; playerName: string; survived: boolean; position: number; points: number }> } | null;
}

export interface QuizPublicState {
  stage: 'answering' | 'votes' | 'correct' | 'finished';
  round: number;
  totalRounds: number;
  category: string;
  difficulty: number;
  question: string;
  options: string[];
  questionAt: number | null;
  answerStartsAt: number | null;
  answerEndsAt: number | null;
  correctAt: number | null;
  nextRoundAt: number | null;
  answeredPlayerIds: string[];
  /** Que ha votado cada uno (solo cuando ya se ha revelado). */
  answers: Array<{ playerId: string; choice: number }>;
  correctIndex: number | null;
  history: Array<{ round: number; points: Array<{ playerId: string; points: number }> }>;
  outcome: { ranking: Array<{ playerId: string; playerName: string; hits: number; points: number }> } | null;
}

export interface PushPublicState {
  stage: 'aiming' | 'launching' | 'resolved' | 'finished';
  round: number;
  totalRounds: number;
  arenaRadius: number;
  discRadius: number;
  maxSpeed: number;
  players: Array<{ playerId: string; x: number; y: number; alive: boolean; fellRound: number | null }>;
  aimStartsAt: number | null;
  aimEndsAt: number | null;
  confirmedPlayerIds: string[];
  impulses: Array<{ playerId: string; vx: number; vy: number }>;
  /** Posiciones de salida de la ronda (para simularla aunque el resultado ya haya llegado). */
  launchBodies: Array<{ playerId: string; x: number; y: number }>;
  launchAt: number | null;
  nextRoundAt: number | null;
  outcome: {
    ranking: Array<{ playerId: string; playerName: string; survived: boolean; fellRound: number | null; position: number; points: number }>;
  } | null;
}

export interface WhoRoundResult {
  round: number;
  question: string;
  votes: Array<{ voterId: string; targetId: string }>;
  tally: Array<{ playerId: string; count: number }>;
  /** Mas votados de la ronda (varios si hay empate). */
  chosen: string[];
  points: Array<{ playerId: string; points: number }>;
}

export interface WhoPublicState {
  stage: 'question' | 'voting' | 'reveal' | 'finished';
  round: number;
  totalRounds: number;
  question: string;
  questionAt: number | null;
  voteStartsAt: number | null;
  voteEndsAt: number | null;
  nextRoundAt: number | null;
  votedPlayerIds: string[];
  history: WhoRoundResult[];
  outcome: { ranking: Array<{ playerId: string; playerName: string; points: number; hits: number }> } | null;
}

export type CrossyRow =
  | { type: 'grass'; trees: number[] }
  | { type: 'road'; dir: 1 | -1; speed: number; length: number; cars: number[]; color: number }
  | { type: 'rail'; dir: 1 | -1; periodMs: number; offsetMs: number };

export interface CrossyPlayerState {
  playerId: string;
  best: number;
  row: number;
  col: number;
  dead: boolean;
  finished: boolean;
}

export interface CrossyPublicState {
  stage: 'playing' | 'finished';
  cols: number;
  finishRow: number;
  /** Longitud (en columnas) del recorrido ciclico de los coches. */
  wrap: number;
  rows: CrossyRow[];
  startsAt: number;
  endsAt: number;
  players: CrossyPlayerState[];
  outcome: {
    ranking: Array<{ playerId: string; playerName: string; rows: number; finished: boolean; dead: boolean; position: number; points: number }>;
  } | null;
}

export interface JavelinThrow {
  playerId: string;
  index: number;
  angle: number;
  power: number;
  landX: number;
  distance: number;
  at: number;
}

export interface JavelinPublicState {
  stage: 'throwing' | 'zoom' | 'finished';
  map: number;
  flagX: number;
  throwsPerPlayer: number;
  startsAt: number;
  endsAt: number;
  zoomEndsAt: number | null;
  throws: JavelinThrow[];
  outcome: {
    ranking: Array<{ playerId: string; playerName: string; distance: number | null; throws: number; position: number; points: number }>;
  } | null;
}

export interface GolfShot {
  playerId: string;
  angle: number;
  power: number;
  holed: boolean;
  distance: number;
  missed: boolean;
}

export interface GolfPublicState {
  stage: 'aiming' | 'rolling' | 'finished';
  round: number;
  totalRounds: number;
  /** Indice del mapa de la ronda (los mapas estan definidos en el cliente). */
  map: number;
  aimStartsAt: number | null;
  aimEndsAt: number | null;
  rollStartsAt: number | null;
  rollMs: number;
  nextRoundAt: number | null;
  shotPlayerIds: string[];
  history: Array<{ round: number; map: number; shots: GolfShot[] }>;
  outcome: { ranking: Array<{ playerId: string; playerName: string; total: number; holes: number; position: number; points: number }> } | null;
}

export interface OrderPublicState {
  stage: 'showing' | 'reveal' | 'finished';
  round: number;
  totalRounds: number;
  ingredientCount: number;
  /** Capas de la hamburguesa de la ronda (de abajo arriba, sin los panes). */
  recipe: number[];
  showStartsAt: number | null;
  buildStartsAt: number | null;
  buildEndsAt: number | null;
  nextRoundAt: number | null;
  reportedPlayerIds: string[];
  history: Array<{ round: number; results: Array<{ playerId: string; success: boolean; ms: number }> }>;
  outcome: { ranking: Array<{ playerId: string; playerName: string; completed: number; totalMs: number; position: number; points: number }> } | null;
}

export interface BowlingPublicState {
  stage: 'aiming' | 'rolling' | 'finished';
  aimStartsAt: number;
  aimEndsAt: number;
  thrownPlayerIds: string[];
  rollStartsAt: number | null;
  rollMs: number;
  results: Array<{ playerId: string; pins: number }>;
  outcome: { ranking: Array<{ playerId: string; playerName: string; pins: number; position: number; points: number }> } | null;
}

export interface ChopPublicState {
  stage: 'playing' | 'finished';
  startsAt: number;
  endsAt: number;
  resultsAt: number;
  reportedPlayerIds: string[];
  outcome: { ranking: Array<{ playerId: string; playerName: string; veggies: number; position: number; points: number }> } | null;
}

export interface SwingJump {
  playerId: string;
  angle: number;
  dir: 1 | -1;
  distance: number;
  flightMs: number;
}

export interface SwingPublicState {
  stage: 'walking' | 'swinging' | 'flying' | 'finished';
  order: string[];
  turnIndex: number;
  currentPlayerId: string | null;
  periodMs: number;
  walkStartsAt: number | null;
  swingStartsAt: number | null;
  swingEndsAt: number | null;
  flightStartsAt: number | null;
  nextTurnAt: number | null;
  jumps: SwingJump[];
  outcome: { ranking: Array<{ playerId: string; playerName: string; distance: number; backwards: boolean; position: number; points: number }> } | null;
}

export interface TowerPublicState {
  stage: 'playing' | 'finished';
  startsAt: number;
  endsAt: number;
  levels: Array<{ playerId: string; level: number; lost: boolean; finished: boolean }>;
  outcome: { ranking: Array<{ playerId: string; playerName: string; level: number; lost: boolean; position: number; points: number }> } | null;
}

export interface BeerThrow {
  playerId: string;
  power: number;
  distance: number;
  fell: boolean;
  gap: number;
}

export interface BeerPublicState {
  stage: 'aiming' | 'sliding' | 'finished';
  /** Metros de barra (de la linea de salida al borde). */
  length: number;
  /** Metros que recorre una jarra lanzada con la fuerza maxima. */
  reach: number;
  /** Fuerza (0-1) que deja la jarra justo en el borde: la linea roja del medidor. */
  perfectPower: number;
  aimStartsAt: number;
  aimEndsAt: number;
  thrownPlayerIds: string[];
  slideStartsAt: number | null;
  slideMs: number;
  throws: BeerThrow[];
  outcome: { ranking: Array<BeerThrow & { playerName: string; position: number; points: number }> } | null;
}

export type CountKind = 'walk' | 'run' | 'bike' | 'moto' | 'car';

export interface CountPublicState {
  stage: 'watching' | 'answering' | 'reveal';
  /** Guion completo: cada cliente lo reproduce. `at` en ms desde watchStartsAt; lane 0-2 acera cercana, 3-5 la del fondo. */
  schedule: Array<{ id: number; at: number; kind: CountKind; lane: number | 'road-near' | 'road-far'; dir: 1 | -1; speed: number; look: number }>;
  travel: number;
  watchStartsAt: number;
  watchEndsAt: number;
  answerEndsAt: number;
  timeBannerMs: number;
  answeredPlayerIds: string[];
  outcome: {
    total: number;
    ranking: Array<{ playerId: string; playerName: string; answer: number | null; distance: number | null; position: number; points: number }>;
  } | null;
}

export interface DuelPublicState {
  stage: 'waiting' | 'result' | 'finished';
  round: number;
  totalRounds: number;
  dealerMs: number;
  roundStartsAt: number | null;
  signalAt: number | null;
  deadline: number | null;
  nextRoundAt: number | null;
  results: Array<{ playerId: string; reactionMs: number | null; foul: boolean; hit: boolean }>;
  history: Array<{ round: number; dealerMs: number; results: Array<{ playerId: string; reactionMs: number | null; foul: boolean; hit: boolean }> }>;
  outcome: { ranking: Array<{ playerId: string; playerName: string; wins: number; averageMs: number | null; position: number; points: number }> } | null;
}

export interface StopwatchPublicState {
  stage: 'running' | 'reveal' | 'finished';
  round: number;
  totalRounds: number;
  targetMs: number;
  visibleMs: number;
  maxErrorMs: number;
  startsAt: number | null;
  deadline: number | null;
  nextRoundAt: number | null;
  stoppedPlayerIds: string[];
  history: Array<{ round: number; targetMs: number; results: Array<{ playerId: string; elapsedMs: number | null; errorMs: number }> }>;
  outcome: { ranking: Array<{ playerId: string; playerName: string; totalErrorMs: number; position: number; points: number }> } | null;
}

export interface DancePublicState {
  stage: 'playing' | 'break' | 'finished';
  round: number;
  totalRounds: number;
  lengths: number[];
  timesMs: number[];
  /** Secuencias de todas las rondas (letras y, para el modo por colores, indices de la paleta). */
  sequences: Array<{ letters: string[]; colors: number[] }>;
  paletteSize: number;
  roundStartsAt: number | null;
  roundEndsAt: number | null;
  breakEndsAt: number | null;
  alive: string[];
  eliminated: Array<{ playerId: string; round: number }>;
  roundLosers: string[];
  outcome: {
    rounds: number;
    ranking: Array<{ playerId: string; playerName: string; survived: boolean; eliminatedRound: number | null; position: number; points: number }>;
  } | null;
}

export interface CupsPublicState {
  stage: 'shuffling' | 'voting' | 'closing' | 'reveal' | 'finished';
  round: number;
  totalRounds: number;
  cupCount: number;
  initialSlot: number;
  moves: Array<{ type: 'swap' | 'fake'; a: number; b: number }>;
  moveMs: number;
  placeMs: number;
  placeStartsAt: number;
  shuffleStartsAt: number;
  shuffleEndsAt: number;
  voteEndsAt: number;
  revealAt: number | null;
  nextRoundAt: number | null;
  revealedSlot: number | null;
  /** Vacio mientras se vota: los votos de los demas no se ven hasta cerrar la votacion. */
  votes: Array<{ playerId: string; slot: number }>;
  votedPlayerIds?: string[];
  scores: Array<{ playerId: string; score: number }>;
  history: Array<{ round: number; ballSlot: number; votes: Array<{ playerId: string; slot: number }>; winners: string[] }>;
  outcome: { ranking: Array<{ playerId: string; playerName: string; hits: number; points: number }> } | null;
}

export interface CarsPublicState {
  stage: 'choosing' | 'waiting' | 'passing' | 'aftermath' | 'returning' | 'finished';
  round: number;
  maxRounds: number;
  lanes: number;
  sides: Array<{ playerId: string; side: 'left' | 'right'; index: number }>;
  alive: string[];
  choices: Array<{ playerId: string; lane: number }>;
  chooseEndsAt: number | null;
  hornAt: number | null;
  passStartsAt: number | null;
  impactAt: number | null;
  driveMs: number;
  nextRoundAt: number | null;
  carLanes: number[];
  hits: string[];
  eliminated: Array<{ playerId: string; round: number }>;
  outcome: {
    rounds: number;
    ranking: Array<{ playerId: string; playerName: string; survived: boolean; eliminatedRound: number | null; position: number; points: number }>;
  } | null;
}

export interface BalloonPublicState {
  stage: 'walking' | 'pumping' | 'exploded';
  order: string[];
  round: number;
  turnIndex: number;
  turnNumber: number;
  currentPlayerId: string | null;
  air: number;
  pumpsThisTurn: number;
  minCapacity: number;
  maxCapacity: number;
  walkMs: number;
  turnStartsAt: number | null;
  turnEndsAt: number | null;
  turnToken: string | null;
  lastPump: { playerId: string; air: number; turnNumber: number; pump: number; at: number } | null;
  outcome: {
    explodedBy: string | null;
    explodedName: string;
    air: number;
    capacity: number;
    round: number;
    at: number;
    results: Array<{ playerId: string; playerName: string; points: number }>;
  } | null;
}

export interface BlackjackCard {
  id: string;
  rank?: string;
  suit?: 'S' | 'H' | 'D' | 'C';
  hidden?: boolean;
}

export type BlackjackOutcome = 'win' | 'blackjack' | 'push' | 'lose' | 'sat-out';

export interface BlackjackSeat {
  playerId: string;
  chips: number;
  bet: number;
  confirmed: boolean;
  status: 'queued' | 'betting' | 'ready' | 'sitting-out' | 'broke' | 'waiting' | 'playing' | 'blackjack' | 'stood' | 'bust';
  cards: BlackjackCard[];
  value: { total: number; soft: boolean };
  history: Array<{ hand: number; bet: number; outcome: BlackjackOutcome; delta: number; total: number; chipsAfter: number }>;
}

export interface BlackjackPublicState {
  stage: 'betting' | 'dealing' | 'player-turns' | 'group-change' | 'dealer-turn' | 'hand-summary' | 'final';
  handNumber: number;
  totalHands: number;
  minBet: number;
  startChips: number;
  tableSize: number;
  seats: string[];
  /** Mesas de hasta 4 jugadores; con mas jugadores se juega grupo a grupo. */
  groups: string[][];
  groupIndex: number;
  previousGroupIndex: number | null;
  groupChangeEndsAt: number | null;
  groupChangeMs: number;
  turnLocked: boolean;
  players: BlackjackSeat[];
  dealer: { cards: BlackjackCard[]; value: { total: number; soft: boolean }; revealed: boolean };
  dealOrder: Array<{ to: string; index: number; hidden?: boolean }>;
  dealStartedAt: number | null;
  dealInterval: number;
  betEndsAt: number | null;
  currentPlayerId: string | null;
  turnEndsAt: number | null;
  turnToken: string | null;
  summaryEndsAt: number | null;
  lastSummary: {
    hand: number;
    dealerTotal: number;
    dealerBust: boolean;
    results: Array<{ playerId: string; outcome: BlackjackOutcome; delta: number; bet: number; total: number }>;
  } | null;
  finalRanking: Array<{
    playerId: string;
    playerName: string;
    position: number;
    startChips: number;
    finalChips: number;
    net: number;
    broke: boolean;
    hands: Array<{ hand: number; outcome: BlackjackOutcome; delta: number }>;
    points: number;
  }> | null;
}

export interface BarrelRacer {
  playerId: string;
  status: 'falling' | 'stopped' | 'crushed';
  height: number | null;
  elapsedMs: number | null;
}

export interface BarrelsPublicState {
  stage: 'falling' | 'results';
  roundId: string;
  startsAt: number;
  fallMs: number;
  startHeight: number;
  exponent: number;
  racers: BarrelRacer[];
  ranking: Array<BarrelRacer & { position: number; points: number; playerName: string }> | null;
}

export interface ImpostorRoundResult {
  wordRound: number;
  reason: 'ejected' | 'tie' | 'skip' | 'no-votes';
  ejectedId: string | null;
  skipCount: number;
  tally: Array<{ playerId: string; votes: number }>;
  votes: Array<{ voterId: string; targetId: string }>;
}

export interface ImpostorOutcome {
  winner: 'innocents' | 'impostor';
  abandoned: boolean;
  reason: ImpostorRoundResult['reason'] | 'abandoned';
  ejectedId: string | null;
  ejectedWasImpostor: boolean;
  impostorId: string;
  impostorName: string;
  word: string;
  category: string;
  roundsPlayed: number;
  extraRounds: number;
  impostorPoints: number;
  tally: ImpostorRoundResult['tally'];
  skipCount: number;
  votes: ImpostorRoundResult['votes'];
}

export interface ImpostorPublicState {
  stage: 'turns' | 'voting' | 'no-ejection' | 'reveal';
  wordRound: number;
  maxRounds: number;
  blankVoteAllowed: boolean;
  turnOrder: string[];
  turnIndex: number;
  currentTurnPlayerId: string | null;
  completedTurnIds: string[];
  votedPlayerIds: string[];
  voteEndsAt: number | null;
  stageStartedAt: number;
  lastRoundResult: ImpostorRoundResult | null;
  outcome: ImpostorOutcome | null;
}

export interface TenButAnswerResult {
  playerId: string;
  playerName: string;
  number: number | null;
  diff: number | null;
  points: number;
  valid: boolean;
}

export interface TenButOutcome {
  secretNumber: number;
  speakerId: string;
  speakerName: string;
  answers: TenButAnswerResult[];
  validCount: number;
  invalidCount: number;
  penaltyCap: number;
  speakerPositive: number;
  speakerPenalty: number;
  speakerTotal: number;
}

export interface TenButPublicState {
  stage: 'waiting-spin' | 'spinning' | 'answering' | 'results';
  speakerId: string;
  spinDeadline: number | null;
  spinStartsAt: number | null;
  spinDurationMs: number;
  answerEndsAt: number | null;
  answeredPlayerIds: string[];
  outcome: TenButOutcome | null;
}

export interface PinturilloChatMessage {
  id: string;
  at: number;
  kind: 'chat' | 'correct' | 'system' | 'guessed-chat';
  playerId?: string;
  text?: string;
  points?: number;
  order?: number;
}

export interface PinturilloOutcome {
  word: string;
  category: string;
  drawerId: string;
  drawerName: string;
  drawerLeft: boolean;
  guesses: Array<{ playerId: string; order: number; points: number; at: number }>;
  correctCount: number;
  guesserCount: number;
  drawerPoints: number;
  penaltyCap: number;
  finalFrame: string | null;
}

export interface PinturilloPublicState {
  stage: 'drawing' | 'results';
  drawerId: string;
  startsAt: number;
  endsAt: number;
  hint: string[];
  guessedPlayerIds: string[];
  chat: PinturilloChatMessage[];
  outcome: PinturilloOutcome | null;
}

export interface PogoRacer {
  playerId: string;
  progress: number;
  jumps: number;
  perfects: number;
  misses: number;
  finishedAt: number | null;
}

export interface PogoPublicState {
  stage: 'racing' | 'results';
  goal: number;
  raceStartsAt: number;
  raceEndsAt: number;
  racers: PogoRacer[];
  outcome: {
    ranking: Array<{
      playerId: string;
      playerName: string;
      position: number;
      progress: number;
      finished: boolean;
      timeMs: number | null;
      jumps: number;
      perfects: number;
      points: number;
    }>;
  } | null;
}

export interface PrivateMatchState {  lobbyId: string;
  roundKey: string | null;
  minigameId: string | null;
  impostor: { role: 'impostor'; category: string } | { role: 'innocent'; word: string } | null;
  tenBut:
    | { role: 'speaker'; secretNumber?: number; landingOffset?: number; submittedAnswer?: null }
    | { role: 'guesser'; submittedAnswer: number | null }
    | null;
  pinturillo?: { role: 'drawer'; word: string; category: string } | { role: 'guesser' } | null;
}

export interface PaintTargetPayload {
  id: string;
  label: string;
}

export interface PaintSubmissionPayload {
  playerId: string;
  playerName: string;
  imageDataUrl: string;
  submittedAt: number;
}

export interface PaintVotePayload {
  voterPlayerId: string;
  targetPlayerId: string;
}

export interface MathOperationPayload {
  id: string;
  prompt: string;
  answer?: number;
}

export interface MinigameResultPayload {
  playerId: string;
  playerName: string;
  correctCount: number;
  answeredCount?: number;
  votesReceived?: number;
  points?: number;
  finishedAt: number | null;
  submitted: boolean;
}

export interface MinigameProgressPayload {
  playerId: string;
  playerName: string;
  correctCount: number;
  answeredCount: number;
  completed: boolean;
  finishedAt: number | null;
}

export interface ScoreboardEntry {
  playerId: string;
  playerName: string;
  score: number;
  roundPoints?: number;
  position: number;
  minigameCorrectCount?: number;
  minigameAnsweredCount?: number;
  minigameVoteCount?: number;
}

export interface ScoreboardPayload {
  lobbyId: string;
  roundNumber: number;
  scores: ScoreboardEntry[];
  previousScores?: ScoreboardEntry[];
}

export interface ScoreboardCalculateRequest {
  lobbyId: string;
  roundNumber: number;
  source?: 'minigame';
  results?: MinigameResultPayload[];
  previousScores?: ScoreboardEntry[];
}

export interface RoomResponse {
  ok: boolean;
  reason?: string;
  lobby?: LobbyState;
  match?: MatchState | null;
  privateState?: PrivateMatchState;
  answer?: number;
}

const PLAYER_ID_KEY = 'quien-soy-online-player-id';
const PLAYER_SECRET_KEY = 'quien-soy-online-player-secret';
const HOST_ROOM_KEY = 'quien-soy-online-host-room';
const HOST_ID_KEY = 'quien-soy-online-host-id';
const BANNED_PLAYERS_KEY = 'quien-soy-online-banned-players';
const HOST_RECONNECT_LOBBY_KEY = 'quien-soy-online-host-reconnect-lobby';
const HOST_RECONNECT_CONFIG_KEY = 'quien-soy-online-host-reconnect-config';
const HEARTBEAT_INTERVAL_MS = 5000;

@Injectable({ providedIn: 'root' })
export class SocketService {
  private socket?: Socket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  readonly connected = signal(false);
  readonly serverMessage = signal('Backend pendiente de conexion');
  readonly minigameCatalog = signal<MinigameInfo[]>([]);
  readonly lobby = signal<LobbyState | null>(null);
  readonly match = signal<MatchState | null>(null);
  readonly privateState = signal<PrivateMatchState | null>(null);
  readonly clockOffset = signal(0);
  readonly scoreboard = signal<ScoreboardPayload | null>(null);
  readonly scoreboardCalculateRequest = signal<ScoreboardCalculateRequest | null>(null);
  readonly hostPauseDeadline = signal<number | null>(null);
  readonly kickedFromRoom = signal<string | null>(null);
  readonly closedRoomMessage = signal<string | null>(null);
  readonly returnedToLobby = signal<LobbyState | null>(null);
  /** Ultimo fotograma recibido del dibujante de Pinturillo (fuera del estado para no inflarlo). */
  readonly pinturilloFrame = signal<string | null>(null);
  /** Ultimo salto recibido en la carrera de pogo, para animar al jugador correspondiente. */
  readonly lastPogoJump = signal<{ playerId: string; gain: number; at: number } | null>(null);
  /** Cruza la carretera: ultima posicion conocida de cada gallina (llega aparte del estado, cada ~500 ms). */
  readonly crossyPositions = signal<Record<string, Omit<CrossyPlayerState, 'playerId'> & { at: number }>>({});
  /** Cuando el host ya esta en el lobby: momento (reloj local) en que el resto vuelve tambien. */
  readonly lobbyReturnAt = signal<number | null>(null);
  readonly playerId = this.getOrCreateStoredId(PLAYER_ID_KEY);
  private readonly playerSecret = this.getOrCreateStoredId(PLAYER_SECRET_KEY);

  connect(): void {
    if (this.socket) {
      return;
    }

    this.socket = io(environment.socketUrl, {
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      this.connected.set(true);
      const activeLobby = this.lobby();

      // Tras una reconexion se recupera el socket en la sala y la informacion privada del jugador.
      if (activeLobby) {
        this.startHeartbeat(activeLobby.code);
        void this.refreshPrivateState(activeLobby.code);
      }
    });

    this.socket.on('disconnect', () => {
      this.connected.set(false);
    });

    this.socket.on('server:ready', (payload: ServerReadyPayload) => {
      this.serverMessage.set(payload.message);
      this.minigameCatalog.set(payload.minigames || []);
    });

    this.socket.on('room:lobby-updated', (payload: LobbyState) => {
      this.lobby.set(payload);
      this.startHeartbeat(payload.code);
    });

    this.socket.on('room:kicked', (payload: { code: string }) => {
      this.stopHeartbeat();
      this.lobby.set(null);
      this.clearMatch();
      this.kickedFromRoom.set(payload.code);
    });

    this.socket.on('room:closed', (payload: { code: string; reason: string }) => {
      this.stopHeartbeat();
      this.lobby.set(null);
      this.clearMatch();
      this.closedRoomMessage.set(payload.reason || 'El lobby se ha cerrado.');
      this.clearLobbyUrl();
    });

    this.socket.on('room:presence-check', (payload: { code: string; playerId: string }) => {
      if (payload.playerId !== this.playerId) {
        return;
      }

      const params = new URLSearchParams(window.location.search);
      const activeMatch = this.match();
      const isActiveInRoom =
        params.get('room') === payload.code &&
        params.get('lobby') === 'true' &&
        (!activeMatch || activeMatch.lobbyId === payload.code);

      this.socket?.emit('room:presence-response', {
        code: payload.code,
        playerId: this.playerId,
        playerSecret: this.playerSecret,
        currentUrl: window.location.href,
        inLobby: isActiveInRoom,
      });
    });

    this.socket.on('room:get-banned-players', (_payload: { code: string }, callback) => {
      callback({
        ok: true,
        bannedPlayerIds: this.getBannedPlayerIds(_payload.code),
      });
    });

    this.socket.on('match:started', (payload: MatchState) => {
      this.applyMatchState(payload);
      this.startHeartbeat(payload.lobbyId);
    });

    this.socket.on('match:state', (payload: MatchState | null) => {
      if (payload) {
        this.applyMatchState(payload);
      }
    });

    this.socket.on('match:private-state', (payload: PrivateMatchState) => {
      if (payload.lobbyId === this.lobby()?.code || payload.lobbyId === this.match()?.lobbyId) {
        this.privateState.set(payload);
      }
    });

    this.socket.on('match:scoreboard-calculate', (payload: ScoreboardCalculateRequest) => {
      this.scoreboard.set(null);
      this.scoreboardCalculateRequest.set(payload);
    });

    this.socket.on('match:scoreboard-sync', (payload: { lobbyId: string; scoreboard: ScoreboardPayload | null }) => {
      this.scoreboard.set(payload.scoreboard);
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'scoreboard', scoreboard: payload.scoreboard }
          : currentMatch,
      );
    });

    for (const eventName of [
      'match:special-round-started',
      'match:minigame-prepared',
      'match:paint-prepared',
      'match:paint-submission-updated',
      'match:paint-voting-started',
      'match:paint-results-ready',
    ]) {
      this.socket.on(eventName, (payload: { lobbyId: string; specialRound: SpecialRoundPayload }) => {
        this.match.update((currentMatch) =>
          currentMatch && currentMatch.lobbyId === payload.lobbyId
            ? { ...currentMatch, specialRound: payload.specialRound }
            : currentMatch,
        );
      });
    }

    this.socket.on('match:minigame-progress-updated', (payload: { lobbyId: string; progress: MinigameProgressPayload[] }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId && currentMatch.specialRound
          ? {
              ...currentMatch,
              specialRound: {
                ...currentMatch.specialRound,
                progress: payload.progress,
              },
            }
          : currentMatch,
      );
    });

    this.socket.on('match:pinturillo-chat', (payload: { lobbyId: string; message: PinturilloChatMessage }) => {
      this.match.update((currentMatch) => {
        const pinturillo = currentMatch?.specialRound?.pinturillo;

        if (!currentMatch || currentMatch.lobbyId !== payload.lobbyId || !pinturillo || pinturillo.chat.some((entry) => entry.id === payload.message.id)) {
          return currentMatch;
        }

        return {
          ...currentMatch,
          specialRound: {
            ...currentMatch.specialRound!,
            pinturillo: { ...pinturillo, chat: [...pinturillo.chat, payload.message].slice(-120) },
          },
        };
      });
    });

    this.socket.on('match:pinturillo-frame', (payload: { lobbyId: string; imageDataUrl: string }) => {
      if (payload.lobbyId === this.match()?.lobbyId) {
        this.pinturilloFrame.set(payload.imageDataUrl);
      }
    });

    this.socket.on(
      'match:crossy-move',
      (payload: { lobbyId: string; playerId: string; row: number; col: number; best: number; dead: boolean; finished: boolean }) => {
        if (payload.lobbyId === this.match()?.lobbyId) {
          const { lobbyId: _lobbyId, playerId, ...position } = payload;
          this.crossyPositions.update((positions) => ({ ...positions, [playerId]: { ...position, at: Date.now() } }));
        }
      },
    );

    this.socket.on('match:pogo-progress', (payload: { lobbyId: string; racers: PogoRacer[]; jump: { playerId: string; gain: number } }) => {
      this.lastPogoJump.set({ ...payload.jump, at: Date.now() });
      this.match.update((currentMatch) => {
        const pogo = currentMatch?.specialRound?.pogo;

        return currentMatch && currentMatch.lobbyId === payload.lobbyId && pogo
          ? { ...currentMatch, specialRound: { ...currentMatch.specialRound!, pogo: { ...pogo, racers: payload.racers } } }
          : currentMatch;
      });
    });

    // Parada de un barril: solo actualiza a ese jugador y solo si es de la ronda en curso (los mensajes
    // tardios de otra ronda se descartan). Nunca toca la prediccion local del propio jugador.
    this.socket.on('match:barrels-update', (payload: { lobbyId: string; roundId: string; racer: BarrelRacer }) => {
      this.match.update((currentMatch) => {
        const barrels = currentMatch?.specialRound?.barrels;

        if (!currentMatch || currentMatch.lobbyId !== payload.lobbyId || !barrels || barrels.roundId !== payload.roundId) {
          return currentMatch;
        }

        const racers = barrels.racers.map((racer) => (racer.playerId === payload.racer.playerId && racer.status === 'falling' ? payload.racer : racer));
        return { ...currentMatch, specialRound: { ...currentMatch.specialRound!, barrels: { ...barrels, racers } } };
      });
    });

    this.socket.on('match:host-paused', (payload: { lobbyId: string; deadline: number }) => {
      this.hostPauseDeadline.set(payload.deadline);
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, hostPaused: true, hostPauseDeadline: payload.deadline }
          : currentMatch,
      );
    });

    this.socket.on('match:host-resumed', (payload: { lobbyId: string }) => {
      this.hostPauseDeadline.set(null);
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, hostPaused: false, hostPauseDeadline: null }
          : currentMatch,
      );
    });

    this.socket.on('match:returned-to-lobby', (payload: { lobbyId: string; lobby: LobbyState }) => {
      this.clearMatch();
      this.lobby.set(payload.lobby);
      this.returnedToLobby.set(payload.lobby);
    });

    // El host ya esta en el lobby: el resto vuelve automaticamente al terminar la cuenta atras.
    this.socket.on('match:lobby-return-countdown', (payload: { lobbyId: string; at: number }) => {
      if (payload.lobbyId === this.match()?.lobbyId) {
        this.lobbyReturnAt.set(payload.at - this.clockOffset());
      }
    });

    this.socket.on('match:closed', (payload: { lobbyId: string; reason: string }) => {
      this.clearMatch();
      this.closedRoomMessage.set(payload.reason || 'La partida se ha cerrado.');
      this.clearLobbyUrl();
    });
  }

  /** Hora del servidor estimada; los plazos (deadlines) de la partida se expresan en ese reloj. */
  serverNow(): number {
    return Date.now() + this.clockOffset();
  }

  createRoom(playerName: string, avatarUrl: string, settings: CreateRoomSettings): Promise<RoomResponse> {
    return this.emitWithResponse('room:create', { playerId: this.playerId, playerName, avatarUrl, settings });
  }

  joinRoom(playerName: string, avatarUrl: string, code: string): Promise<RoomResponse> {
    return this.emitWithResponse('room:join', { playerId: this.playerId, playerName, avatarUrl, code });
  }

  kickPlayer(code: string, targetPlayerId: string): Promise<RoomResponse> {
    this.banPlayer(code, targetPlayerId);

    return this.emitWithResponse('room:kick-player', {
      code,
      targetPlayerId,
      hostId: this.playerId,
    });
  }

  setReady(code: string, ready: boolean): Promise<RoomResponse> {
    return this.emitWithResponse('room:set-ready', {
      code,
      ready,
      playerId: this.playerId,
    });
  }

  updateRoomSettings(code: string, settings: CreateRoomSettings): Promise<RoomResponse> {
    return this.emitWithResponse('room:update-settings', {
      code,
      settings,
      hostId: this.playerId,
    });
  }

  startMatch(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:start', {
      code,
      hostId: this.playerId,
    });
  }

  async refreshPrivateState(code: string): Promise<void> {
    const response = await this.emitWithResponse('match:request-private-state', { code, playerId: this.playerId });

    if (response.ok && response.privateState) {
      this.privateState.set(response.privateState);
    }
  }

  updateScoreboard(code: string, roundNumber: number, scores: ScoreboardEntry[]): Promise<RoomResponse> {
    return this.emitWithResponse('match:scoreboard-updated', {
      code,
      roundNumber,
      scores,
      hostId: this.playerId,
    });
  }

  continueFromScoreboard(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:scoreboard-continue', {
      code,
      hostId: this.playerId,
    });
  }

  continueFromSpecialRound(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:special-round-continue', {
      code,
      hostId: this.playerId,
    });
  }

  returnToLobby(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:return-to-lobby', {
      code,
      hostId: this.playerId,
    });
  }

  prepareMinigame(code: string, operations: MathOperationPayload[]): Promise<RoomResponse> {
    return this.emitWithResponse('match:minigame-prepared', {
      code,
      operations,
      hostId: this.playerId,
    });
  }

  submitMinigameProgress(
    code: string,
    progress: { answeredCount: number; correctCount: number; completed: boolean; finishedAt: number | null },
  ): Promise<RoomResponse> {
    return this.emitWithResponse('match:minigame-answer', {
      code,
      ...progress,
      playerId: this.playerId,
    });
  }

  preparePaintMinigame(code: string, paintTarget: PaintTargetPayload): Promise<RoomResponse> {
    return this.emitWithResponse('match:paint-prepared', {
      code,
      paintTarget,
      hostId: this.playerId,
    });
  }

  submitPaintDrawing(code: string, imageDataUrl: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:paint-submit', {
      code,
      imageDataUrl,
      playerId: this.playerId,
    });
  }

  submitPaintVote(code: string, targetPlayerId: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:paint-vote', {
      code,
      targetPlayerId,
      playerId: this.playerId,
    });
  }

  advanceImpostorTurn(code: string, turnIndex: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:impostor-advance-turn', {
      code,
      turnIndex,
      playerId: this.playerId,
    });
  }

  voteImpostor(code: string, targetId: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:impostor-vote', {
      code,
      targetId,
      playerId: this.playerId,
    });
  }

  spinTenBut(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:ten-but-spin', {
      code,
      playerId: this.playerId,
    });
  }

  answerTenBut(code: string, answer: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:ten-but-answer', {
      code,
      answer,
      playerId: this.playerId,
    });
  }

  sendPinturilloFrame(code: string, imageDataUrl: string): void {
    this.socket?.emit('match:pinturillo-frame', { code, imageDataUrl, playerId: this.playerId, playerSecret: this.playerSecret });
  }

  async requestPinturilloFrame(code: string): Promise<void> {
    const response = (await this.emitWithResponse('match:pinturillo-request-frame', { code, playerId: this.playerId })) as RoomResponse & {
      imageDataUrl?: string | null;
    };

    if (response.ok && response.imageDataUrl) {
      this.pinturilloFrame.set(response.imageDataUrl);
    }
  }

  guessPinturillo(code: string, text: string): Promise<RoomResponse & { correct?: boolean; close?: boolean; points?: number }> {
    return this.emitWithResponse('match:pinturillo-guess', { code, text, playerId: this.playerId });
  }

  pogoJump(code: string, gain: number): Promise<RoomResponse & { progress?: number; finished?: boolean }> {
    return this.emitWithResponse('match:pogo-jump', { code, gain, playerId: this.playerId });
  }

  betBlackjack(code: string, handNumber: number, amount: number): Promise<RoomResponse & { bet?: number }> {
    return this.emitWithResponse('match:blackjack-bet', { code, handNumber, amount, playerId: this.playerId });
  }

  blackjackAction(code: string, action: 'hit' | 'stand', turnToken: string): Promise<RoomResponse & { ignored?: boolean }> {
    return this.emitWithResponse('match:blackjack-action', { code, action, turnToken, playerId: this.playerId });
  }

  pumpBalloon(code: string, turnToken: string): Promise<RoomResponse & { air?: number; exploded?: boolean; ignored?: boolean }> {
    return this.emitWithResponse('match:balloon-pump', { code, turnToken, playerId: this.playerId });
  }

  passBalloon(code: string, turnNumber: number): Promise<RoomResponse & { ignored?: boolean }> {
    return this.emitWithResponse('match:balloon-pass', { code, turnNumber, playerId: this.playerId });
  }

  voteCup(code: string, round: number, slot: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:cups-vote', { code, round, slot, playerId: this.playerId });
  }

  chooseLane(code: string, round: number, lane: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:cars-choose', { code, round, lane, playerId: this.playerId });
  }

  answerCount(code: string, value: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:count-answer', { code, value, playerId: this.playerId });
  }

  /** Desenfundar: tiempo de reaccion medido en este cliente desde que vio la senal (o falta por adelantarse). */
  duelShot(code: string, round: number, shot: { reactionMs: number } | { foul: true }): Promise<RoomResponse> {
    return this.emitWithResponse('match:duel-shot', { code, round, ...shot, playerId: this.playerId });
  }

  towerProgress(code: string, level: number, state: { lost?: boolean; finished?: boolean } = {}): Promise<RoomResponse> {
    return this.emitWithResponse('match:tower-progress', { code, level, ...state, playerId: this.playerId });
  }

  golfShot(code: string, round: number, shot: { angle: number; power: number; holed: boolean; distance: number }): Promise<RoomResponse> {
    return this.emitWithResponse('match:golf-shot', { code, round, ...shot, playerId: this.playerId });
  }

  reportOrder(code: string, round: number, success: boolean, ms: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:order-report', { code, round, success, ms, playerId: this.playerId });
  }

  bowlingThrow(code: string, pins: number, aim: number, spin: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:bowling-throw', { code, pins, aim, spin, playerId: this.playerId });
  }

  whoVote(code: string, round: number, targetId: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:who-vote', { code, round, targetId, playerId: this.playerId });
  }

  crossyMove(code: string, move: { row: number; col: number; dead?: boolean }): Promise<RoomResponse> {
    return this.emitWithResponse('match:crossy-move', { code, ...move, playerId: this.playerId });
  }

  javelinThrow(code: string, shot: { angle: number; power: number; landX: number }): Promise<RoomResponse> {
    return this.emitWithResponse('match:javelin-throw', { code, ...shot, playerId: this.playerId });
  }

  russianAction(code: string, turnNumber: number, action: 'shoot' | 'skip'): Promise<RoomResponse> {
    return this.emitWithResponse('match:russian-action', { code, turnNumber, action, playerId: this.playerId });
  }

  quizAnswer(code: string, round: number, choice: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:quiz-answer', { code, round, choice, playerId: this.playerId });
  }

  pushAim(code: string, round: number, vx: number, vy: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:push-aim', { code, round, vx, vy, playerId: this.playerId });
  }

  pushResult(
    code: string,
    result: { round: number; positions: Array<{ playerId: string; x: number; y: number }>; falls: Array<{ playerId: string; step: number }>; steps: number },
  ): Promise<RoomResponse> {
    return this.emitWithResponse('match:push-result', { code, ...result, playerId: this.playerId });
  }

  reportChop(code: string, veggies: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:chop-report', { code, veggies, playerId: this.playerId });
  }

  releaseSwing(code: string, turnIndex: number, angle: number, dir: 1 | -1): Promise<RoomResponse> {
    return this.emitWithResponse('match:swing-release', { code, turnIndex, angle, dir, playerId: this.playerId });
  }

  throwBeer(code: string, power: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:beer-throw', { code, power, playerId: this.playerId });
  }

  stopStopwatch(code: string, round: number, elapsedMs: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:stopwatch-stop', { code, round, elapsedMs, playerId: this.playerId });
  }

  /** Pista de baile: este jugador ha completado la secuencia de la ronda (o se le ha acabado el tiempo). */
  reportDance(code: string, round: number, result: 'done' | 'fail'): Promise<RoomResponse> {
    return this.emitWithResponse(result === 'done' ? 'match:dance-done' : 'match:dance-fail', { code, round, playerId: this.playerId });
  }

  /** El host confirma que ha vuelto bien a su lobby (mismo codigo): entonces el servidor trae al resto. */
  confirmLobbyReturn(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:lobby-return-confirm', { code, lobbyId: code, hostId: this.playerId, playerId: this.playerId });
  }

  stopBarrel(
    code: string,
    roundId: string,
    elapsedMs: number,
  ): Promise<RoomResponse & { status?: BarrelRacer['status']; height?: number | null; elapsedMs?: number | null }> {
    return this.emitWithResponse('match:barrel-stop', { code, roundId, elapsedMs, playerId: this.playerId });
  }

  leaveRoom(code: string): Promise<RoomResponse> {
    this.stopHeartbeat();
    this.clearLobbyNavigation();
    return this.emitWithResponse('room:leave', {
      code,
      playerId: this.playerId,
    });
  }

  isCurrentPlayerHost(lobby: LobbyState | null): boolean {
    return Boolean(lobby && lobby.hostId === this.playerId);
  }

  saveHostForRoom(code: string): void {
    this.clearStoredHostIdentity();
    localStorage.setItem(HOST_ROOM_KEY, code);
    localStorage.setItem(HOST_ID_KEY, this.playerId);
  }

  clearStoredHostIdentity(): void {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);

      if (!key) {
        continue;
      }

      if (
        key === HOST_ROOM_KEY ||
        key === HOST_ID_KEY ||
        key.startsWith(`${HOST_ROOM_KEY}:`) ||
        key.startsWith(`${HOST_ID_KEY}:`) ||
        key.startsWith('quien-soy-online-host-reconnect-')
      ) {
        localStorage.removeItem(key);
      }
    }
  }

  hasHostIdentityForRoom(code: string): boolean {
    return localStorage.getItem(HOST_ROOM_KEY) === code && localStorage.getItem(HOST_ID_KEY) === this.playerId;
  }

  clearRoomNotices(): void {
    this.kickedFromRoom.set(null);
    this.closedRoomMessage.set(null);
    this.returnedToLobby.set(null);
    this.scoreboardCalculateRequest.set(null);
  }

  clearMatch(): void {
    this.match.set(null);
    this.privateState.set(null);
    this.pinturilloFrame.set(null);
    this.lastPogoJump.set(null);
    this.crossyPositions.set({});
    this.lobbyReturnAt.set(null);
    this.hostPauseDeadline.set(null);
    this.scoreboard.set(null);
    this.scoreboardCalculateRequest.set(null);
  }

  clearLobbyNavigation(): void {
    this.clearLobbyUrl();
  }

  prepareHostReconnectSnapshot(lobby: LobbyState): void {
    localStorage.setItem(
      HOST_RECONNECT_LOBBY_KEY,
      JSON.stringify({
        lobbyId: lobby.code,
        players: lobby.players.map((player) => player.id),
      }),
    );

    localStorage.setItem(
      HOST_RECONNECT_CONFIG_KEY,
      JSON.stringify({
        lobbyId: lobby.code,
        rounds: lobby.settings.rounds,
        enabledMinigames: lobby.settings.enabledMinigames,
      }),
    );
  }

  private applyMatchState(payload: MatchState): void {
    this.clockOffset.set(payload.serverTime ? payload.serverTime - Date.now() : 0);
    this.hostPauseDeadline.set(payload.hostPaused ? payload.hostPauseDeadline : null);

    const previousMatch = this.match();
    const nextRoundKey = payload.specialRound ? `${payload.roundNumber}:${payload.specialRound.minigameId}` : null;

    if (this.privateState()?.roundKey && this.privateState()?.roundKey !== nextRoundKey) {
      this.privateState.set(null);
    }

    if (previousMatch && (previousMatch.roundNumber !== payload.roundNumber || !payload.specialRound?.pinturillo)) {
      this.pinturilloFrame.set(null);
    }

    if (payload.scoreboard) {
      this.scoreboard.set(payload.scoreboard);
    } else if (payload.phase !== 'scoreboard' || previousMatch?.roundNumber !== payload.roundNumber) {
      this.scoreboard.set(null);
    }

    // Si el host recarga durante el marcador, recupera la peticion de calculo pendiente.
    if (
      payload.scoreboardRequest &&
      this.scoreboardCalculateRequest()?.roundNumber !== payload.scoreboardRequest.roundNumber
    ) {
      this.scoreboardCalculateRequest.set(payload.scoreboardRequest);
    }

    this.match.set(payload);
  }

  private emitWithResponse(eventName: string, payload: Record<string, unknown>): Promise<RoomResponse> {
    this.connect();

    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({
          ok: false,
          reason: 'Todavia no hay conexion con el servidor.',
        });
        return;
      }

      this.socket.emit(eventName, { ...payload, playerSecret: this.playerSecret }, (response: RoomResponse) => {
        if (response.ok && response.lobby) {
          this.lobby.set(response.lobby);
          this.startHeartbeat(response.lobby.code);
        }

        if (response.ok && response.match) {
          this.applyMatchState(response.match);
        }

        resolve(response);
      });
    });
  }

  private startHeartbeat(code: string): void {
    this.stopHeartbeat();
    this.sendHeartbeat(code);

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat(code);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private sendHeartbeat(code: string): void {
    this.socket?.emit('room:heartbeat', {
      code,
      playerId: this.playerId,
      playerSecret: this.playerSecret,
    });
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private getOrCreateStoredId(key: string): string {
    const savedValue = localStorage.getItem(key);

    if (savedValue) {
      return savedValue;
    }

    const value = crypto.randomUUID();
    localStorage.setItem(key, value);
    return value;
  }

  private getBannedPlayerIds(code: string): string[] {
    try {
      const parsedValue = JSON.parse(localStorage.getItem(BANNED_PLAYERS_KEY) || 'null');

      if (!parsedValue || parsedValue.lobbyId !== code) {
        return [];
      }

      return Array.isArray(parsedValue.bannedPlayers) ? parsedValue.bannedPlayers : [];
    } catch {
      return [];
    }
  }

  private banPlayer(code: string, playerId: string): void {
    const bannedPlayerIds = new Set(this.getBannedPlayerIds(code));
    bannedPlayerIds.add(playerId);
    localStorage.setItem(
      BANNED_PLAYERS_KEY,
      JSON.stringify({
        lobbyId: code,
        bannedPlayers: Array.from(bannedPlayerIds),
      }),
    );
  }

  private clearLobbyUrl(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    url.searchParams.delete('lobby');
    window.history.replaceState({}, '', url);
  }
}
