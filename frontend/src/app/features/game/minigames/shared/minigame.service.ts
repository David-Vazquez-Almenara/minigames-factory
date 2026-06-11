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
} from '../../../../core/services/socket.service';
import {
  MinigameInfo,
  MinigamePoints,
  MinigameProgress,
  MinigameScoreboardPresentation,
  MinigameWinner,
} from './minigame.models';

export interface MathOperation extends MathOperationPayload {
  answer: number;
}

const OBJECT_SELECTION_POOL = [
  'Manzana',
  'Castillo',
  'Cohete',
  'Guitarra',
  'Zapato',
  'Helado',
  'Sombrero',
  'Llave',
  'Barco',
  'Robot',
  'Dinosaurio',
  'Camara',
  'Pizza',
  'Bicicleta',
  'Reloj',
  'Montana',
  'Avion',
  'Lampara',
  'Corona',
  'Paraguas',
  'Fantasma',
  'Taza',
  'Balon',
  'Arbol',
  'Coche',
];

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

    if (matchPhase === 'scoreboard') {
      return 'scoreboard';
    }

    if (specialRound?.paintPhase === 'voting') {
      return 'voting';
    }

    if (specialRound?.paintPhase === 'finished') {
      return 'finished';
    }

    if (!specialRound?.preparedByHost) {
      return 'preparing';
    }

    return 'playing';
  });
  readonly currentInfo = computed<MinigameInfo | null>(() => this.buildCurrentInfo());

  sendGameData(info: MinigameInfo): Promise<RoomResponse> {
    const lobbyId = this.match()?.lobbyId || this.lobby()?.code || '';

    if (!lobbyId) {
      return Promise.resolve({ ok: false, reason: 'No hay lobby activo para enviar datos del minijuego.' });
    }

    if (Array.isArray(info.payload)) {
      return this.socketService.prepareMinigame(lobbyId, info.payload as MathOperationPayload[]);
    }

    if (info.payload && typeof info.payload === 'object' && 'label' in info.payload) {
      return this.socketService.preparePaintMinigame(lobbyId, info.payload as PaintTargetPayload);
    }

    return Promise.resolve({ ok: true });
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

    scores.sort((firstPlayer, secondPlayer) => {
      if (secondPlayer.score !== firstPlayer.score) {
        return secondPlayer.score - firstPlayer.score;
      }

      return (lobbyOrder.get(firstPlayer.playerId) || 0) - (lobbyOrder.get(secondPlayer.playerId) || 0);
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

    void this.sendGameData(info);
  }

  prepareMathOperationsMinigame(lobbyId: string): Promise<RoomResponse> {
    return this.sendGameData({
      id: 'math-operations',
      time: 60,
      payload: this.generateMathOperationsMinigame(),
    });
  }

  submitMinigameProgress(lobbyId: string, progress: MinigameProgress): Promise<RoomResponse> {
    return this.socketService.submitMinigameProgress(lobbyId, progress);
  }

  preparePaintMinigame(lobbyId: string): Promise<RoomResponse> {
    return this.sendGameData({
      id: 'paint',
      time: 60,
      payload: this.selectRandomObject(),
    });
  }


  preparePlantillaMinigame(lobbyId: string): Promise<RoomResponse> {
    return this.sendGameData({
      id: 'plantilla',
      time: 60,
      payload: {}
    });
  }

  submitPaintDrawing(lobbyId: string, imageDataUrl: string): Promise<RoomResponse> {
    return this.socketService.submitPaintDrawing(lobbyId, imageDataUrl);
  }

  submitPaintVote(lobbyId: string, targetPlayerId: string): Promise<RoomResponse> {
    return this.socketService.submitPaintVote(lobbyId, targetPlayerId);
  }

  buildHostGameInfo(): MinigameInfo | null {
    const specialRound = this.currentRound();

    if (!specialRound) {
      return null;
    }

    const generatorMap: Record<string, () => any> = {
      'math-operations': () => this.generateMathOperationsMinigame(),
      'paint': () => this.selectRandomObject(),
      'plantilla': () => this.preparePlantillaMinigame('lobbyId'),
    };

    const generator = generatorMap[specialRound.minigameId];
    const payload = generator ? generator() : undefined;

    return {
      id: specialRound.minigameId,
      time: 60,
      payload,
      metadata: {
        title: specialRound.title,
        description: specialRound.description,
        roundNumber: specialRound.roundNumber,
      },
    };
  }

  calculateOfficialMinigameScoreboard(
    lobby: LobbyState,
    roundNumber: number,
    results: MinigameResultPayload[],
    previousScoreboard: ScoreboardPayload | null,
  ): ScoreboardPayload {
    const previousScores = new Map((previousScoreboard?.scores || []).map((score) => [score.playerId, score.score]));
    const lobbyOrder = new Map(lobby.players.map((player, index) => [player.id, index]));
    const bonusPoints = this.calculateMinigameBonusPoints(results);
    const resultMap = new Map(results.map((result) => [result.playerId, result]));

    const scores = lobby.players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      score: (previousScores.get(player.id) || 0) + (bonusPoints.get(player.id) || 0),
      position: 0,
      minigameCorrectCount: resultMap.get(player.id)?.correctCount || 0,
      minigameAnsweredCount: resultMap.get(player.id)?.answeredCount || 0,
      minigameVoteCount: resultMap.get(player.id)?.votesReceived,
    }));

    scores.sort((firstPlayer, secondPlayer) => {
      if (secondPlayer.score !== firstPlayer.score) {
        return secondPlayer.score - firstPlayer.score;
      }

      return (lobbyOrder.get(firstPlayer.playerId) || 0) - (lobbyOrder.get(secondPlayer.playerId) || 0);
    });

    return {
      lobbyId: lobby.code,
      roundNumber,
      scores: scores.map((score, index) => ({
        ...score,
        position: index + 1,
      })),
    };
  }

  getScoreboardPresentation(): MinigameScoreboardPresentation {
    const specialRound = this.match()?.specialRound;

    if (!specialRound || !Array.isArray(specialRound.results)) {
      return { winners: [], noWinnerMessage: '' };
    }

    const submittedResults = specialRound.results.filter(
      (result) => result.submitted || (result.answeredCount || 0) > 0,
    );

    if (!submittedResults.length) {
      return { winners: [], noWinnerMessage: '' };
    }

    const isVotingMinigame = submittedResults.some(
      (result) => result.votesReceived !== undefined,
    );

    if (isVotingMinigame) {
      const maxVotes = Math.max(...submittedResults.map((result) => result.votesReceived || 0));
      const submissionsByPlayer = new Map(
        (specialRound.paintSubmissions || []).map((sub: PaintSubmissionPayload) => [sub.playerId, sub]),
      );

      const winners: MinigameWinner[] = submittedResults
        .filter((result) => (result.votesReceived || 0) === maxVotes)
        .map((result) => {
          const submission = submissionsByPlayer.get(result.playerId);

          return {
            playerId: result.playerId,
            playerName: submission?.playerName || result.playerName,
            metricLabel: `${result.votesReceived || 0} votos`,
            imageDataUrl: submission?.imageDataUrl || '',
          };
        })
        .filter((winner) => winner.imageDataUrl);

      return { winners, noWinnerMessage: '' };
    } else {
      const maxCorrectCount = Math.max(...submittedResults.map((result) => result.correctCount || 0));

      if (maxCorrectCount <= 0) {
        return { winners: [], noWinnerMessage: 'Nadie ha acertado ninguna pregunta' };
      }

      const winners = submittedResults
        .filter((result) => (result.correctCount || 0) === maxCorrectCount)
        .map((result) => ({
          playerId: result.playerId,
          playerName: result.playerName,
          metricLabel: `${result.correctCount || 0} aciertos`,
        }));

      return { winners, noWinnerMessage: '' };
    }
  }

  selectRandomObject(): PaintTargetPayload {
    const label = OBJECT_SELECTION_POOL[Math.floor(Math.random() * OBJECT_SELECTION_POOL.length)] || OBJECT_SELECTION_POOL[0];

    return {
      id: label.toLowerCase().replace(/\s+/g, '-'),
      label,
    };
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

    return Array.from({ length: operationCount }, (_unused, index) => {
      const operation = generators[index % generators.length]();
      return {
        ...operation,
        id: `math-${index + 1}-${crypto.randomUUID().slice(0, 8)}`,
      };
    }).sort(() => Math.random() - 0.5);
  }

  private buildCurrentInfo(): MinigameInfo | null {
    const specialRound = this.currentRound();

    if (!specialRound) {
      return null;
    }

    let payload: any = specialRound;
    if (specialRound.minigameId === 'math-operations') {
      payload = specialRound.operations || [];
    } else if (specialRound.minigameId === 'paint') {
      payload = specialRound.paintTarget;
    }

    return {
      id: specialRound.minigameId,
      time: 60,
      payload,
      metadata: {
        title: specialRound.title,
        description: specialRound.description,
        roundNumber: specialRound.roundNumber,
        preparedByHost: specialRound.preparedByHost,
        paintPhase: specialRound.paintPhase,
        paintEndsAt: specialRound.paintEndsAt,
        paintVoteEndsAt: specialRound.paintVoteEndsAt,
      },
    };
  }

  private getLocalScoreboardCopy(lobbyId: string): ScoreboardPayload | null {
    try {
      const parsedValue = JSON.parse(localStorage.getItem('quien-soy-online-scoreboard') || 'null') as ScoreboardPayload | null;

      if (parsedValue?.lobbyId !== lobbyId || !Array.isArray(parsedValue.scores)) {
        return null;
      }

      return parsedValue;
    } catch {
      return null;
    }
  }

  private calculateMinigameBonusPoints(results: MinigameResultPayload[]): Map<string, number> {
    if (results.some((result) => result.votesReceived !== undefined)) {
      return this.calculatePaintWinnerBonusPoints(results);
    }

    return this.calculateMathOperationsBonusPoints(results);
  }

  private calculateMathOperationsBonusPoints(results: MinigameResultPayload[]): Map<string, number> {
    const points = new Map<string, number>();
    const submittedResults = results.filter((result) => result.submitted || (result.answeredCount || 0) > 0);

    if (!submittedResults.length || Math.max(...submittedResults.map((result) => result.correctCount || 0)) <= 0) {
      return points;
    }

    const completedResults = submittedResults.filter((result) => result.finishedAt);
    completedResults.sort((firstResult, secondResult) => {
      const timeDifference = Number(firstResult.finishedAt || 0) - Number(secondResult.finishedAt || 0);

      if (timeDifference !== 0) {
        return timeDifference;
      }

      return secondResult.correctCount - firstResult.correctCount;
    });

    const winner = completedResults[0];

    if (winner) {
      points.set(winner.playerId, 30);
    }

    const remainingResults = submittedResults
      .filter((result) => result.playerId !== winner?.playerId)
      .map((result) => ({
        playerId: result.playerId,
        value: result.correctCount,
      }));
    const rankedPoints = this.calculateRankedBonusPoints(remainingResults, [20, 10]);

    for (const [playerId, pointValue] of rankedPoints) {
      points.set(playerId, pointValue);
    }

    return points;
  }

  private calculatePaintWinnerBonusPoints(results: MinigameResultPayload[]): Map<string, number> {
    const submittedResults = results
      .filter((result) => result.submitted && result.votesReceived !== undefined)
      .map((result) => ({
        playerId: result.playerId,
        value: result.votesReceived || 0,
      }));

    if (!submittedResults.length) {
      return new Map<string, number>();
    }

    const maxVotes = Math.max(...submittedResults.map((result) => result.value));
    const winners = submittedResults.filter((result) => result.value === maxVotes);
    const winnerPoints = winners.length === 1 ? 30 : winners.length === 2 ? 15 : 10;

    return new Map(winners.map((winner) => [winner.playerId, winnerPoints]));
  }

  private calculateRankedBonusPoints(results: Array<{ playerId: string; value: number }>, rankPoints: number[]): Map<string, number> {
    const points = new Map<string, number>();
    const sortedResults = [...results].sort((firstResult, secondResult) => secondResult.value - firstResult.value);
    let currentIndex = 0;

    for (const rankPoint of rankPoints) {
      if (currentIndex >= sortedResults.length) {
        break;
      }

      const value = sortedResults[currentIndex].value;
      const tiedResults = sortedResults.filter((result, index) => index >= currentIndex && result.value === value);
      const playerPoint = tiedResults.length === 1 ? rankPoint : tiedResults.length === 2 ? Math.max(5, rankPoint / 2) : 5;

      for (const result of tiedResults) {
        points.set(result.playerId, Math.trunc(playerPoint));
      }

      currentIndex += tiedResults.length;
    }

    return points;
  }

  private generateAddition(): Omit<MathOperation, 'id'> {
    const firstValue = this.randomInt(8, 40);
    const secondValue = this.randomInt(5, 35);

    return {
      prompt: `${firstValue} + ${secondValue}`,
      answer: firstValue + secondValue,
    };
  }

  private generateSubtraction(): Omit<MathOperation, 'id'> {
    const firstValue = this.randomInt(20, 70);
    const secondValue = this.randomInt(5, firstValue - 2);

    return {
      prompt: `${firstValue} - ${secondValue}`,
      answer: firstValue - secondValue,
    };
  }

  private generateSmallMultiplication(): Omit<MathOperation, 'id'> {
    const firstValue = this.randomInt(4, 24);
    const secondValue = Math.random() > 0.5 ? 2 : 3;

    return {
      prompt: `${firstValue} x ${secondValue}`,
      answer: firstValue * secondValue,
    };
  }

  private generateSimpleDivision(): Omit<MathOperation, 'id'> {
    const divisor = Math.random() > 0.5 ? 2 : 3;
    const answer = this.randomInt(3, 18);

    return {
      prompt: `${answer * divisor} / ${divisor}`,
      answer,
    };
  }

  private generateParenthesisOperation(): Omit<MathOperation, 'id'> {
    const firstValue = this.randomInt(2, 8);
    const secondValue = this.randomInt(3, 12);
    const multiplier = Math.random() > 0.5 ? 2 : 3;

    return {
      prompt: `(${firstValue} + ${secondValue}) x ${multiplier}`,
      answer: (firstValue + secondValue) * multiplier,
    };
  }

  private randomInt(minValue: number, maxValue: number): number {
    return Math.floor(Math.random() * (maxValue - minValue + 1)) + minValue;
  }
}
