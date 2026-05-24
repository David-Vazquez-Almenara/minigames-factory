import { computed, effect, Injectable, inject, signal } from '@angular/core';
import {
  AllImagesReadyPayload,
  LobbyState,
  MatchAssignment,
  MathOperationPayload,
  MinigameResultPayload,
  QuestionBackupPayload,
  MatchState,
  RoomResponse,
  ScoreboardEntry,
  ScoreboardPayload,
  SocketService,
} from './socket.service';

const MATCH_DATA_KEY = 'matchData';
const QUESTION_BACKUP_KEY = 'questionRoundBackup';
const SCOREBOARD_COPY_KEY = 'quien-soy-online-scoreboard';
const HOST_RECONNECT_LOBBY_KEY = 'quien-soy-online-host-reconnect-lobby';
const HOST_RECONNECT_CONFIG_KEY = 'quien-soy-online-host-reconnect-config';
const BANNED_PLAYERS_KEY = 'quien-soy-online-banned-players';
const PLAYER_IMAGE_SELECTION_KEY = 'quien-soy-online-player-image-selection';
const IMAGE_TIMEOUT_PLAYERS_KEY = 'quien-soy-online-image-timeout-players';

interface ImageValidationResult {
  ok: boolean;
  imageUrl: string;
  error: string;
}

@Injectable({ providedIn: 'root' })
export class MatchService {
  private readonly socketService = inject(SocketService);
  private readonly savedMatchDataLobbyId = signal<string | null>(null);
  private readonly calculatedScoreboardKey = signal('');

  readonly match = this.socketService.match;
  readonly lobby = this.socketService.lobby;
  readonly hostPauseDeadline = this.socketService.hostPauseDeadline;
  readonly imageSelectionTimerReset = this.socketService.imageSelectionTimerReset;
  readonly waitingNextRoundMessage = this.socketService.waitingNextRoundMessage;
  readonly waitingQuestionBatchMessage = this.socketService.waitingQuestionBatchMessage;
  readonly scoreboard = this.socketService.scoreboard;
  readonly scoreboardCalculateRequest = this.socketService.scoreboardCalculateRequest;
  readonly currentPlayerId = this.socketService.playerId;

  readonly currentAssignment = computed<MatchAssignment | null>(() => {
    const match = this.match();
    return match?.assignments.find((assignment) => assignment.playerId === this.currentPlayerId) || null;
  });

  readonly readyCount = computed(() => this.match()?.readyCount || 0);
  readonly totalPlayers = computed(() => this.match()?.totalPlayers || 0);
  readonly hostPaused = computed(() => Boolean(this.match()?.hostPaused));
  readonly isHost = computed(() => this.socketService.isCurrentPlayerHost(this.lobby()));
  readonly unreadyImagePlayers = computed(() => {
    const lobby = this.lobby();
    const match = this.match();

    if (!lobby || !match) {
      return [];
    }

    const readyPlayerIds = new Set(match.readySelections.map((selection) => selection.playerId));
    return lobby.players.filter((player) => player.id !== lobby.hostId && !readyPlayerIds.has(player.id));
  });

  constructor() {
    effect(() => {
      const payload = this.socketService.allImagesReady();
      const lobby = this.socketService.lobby();

      if (!payload || !lobby || !this.socketService.isCurrentPlayerHost(lobby)) {
        return;
      }

      if (this.savedMatchDataLobbyId() === payload.lobbyId) {
        return;
      }

      this.saveMatchData(payload);
      this.savedMatchDataLobbyId.set(payload.lobbyId);
    });

    effect(() => {
      const payload = this.socketService.questionBackup();
      const lobby = this.socketService.lobby();

      if (!payload || !lobby || !this.socketService.isCurrentPlayerHost(lobby)) {
        return;
      }

      this.saveQuestionBackup(payload);
    });

    effect(() => {
      const request = this.socketService.scoreboardCalculateRequest();
      const lobby = this.socketService.lobby();
      const match = this.socketService.match();

      if (
        !request ||
        !lobby ||
        !match ||
        request.lobbyId !== lobby.code ||
        match.phase !== 'scoreboard' ||
        !this.socketService.isCurrentPlayerHost(lobby)
      ) {
        return;
      }

      const scoreboardKey =
        request.source === 'minigame'
          ? `${request.lobbyId}:${request.roundNumber}:minigame:${(request.results || [])
              .map((result) => `${result.playerId}-${result.correctCount}-${result.finishedAt}`)
              .join('|')}`
          : `${request.lobbyId}:${request.roundNumber}:questions:${match.answerResults
              .map((result) => `${result.ownerPlayerId}-${result.finalAnswer}`)
              .join('|')}`;

      if (scoreboardKey === this.calculatedScoreboardKey()) {
        return;
      }

      this.calculatedScoreboardKey.set(scoreboardKey);
      const scoreboard =
        request.source === 'minigame'
          ? this.calculateOfficialMinigameScoreboard(lobby, request.roundNumber, request.results || [])
          : this.calculateOfficialScoreboard(lobby, match, request.roundNumber);
      this.saveOfficialScoreboard(scoreboard);
      void this.socketService.updateScoreboard(lobby.code, request.roundNumber, scoreboard.scores);
    });

    effect(() => {
      const lobby = this.socketService.lobby();
      const match = this.socketService.match();

      if (!lobby || !match || !this.socketService.isCurrentPlayerHost(lobby)) {
        return;
      }

      this.saveSpecialRoundsReconnectConfig(lobby.code, match.specialRounds || []);
    });
  }

