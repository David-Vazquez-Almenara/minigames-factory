import { computed, Injectable, inject, signal } from '@angular/core';
import {
  LobbyState,
  MathOperationPayload,
  MinigameResultPayload,
  PaintSubmissionPayload,
  PaintTargetPayload,
  RoomResponse,
  ScoreboardPayload,
  SocketService,
  SpecialRoundPayload,
} from '../../../../core/services/socket.service';
import {
  MinigameInfo,
  MinigamePoints,
  MinigameProgress,
  MinigameScoreboardPresentation,
  MinigameWinner,
} from './minigame.models';
import { MINIGAME_COMPONENTS } from './minigame.registry';

export interface MathOperation extends MathOperationPayload {
  answer: number;
}

const OBJECT_SELECTION_POOL = [
  'Manzana', 'Castillo', 'Cohete', 'Guitarra', 'Zapato', 'Helado',
  'Sombrero', 'Llave', 'Barco', 'Robot', 'Dinosaurio', 'Camara',
  'Pizza', 'Bicicleta', 'Reloj', 'Montana', 'Avion', 'Lampara',
  'Corona', 'Paraguas', 'Fantasma', 'Taza', 'Balon', 'Arbol', 'Coche',
];

// IDs de minijuegos legacy que tienen lógica especial de preparación en el host.
// Cualquier ID fuera de esta lista se trata como minijuego genérico del registry.
const LEGACY_MINIGAME_IDS = new Set(['math-operations', 'paint']);

@Injectable({ providedIn: 'root' })
export class MinigameService {
  private readonly socketService = inject(SocketService);
  private readonly localPoints = signal<MinigamePoints[]>([]);

  readonly match = this.socketService.match;
  readonly lobby = this.socketService.lobby;
  readonly scoreboard = this.socketService.scoreboard;
  readonly currentPlayerId = this.socketService.playerId;
  readonly isHost = computed(() => this.socketService.isCurrentPlayerHost(this.lobby()));
  readonly currentRound = computed(() => this.match()?.specialRound || null);
  readonly phase = computed(() => {
    const matchPhase = this.match()?.phase;
    const specialRound = this.currentRound();

    if (matchPhase === 'scoreboard') return 'scoreboard';
    if (specialRound?.paintPhase === 'voting') return 'voting';
    if (specialRound?.paintPhase === 'finished') return 'finished';
    if (!specialRound?.preparedByHost) return 'preparing';

    return 'playing';
  });
  readonly currentInfo = computed<MinigameInfo | null>(() => this.buildCurrentInfo());

  // ---------------------------------------------------------------------------
  // API PÚBLICA
  // ---------------------------------------------------------------------------

  /**
   * Envía al resto de jugadores la configuración generada por el host.
   *
   * — Legacy math-operations: payload es un array de operaciones.
   * — Legacy paint:           payload tiene la forma { id, label } (PaintTargetPayload).
   * — Minijuegos del registry: no necesitan preparación especial en el servidor;
   *   el specialRound ya tiene los metadatos suficientes. Se devuelve ok:true directamente.
   */
  sendGameData(info: MinigameInfo): Promise<RoomResponse> {
    const lobbyId = this.match()?.lobbyId || this.lobby()?.code || '';

    if (!lobbyId) {
      return Promise.resolve({ ok: false, reason: 'No hay lobby activo para enviar datos del minijuego.' });
    }

    // Legacy math-operations
    if (Array.isArray(info.payload)) {
      return this.socketService.prepareMinigame(lobbyId, info.payload as MathOperationPayload[]);
    }

    // Legacy paint
    if (info.payload && typeof info.payload === 'object' && 'label' in info.payload) {
      return this.socketService.preparePaintMinigame(lobbyId, info.payload as PaintTargetPayload);
    }

    // Minijuegos genéricos del registry: marcan preparedByHost en servidor sin operations.
    return this.socketService.prepareGenericMinigame(lobbyId, info.payload);
  }

