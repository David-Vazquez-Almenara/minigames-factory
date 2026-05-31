import { computed, Injectable, inject } from '@angular/core';
import {
  LobbyState,
  MathOperationPayload,
  MinigameResultPayload,
  PaintTargetPayload,
  RoomResponse,
  ScoreboardPayload,
  SocketService,
} from './socket.service';

export type MinigameId = 'math-operations' | 'paint';

export interface MinigameDefinition {
  id: MinigameId;
  title: string;
  description: string;
}

export interface MathOperation extends MathOperationPayload {
  answer: number;
}

export interface MinigameScoreboardExtras {
  minigameCorrectCount?: number;
  minigameAnsweredCount?: number;
  minigameVoteCount?: number;
}

export interface MinigameScoreResult extends MinigameResultPayload, MinigameScoreboardExtras {}

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
export class MinigamesService {
  private readonly socketService = inject(SocketService);

  readonly match = this.socketService.match;
  readonly lobby = this.socketService.lobby;
  readonly currentPlayerId = this.socketService.playerId;
  readonly isHost = computed(() => this.socketService.isCurrentPlayerHost(this.lobby()));

  // To add a new minigame: create its visual component, add its metadata here, then place shared host
  // generation/submission/score helpers in this service instead of duplicating them in the component.
  readonly minigames: MinigameDefinition[] = [
    {
      id: 'math-operations',
      title: 'Operaciones matematicas',
      description:
        'Resuelve las mismas operaciones que el resto. Cuantas mas aciertes y mas rapido termines, mas puntos podras ganar.',
    },
    {
      id: 'paint',
      title: 'A Pintar',
      description:
        'Dibuja el objeto secreto y vota despues por la obra que mas se parezca. El mas votado gana mas puntos.',
    },
  ];

  prepareMathOperationsMinigame(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.prepareMinigame(lobbyId, this.generateMathOperationsMinigame());
  }

  submitMinigameAnswers(lobbyId: string, answers: Array<{ operationId: string; answer: number }>): Promise<RoomResponse> {
    return this.socketService.submitMinigameAnswers(lobbyId, answers);
  }

  submitMinigameAnswer(lobbyId: string, operationId: string, answer: number): Promise<RoomResponse> {
    return this.socketService.submitMinigameAnswer(lobbyId, operationId, answer);
  }

  submitMinigameProgress(
    lobbyId: string,
    progress: { answeredCount: number; correctCount: number; completed: boolean; finishedAt: number | null },
  ): Promise<RoomResponse> {
    return this.socketService.submitMinigameProgress(lobbyId, progress);
  }

  preparePaintMinigame(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.preparePaintMinigame(lobbyId, this.selectRandomObject());
  }

  submitPaintDrawing(lobbyId: string, imageDataUrl: string): Promise<RoomResponse> {
    return this.socketService.submitPaintDrawing(lobbyId, imageDataUrl);
  }

  submitPaintVote(lobbyId: string, targetPlayerId: string): Promise<RoomResponse> {
    return this.socketService.submitPaintVote(lobbyId, targetPlayerId);
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