  async startMatch(lobby: LobbyState): Promise<RoomResponse> {
    if (this.socketService.isCurrentPlayerHost(lobby)) {
      const lobbyForSnapshot = lobby.settings.minigamesOnly
        ? {
            ...lobby,
            settings: {
              ...lobby.settings,
              specialRounds: this.buildAllMinigameRounds(lobby.settings.rounds),
            },
          }
        : lobby;

      this.cleanOldHostMatchStorage(lobby.code);
      this.socketService.saveHostForRoom(lobby.code);
      this.socketService.prepareHostReconnectSnapshot(lobbyForSnapshot);
    }

    return this.socketService.startMatch(lobby.code);
  }

  submitImageSelection(lobbyId: string, imageUrl: string): Promise<RoomResponse> {
    return this.socketService.submitImageSelection(lobbyId, imageUrl);
  }

  verifyImageSelectionReady(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.verifyImageSelectionReady(lobbyId);
  }

  notifyImageSelectionReconnect(lobbyId: string): void {
    this.socketService.notifyImageSelectionReconnect(lobbyId);
  }

  startCustomQuestionEditing(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.startCustomQuestionEditing(lobbyId);
  }

  selectQuestion(lobbyId: string, questionId: string, customQuestion = ''): Promise<RoomResponse> {
    return this.socketService.selectQuestion(lobbyId, questionId, customQuestion);
  }

  submitAnswer(lobbyId: string, answer: 'yes' | 'no'): Promise<RoomResponse> {
    return this.socketService.submitAnswer(lobbyId, answer);
  }

  continueFromScoreboard(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.continueFromScoreboard(lobbyId);
  }

  continueFromSpecialRound(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.continueFromSpecialRound(lobbyId);
  }

  prepareMinigame(lobbyId: string, operations: MathOperationPayload[]): Promise<RoomResponse> {
    return this.socketService.prepareMinigame(lobbyId, operations);
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

  saveLocalScoreboardCopy(scoreboard: ScoreboardPayload): void {
    localStorage.setItem(SCOREBOARD_COPY_KEY, JSON.stringify(scoreboard));
  }

  getLocalScoreboardCopy(lobbyId: string): ScoreboardPayload | null {
    try {
      const parsedValue = JSON.parse(localStorage.getItem(SCOREBOARD_COPY_KEY) || 'null') as ScoreboardPayload | null;

      if (parsedValue?.lobbyId !== lobbyId || !Array.isArray(parsedValue.scores)) {
        return null;
      }

      return parsedValue;
    } catch {
      return null;
    }
  }

  extendImageSelection(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.extendImageSelection(lobbyId);
  }

  async excludeUnreadyImagePlayers(lobbyId: string): Promise<RoomResponse> {
    const response = await this.socketService.excludeUnreadyImagePlayers(lobbyId);

    if (response.ok && response.excludedPlayers?.length) {
      this.saveImageTimeoutPlayers(lobbyId, response.excludedPlayers);
    }

    return response;
  }

  getSavedImageUrl(lobbyId: string): string {
    try {
      const parsedValue = JSON.parse(localStorage.getItem(PLAYER_IMAGE_SELECTION_KEY) || 'null') as {
        lobbyId?: string;
        playerId?: string;
        imageUrl?: string;
      } | null;

      if (parsedValue?.lobbyId !== lobbyId || parsedValue.playerId !== this.currentPlayerId) {
        return '';
      }

      return parsedValue.imageUrl || '';
    } catch {
      return '';
    }
  }

  savePlayerImageUrl(lobbyId: string, imageUrl: string): void {
    localStorage.setItem(
      PLAYER_IMAGE_SELECTION_KEY,
      JSON.stringify({
        lobbyId,
        playerId: this.currentPlayerId,
        imageUrl,
      }),
    );
  }

  validateImageUrl(rawUrl: string): Promise<ImageValidationResult> {
    const imageUrl = rawUrl.trim();

    if (!imageUrl) {
      return Promise.resolve({
        ok: false,
        imageUrl,
        error: 'Introduce una URL de imagen.',
      });
    }

    let parsedUrl: URL;

    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      return Promise.resolve({
        ok: false,
        imageUrl,
        error: 'La URL no tiene un formato valido.',
      });
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return Promise.resolve({
        ok: false,
        imageUrl,
        error: 'La URL debe empezar por http o https.',
      });
    }

    return new Promise((resolve) => {
      const image = new Image();

      image.onload = () => {
        resolve({ ok: true, imageUrl, error: '' });
      };

      image.onerror = () => {
        resolve({
          ok: false,
          imageUrl,
          error: 'No se pudo cargar la imagen. Prueba con otra URL.',
        });
      };

      image.src = imageUrl;
    });
  }