  prepareGenericMinigame(hostMinigameData?: any): Promise<RoomResponse> {
    const lobbyId = this.match()?.lobbyId || this.lobby()?.code || '';
    if (!lobbyId) {
      return Promise.resolve({ ok: false, reason: 'No hay lobby activo para preparar el minijuego.' });
    }
    return this.socketService.prepareGenericMinigame(lobbyId, hostMinigameData);
  }

  receiveGameData(): MinigameInfo | null {
    return this.currentInfo();
  }

  submitProgress(progress: MinigameProgress): Promise<RoomResponse> {
    const lobbyId = this.match()?.lobbyId || '';

    if (!lobbyId) {
      return Promise.resolve({ ok: false, reason: 'No hay lobby activo para enviar progreso.' });
    }

    return this.socketService.submitMinigameProgress(lobbyId, progress);
  }

  submitPoints(points: MinigamePoints[]): Promise<RoomResponse> {
    this.localPoints.set(points);

    const lobby = this.lobby();
    const match = this.match();

    if (!lobby || !match?.specialRound || !this.isHost()) {
      return Promise.resolve({ ok: true, lobby: lobby || undefined, match: match || undefined });
    }

    const previousScoreboard = this.getLocalScoreboardCopy(lobby.code);
    const pointMap = new Map(points.map((point) => [point.playerId, point.points]));
    const previousScores = new Map((previousScoreboard?.scores || []).map((score) => [score.playerId, score.score]));
    const lobbyOrder = new Map(lobby.players.map((player, index) => [player.id, index]));
    const scores = lobby.players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      score: (previousScores.get(player.id) || 0) + (pointMap.get(player.id) || 0),
      position: 0,
    }));

    scores.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (lobbyOrder.get(a.playerId) || 0) - (lobbyOrder.get(b.playerId) || 0);
    });

    return this.socketService.updateScoreboard(
      lobby.code,
      match.specialRound.roundNumber,
      scores.map((score, index) => ({ ...score, position: index + 1 })),
    );
  }

  sendPoints(points: MinigamePoints[]): Promise<RoomResponse> {
    return this.submitPoints(points);
  }

  receivePoints(): MinigamePoints[] {
    return this.localPoints();
  }

  clearMatchState(): void {
    this.socketService.clearMatch();
  }

  continueFromSpecialRound(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.continueFromSpecialRound(lobbyId);
  }

  /**
   * Arranca un minijuego en modo test local con jugadores mock,
   * sin necesidad de un lobby real.
   */
  startMinigame(info: MinigameInfo): void {
    const userPlayerId = this.currentPlayerId;
    const mockLobby: LobbyState = {
      code: 'TEST_ROOM',
      hostId: userPlayerId,
      settings: {
        customQuestionsEnabled: false,
        randomThemePerPlayer: false,
        randomCharacterTypePerPlayer: false,
        questionDuration: 30,
        respondQuestionTime: 5,
        rounds: 1,
        specialRounds: [1],
        minigamesOnly: true,
        themeCategories: ['Fantasia'],
        characterTypes: ['Personaje real'],
      },
      players: [
        { id: userPlayerId, name: 'Jugador (Tu)', joinedAt: new Date().toISOString(), active: true, ready: true },
        { id: 'sofia-ai', name: 'Sofia (AI)', joinedAt: new Date().toISOString(), active: true, ready: true },
        { id: 'mateo-ai', name: 'Mateo (AI)', joinedAt: new Date().toISOString(), active: true, ready: true },
      ],
      createdAt: new Date().toISOString(),
    };

    this.socketService.lobby.set(mockLobby);
    this.socketService.match.set({
      lobbyId: mockLobby.code,
      phase: 'special-round',
      assignments: [],
      readySelections: [],
      readyCount: 3,
      totalPlayers: 3,
      hostPaused: false,
      hostPauseDeadline: null,
      countdownEndsAt: 0,
      imageSelectionEndsAt: 0,
      waitingPlayerIds: [],
      questionRoundNumber: 0,
      questionSelectionEndsAt: null,
      selectedQuestions: [],
      questionOptionsByPlayer: [],
      questionHistory: [],
      customQuestionEditingPlayerIds: [],
      customQuestionDeadlineByPlayer: [],
      currentAnswer: null,
      answerEndsAt: null,
      answerResults: [],
      waitingQuestionBatchPlayerIds: [],
      scoreboard: null,
      specialRounds: [1],
      specialRound: {
        roundNumber: 1,
        minigameId: info.id,
        title: String((info.metadata as Record<string, unknown>)?.['title'] || info.id),
        description: String((info.metadata as Record<string, unknown>)?.['description'] || ''),
        durationSeconds: info.time ?? 60,
        preparedByHost: false,
        operations: info.id === 'math-operations' ? [] : undefined,
        submittedPlayerIds: [],
        paintTarget: info.id === 'paint' ? null : undefined,
        paintPhase: info.id === 'paint' ? 'preparing' : null,
        paintEndsAt: null,
        paintVoteEndsAt: null,
        paintSubmissions: [],
        paintVotes: [],
        progress: [],
        results: [],
      },
    });

    // La preparación (sendGameData) la gestiona el minigame-container,
    // igual que en una partida real. No llamarla aquí evita la doble
    // llamada a prepareGenericMinigame que dejaba preparedByHost en false.
  }

  // ---------------------------------------------------------------------------
  // PREPARACIÓN DE MINIJUEGOS
  // ---------------------------------------------------------------------------

  /**
   * Genera la configuración inicial del minijuego activo cuando el cliente es host.
   *
   * — Para minijuegos legacy (math-operations, paint) usa sus generadores específicos.
   * — Para cualquier ID registrada en MINIGAME_COMPONENTS construye automáticamente
   *   un payload genérico con los datos del specialRound. No hace falta tocar este
   *   método al añadir un nuevo minijuego al registry.
   */
  buildHostGameInfo(): MinigameInfo | null {
    const specialRound = this.currentRound();
    if (!specialRound) return null;

    const legacyGenerators: Record<string, () => unknown> = {
      'math-operations': () => this.generateMathOperationsMinigame(),
      'paint': () => this.selectRandomObject(),
    };

    const legacyGenerator = legacyGenerators[specialRound.minigameId];

    const payload = legacyGenerator
      ? legacyGenerator()
      : this.buildGenericPayload(specialRound);

    return {
      id: specialRound.minigameId,
      time: specialRound.durationSeconds ?? 60,
      payload,
      metadata: {
        title: specialRound.title,
        description: specialRound.description,
        roundNumber: specialRound.roundNumber,
        preparedByHost: specialRound.preparedByHost,
        durationSeconds: specialRound.durationSeconds,
      },
    };
  }

  /**
   * Prepara un minijuego por su ID.
   *
   * — Si es un minijuego legacy, delega a su adaptador específico.
   * — Si está registrado en MINIGAME_COMPONENTS, lo prepara automáticamente
   *   sin necesidad de un método dedicado por minijuego.
   * — Si el ID es desconocido, lo avisa en consola y resuelve ok:true.
   */
  prepareMinigameById(lobbyId: string, minigameId: string): Promise<RoomResponse> {
    if (minigameId === 'math-operations') {
      return this.prepareMathOperationsMinigame(lobbyId);
    }

    if (minigameId === 'paint') {
      return this.preparePaintMinigame(lobbyId);
    }

    if (minigameId in MINIGAME_COMPONENTS) {
      const specialRound = this.currentRound();
      const durationSeconds = specialRound?.durationSeconds ?? 60;
      return this.sendGameData({ id: minigameId, time: durationSeconds, payload: {} });
    }

    console.warn(`[MinigameService] ID de minijuego desconocido: "${minigameId}". No está registrado en MINIGAME_COMPONENTS.`);
    return Promise.resolve({ ok: true });
  }

  // ---------------------------------------------------------------------------
  // ADAPTADORES LEGACY — NO MODIFICAR sin revisar el impacto
  // ---------------------------------------------------------------------------

  prepareMathOperationsMinigame(lobbyId: string): Promise<RoomResponse> {
    return this.sendGameData({
      id: 'math-operations',
      time: 60,
      payload: this.generateMathOperationsMinigame(),
    });
  }

  preparePaintMinigame(lobbyId: string): Promise<RoomResponse> {
    return this.sendGameData({
      id: 'paint',
      time: 60,
      payload: this.selectRandomObject(),
    });
  }

  submitMinigameProgress(lobbyId: string, progress: MinigameProgress): Promise<RoomResponse> {
    return this.socketService.submitMinigameProgress(lobbyId, progress);
  }

  submitPaintDrawing(lobbyId: string, imageDataUrl: string): Promise<RoomResponse> {
    return this.socketService.submitPaintDrawing(lobbyId, imageDataUrl);
  }

  submitPaintVote(lobbyId: string, targetPlayerId: string): Promise<RoomResponse> {
    return this.socketService.submitPaintVote(lobbyId, targetPlayerId);
  }

  // ---------------------------------------------------------------------------
  // SCOREBOARD
  // ---------------------------------------------------------------------------

  calculateOfficialMinigameScoreboard(
    lobby: LobbyState,
    roundNumber: number,
    results: MinigameResultPayload[],
    previousScoreboard: ScoreboardPayload | null,
  ): ScoreboardPayload {
    const previousScores = new Map((previousScoreboard?.scores || []).map((s) => [s.playerId, s.score]));
    const lobbyOrder = new Map(lobby.players.map((p, i) => [p.id, i]));
    const bonusPoints = this.calculateMinigameBonusPoints(results);
    const resultMap = new Map(results.map((r) => [r.playerId, r]));

    const scores = lobby.players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      score: (previousScores.get(player.id) || 0) + (bonusPoints.get(player.id) || 0),
      position: 0,
      minigameCorrectCount: resultMap.get(player.id)?.correctCount || 0,
      minigameAnsweredCount: resultMap.get(player.id)?.answeredCount || 0,
      minigameVoteCount: resultMap.get(player.id)?.votesReceived,
    }));

    scores.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (lobbyOrder.get(a.playerId) || 0) - (lobbyOrder.get(b.playerId) || 0);
    });

    return {
      lobbyId: lobby.code,
      roundNumber,
      scores: scores.map((s, i) => ({ ...s, position: i + 1 })),
    };
  }

  getScoreboardPresentation(): MinigameScoreboardPresentation {
    const specialRound = this.match()?.specialRound;

    if (!specialRound || !Array.isArray(specialRound.results)) {
      return { winners: [], noWinnerMessage: '' };
    }

    const submittedResults = specialRound.results.filter(
      (r) => r.submitted || (r.answeredCount || 0) > 0,
    );

    if (!submittedResults.length) {
      return { winners: [], noWinnerMessage: '' };
    }

    const isVotingMinigame = submittedResults.some((r) => r.votesReceived !== undefined);

    if (isVotingMinigame) {
      const maxVotes = Math.max(...submittedResults.map((r) => r.votesReceived || 0));
      const submissionsByPlayer = new Map(
        (specialRound.paintSubmissions || []).map((sub: PaintSubmissionPayload) => [sub.playerId, sub]),
      );

      const winners: MinigameWinner[] = submittedResults
        .filter((r) => (r.votesReceived || 0) === maxVotes)
        .map((r) => {
          const submission = submissionsByPlayer.get(r.playerId);
          return {
            playerId: r.playerId,
            playerName: submission?.playerName || r.playerName,
            metricLabel: `${r.votesReceived || 0} votos`,
            imageDataUrl: submission?.imageDataUrl || '',
          };
        })
        .filter((w) => w.imageDataUrl);

      return { winners, noWinnerMessage: '' };
    }

    const maxCorrectCount = Math.max(...submittedResults.map((r) => r.correctCount || 0));

    if (maxCorrectCount <= 0) {
      return { winners: [], noWinnerMessage: 'Nadie ha acertado ninguna pregunta' };
    }

    const winners = submittedResults
      .filter((r) => (r.correctCount || 0) === maxCorrectCount)
      .map((r) => ({
        playerId: r.playerId,
        playerName: r.playerName,
        metricLabel: `${r.correctCount || 0} aciertos`,
      }));

    return { winners, noWinnerMessage: '' };
  }

  // ---------------------------------------------------------------------------
  // GENERADORES (math-operations y paint)
  // ---------------------------------------------------------------------------

  selectRandomObject(): PaintTargetPayload {
    const label = OBJECT_SELECTION_POOL[Math.floor(Math.random() * OBJECT_SELECTION_POOL.length)] || OBJECT_SELECTION_POOL[0];
    return { id: label.toLowerCase().replace(/\s+/g, '-'), label };
  }

  generateMathOperationsMinigame(): MathOperation[] {
    const operationCount = this.randomInt(5, 7);
    const generators = [
      () => this.generateAddition(),
      () => this.generateSubtraction(),
      () => this.generateSmallMultiplication(),
      () => this.generateSimpleDivision(),
      () => this.generateParenthesisOperation(),
    ];

    return Array.from({ length: operationCount }, (_, i) => ({
      ...generators[i % generators.length](),
      id: `math-${i + 1}-${crypto.randomUUID().slice(0, 8)}`,
    })).sort(() => Math.random() - 0.5);
  }

  // ---------------------------------------------------------------------------
  // PRIVADOS
  // ---------------------------------------------------------------------------

  /**
   * Construye el info del minijuego activo a partir del specialRound del servidor.
   * Los minijuegos legacy tienen campos propios; el resto reciben el specialRound
   * completo como payload genérico.
   */
  private buildCurrentInfo(): MinigameInfo | null {
    const specialRound = this.currentRound();
    if (!specialRound) return null;

    let payload: unknown;
    if (specialRound.minigameId === 'math-operations') {
      payload = specialRound.operations || [];
    } else if (specialRound.minigameId === 'paint') {
      payload = specialRound.paintTarget;
    } else {
      payload = this.buildGenericPayload(specialRound);
    }

    return {
      id: specialRound.minigameId,
      time: specialRound.durationSeconds ?? 60,
      payload,
      metadata: {
        title: specialRound.title,
        description: specialRound.description,
        roundNumber: specialRound.roundNumber,
        preparedByHost: specialRound.preparedByHost,
        paintPhase: specialRound.paintPhase,
        paintEndsAt: specialRound.paintEndsAt,
        paintVoteEndsAt: specialRound.paintVoteEndsAt,
        durationSeconds: specialRound.durationSeconds,
      },
    };
  }

  /**
   * Payload genérico para cualquier minijuego que no sea legacy.
   * Contiene todo lo que un componente del registry puede necesitar.
   */
  private buildGenericPayload(specialRound: SpecialRoundPayload) {
    const round = specialRound as SpecialRoundPayload & { hostMinigameData?: unknown };
    return {
      roundNumber: round.roundNumber,
      minigameId: round.minigameId,
      title: round.title,
      description: round.description,
      preparedByHost: round.preparedByHost,
      progress: round.progress ?? [],
      results: round.results ?? [],
      hostMinigameData: round.hostMinigameData ?? null,
    };
  }

  private getLocalScoreboardCopy(lobbyId: string): ScoreboardPayload | null {
    try {
      const parsed = JSON.parse(localStorage.getItem('quien-soy-online-scoreboard') || 'null') as ScoreboardPayload | null;
      if (parsed?.lobbyId !== lobbyId || !Array.isArray(parsed.scores)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private calculateMinigameBonusPoints(results: MinigameResultPayload[]): Map<string, number> {
    if (results.some((r) => r.votesReceived !== undefined)) {
      return this.calculatePaintWinnerBonusPoints(results);
    }
    return this.calculateMathOperationsBonusPoints(results);
  }

  private calculateMathOperationsBonusPoints(results: MinigameResultPayload[]): Map<string, number> {
    const points = new Map<string, number>();
    const submitted = results.filter((r) => r.submitted || (r.answeredCount || 0) > 0);

    if (!submitted.length || Math.max(...submitted.map((r) => r.correctCount || 0)) <= 0) {
      return points;
    }

    const completed = [...submitted.filter((r) => r.finishedAt)].sort((a, b) => {
      const diff = Number(a.finishedAt || 0) - Number(b.finishedAt || 0);
      return diff !== 0 ? diff : b.correctCount - a.correctCount;
    });

    const winner = completed[0];
    if (winner) points.set(winner.playerId, 30);

    const remaining = submitted
      .filter((r) => r.playerId !== winner?.playerId)
      .map((r) => ({ playerId: r.playerId, value: r.correctCount }));
    const ranked = this.calculateRankedBonusPoints(remaining, [20, 10]);
    for (const [id, pts] of ranked) points.set(id, pts);

    return points;
  }

  private calculatePaintWinnerBonusPoints(results: MinigameResultPayload[]): Map<string, number> {
    const submitted = results
      .filter((r) => r.submitted && r.votesReceived !== undefined)
      .map((r) => ({ playerId: r.playerId, value: r.votesReceived || 0 }));

    if (!submitted.length) return new Map<string, number>();

    const maxVotes = Math.max(...submitted.map((r) => r.value));
    const winners = submitted.filter((r) => r.value === maxVotes);
    const winnerPts = winners.length === 1 ? 30 : winners.length === 2 ? 15 : 10;

    return new Map(winners.map((w) => [w.playerId, winnerPts]));
  }

  private calculateRankedBonusPoints(
    results: Array<{ playerId: string; value: number }>,
    rankPoints: number[],
  ): Map<string, number> {
    const points = new Map<string, number>();
    const sorted = [...results].sort((a, b) => b.value - a.value);
    let currentIndex = 0;

    for (const rankPt of rankPoints) {
      if (currentIndex >= sorted.length) break;

      const value = sorted[currentIndex].value;
      const tied = sorted.filter((r, i) => i >= currentIndex && r.value === value);
      const perPlayer = tied.length === 1 ? rankPt : tied.length === 2 ? Math.max(5, rankPt / 2) : 5;

      for (const r of tied) points.set(r.playerId, Math.trunc(perPlayer));
      currentIndex += tied.length;
    }

    return points;
  }

  private generateAddition(): Omit<MathOperation, 'id'> {
    const a = this.randomInt(8, 40), b = this.randomInt(5, 35);
    return { prompt: `${a} + ${b}`, answer: a + b };
  }

  private generateSubtraction(): Omit<MathOperation, 'id'> {
    const a = this.randomInt(20, 70), b = this.randomInt(5, a - 2);
    return { prompt: `${a} - ${b}`, answer: a - b };
  }

  private generateSmallMultiplication(): Omit<MathOperation, 'id'> {
    const a = this.randomInt(4, 24), b = Math.random() > 0.5 ? 2 : 3;
    return { prompt: `${a} x ${b}`, answer: a * b };
  }

  private generateSimpleDivision(): Omit<MathOperation, 'id'> {
    const divisor = Math.random() > 0.5 ? 2 : 3;
    const answer = this.randomInt(3, 18);
    return { prompt: `${answer * divisor} / ${divisor}`, answer };
  }

  private generateParenthesisOperation(): Omit<MathOperation, 'id'> {
    const a = this.randomInt(2, 8), b = this.randomInt(3, 12), m = Math.random() > 0.5 ? 2 : 3;
    return { prompt: `(${a} + ${b}) x ${m}`, answer: (a + b) * m };
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}