  clearMatchState(): void {
    this.socketService.clearMatch();
    this.savedMatchDataLobbyId.set(null);
    this.calculatedScoreboardKey.set('');
  }

  private saveMatchData(payload: AllImagesReadyPayload): void {
    localStorage.setItem(
      MATCH_DATA_KEY,
      JSON.stringify({
        lobbyId: payload.lobbyId,
        selectedImages: payload.selectedImages,
      }),
    );
  }

  private saveQuestionBackup(payload: QuestionBackupPayload): void {
    const currentBackup = this.getQuestionBackup(payload.lobbyId);
    const rounds = currentBackup.rounds.filter((round) => round.roundNumber !== payload.roundNumber);

    rounds.push({
      roundNumber: payload.roundNumber,
      questions: payload.questions,
    });

    rounds.sort((firstRound, secondRound) => firstRound.roundNumber - secondRound.roundNumber);

    localStorage.setItem(
      QUESTION_BACKUP_KEY,
      JSON.stringify({
        lobbyId: payload.lobbyId,
        rounds,
      }),
    );
  }

  private calculateOfficialScoreboard(lobby: LobbyState, match: MatchState, roundNumber: number): ScoreboardPayload {
    const previousScoreboard = this.getLocalScoreboardCopy(lobby.code);
    const previousScores = new Map((previousScoreboard?.scores || []).map((score) => [score.playerId, score.score]));
    const pointsByAnswer = {
      yes: 10,
      maybe: 5,
      no: 0,
    } satisfies Record<'yes' | 'no' | 'maybe', number>;
    const currentRoundPoints = new Map<string, number>();

    for (const result of match.answerResults) {
      currentRoundPoints.set(result.ownerPlayerId, pointsByAnswer[result.finalAnswer]);
    }

    const lobbyOrder = new Map(lobby.players.map((player, index) => [player.id, index]));
    const scores = lobby.players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      score: (previousScores.get(player.id) || 0) + (currentRoundPoints.get(player.id) || 0),
      position: 0,
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

  private calculateOfficialMinigameScoreboard(
    lobby: LobbyState,
    roundNumber: number,
    results: MinigameResultPayload[],
  ): ScoreboardPayload {
    const previousScoreboard = this.getLocalScoreboardCopy(lobby.code);
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
    const points = new Map<string, number>();
    const submittedResults = results.filter((result) => result.submitted || (result.answeredCount || 0) > 0);

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
      .sort((firstResult, secondResult) => secondResult.correctCount - firstResult.correctCount);
    const rankPoints = [20, 10];
    let currentIndex = 0;

    for (const rankPoint of rankPoints) {
      if (currentIndex >= remainingResults.length) {
        break;
      }

      const correctCount = remainingResults[currentIndex].correctCount;
      const tiedResults = remainingResults.filter((result, index) => index >= currentIndex && result.correctCount === correctCount);
      const playerPoint = tiedResults.length === 1 ? rankPoint : tiedResults.length === 2 ? Math.max(5, rankPoint / 2) : 5;

      for (const result of tiedResults) {
        points.set(result.playerId, Math.trunc(playerPoint));
      }

      currentIndex += tiedResults.length;
    }

    return points;
  }

  private saveOfficialScoreboard(scoreboard: ScoreboardPayload): void {
    localStorage.setItem(
      HOST_RECONNECT_LOBBY_KEY,
      JSON.stringify({
        lobbyId: scoreboard.lobbyId,
        players: scoreboard.scores.map((score) => ({
          playerId: score.playerId,
          score: score.score,
          position: score.position,
        })),
      }),
    );
  }

  private saveSpecialRoundsReconnectConfig(lobbyId: string, specialRounds: number[]): void {
    try {
      const currentValue = JSON.parse(localStorage.getItem(HOST_RECONNECT_CONFIG_KEY) || 'null') as
        | Record<string, unknown>
        | null;

      if (!currentValue || currentValue['lobbyId'] !== lobbyId) {
        return;
      }

      localStorage.setItem(
        HOST_RECONNECT_CONFIG_KEY,
        JSON.stringify({
          ...currentValue,
          specialRounds: currentValue['minigamesOnly']
            ? this.buildAllMinigameRounds(Number(currentValue['rounds'] || specialRounds.length - 1))
            : specialRounds,
        }),
      );
    } catch {
      // The reconnect config is only a backup; ignore malformed older snapshots.
    }
  }

  private getQuestionBackup(lobbyId: string): {
    lobbyId: string;
    rounds: Array<{
      roundNumber: number;
      questions: QuestionBackupPayload['questions'];
    }>;
  } {
    try {
      const parsedValue = JSON.parse(localStorage.getItem(QUESTION_BACKUP_KEY) || 'null') as {
        lobbyId?: string;
        rounds?: Array<{
          roundNumber: number;
          questions: QuestionBackupPayload['questions'];
        }>;
      } | null;

      if (parsedValue?.lobbyId !== lobbyId || !Array.isArray(parsedValue.rounds)) {
        return { lobbyId, rounds: [] };
      }

      return {
        lobbyId,
        rounds: parsedValue.rounds,
      };
    } catch {
      return { lobbyId, rounds: [] };
    }
  }

  private cleanOldHostMatchStorage(currentLobbyId: string): void {
    localStorage.removeItem(MATCH_DATA_KEY);
    localStorage.removeItem(QUESTION_BACKUP_KEY);
    localStorage.removeItem(SCOREBOARD_COPY_KEY);
    this.removeObjectFromOtherLobby(BANNED_PLAYERS_KEY, currentLobbyId);
    this.removeObjectFromOtherLobby(PLAYER_IMAGE_SELECTION_KEY, currentLobbyId);
    this.removeObjectFromOtherLobby(IMAGE_TIMEOUT_PLAYERS_KEY, currentLobbyId);
  }

  private saveImageTimeoutPlayers(
    lobbyId: string,
    players: Array<{ playerId: string; name: string; round: number; reason: string }>,
  ): void {
    const savedPlayers = this.getImageTimeoutPlayers(lobbyId);
    const playerMap = new Map(savedPlayers.map((player) => [player.playerId, player]));

    for (const player of players) {
      playerMap.set(player.playerId, player);
    }

    localStorage.setItem(
      IMAGE_TIMEOUT_PLAYERS_KEY,
      JSON.stringify({
        lobbyId,
        players: Array.from(playerMap.values()),
      }),
    );
  }

  private getImageTimeoutPlayers(lobbyId: string): Array<{
    playerId: string;
    name: string;
    round: number;
    reason: string;
  }> {
    try {
      const parsedValue = JSON.parse(localStorage.getItem(IMAGE_TIMEOUT_PLAYERS_KEY) || 'null') as {
        lobbyId?: string;
        players?: Array<{ playerId: string; name: string; round: number; reason: string }>;
      } | null;

      if (parsedValue?.lobbyId !== lobbyId || !Array.isArray(parsedValue.players)) {
        return [];
      }

      return parsedValue.players;
    } catch {
      return [];
    }
  }

  private removeObjectFromOtherLobby(key: string, currentLobbyId: string): void {
    try {
      const parsedValue = JSON.parse(localStorage.getItem(key) || 'null') as { lobbyId?: string } | null;

      if (parsedValue?.lobbyId && parsedValue.lobbyId !== currentLobbyId) {
        localStorage.removeItem(key);
      }
    } catch {
      localStorage.removeItem(key);
    }
  }

  private buildAllMinigameRounds(totalRounds: number): number[] {
    return Array.from({ length: Number(totalRounds || 0) + 1 }, (_unused, index) => index);
  }
}
