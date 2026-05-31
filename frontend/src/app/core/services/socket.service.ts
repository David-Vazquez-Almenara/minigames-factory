import { Injectable, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';

interface ServerReadyPayload {
  socketId: string;
  message: string;
}

export interface CreateRoomSettings {
  customQuestionsEnabled: boolean;
  randomThemePerPlayer: boolean;
  randomCharacterTypePerPlayer: boolean;
  questionDuration: 15 | 30 | 60;
  respondQuestionTime: 5 | 10 | 15;
  rounds: number;
  specialRounds: number[];
  minigamesOnly: boolean;
  themeCategories: string[];
  characterTypes: string[];
}

export interface LobbyPlayer {
  id: string;
  name: string;
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

export interface MatchAssignment {
  playerId: string;
  targetPlayerId: string;
  targetPlayerName: string;
  theme: string;
  characterType: string;
  promptType?: 'theme' | 'characterType';
  promptLabel?: string;
}

export interface MatchSelection {
  playerId: string;
  targetPlayerId?: string;
  imageUrl: string;
  theme: string;
  characterType: string;
}

export interface QuestionOption {
  id: string;
  text: string;
  special?: boolean;
}

export interface MatchState {
  lobbyId: string;
  phase:
    | 'lobby'
    | 'countdown'
    | 'image-selection'
    | 'image-selection-complete'
    | 'question-selection'
    | 'answer-phase'
    | 'scoreboard'
    | 'special-round'
    | 'questions-complete';
  assignments: MatchAssignment[];
  readySelections: MatchSelection[];
  readyCount: number;
  totalPlayers: number;
  hostPaused: boolean;
  hostPauseDeadline: number | null;
  countdownEndsAt: number;
  imageSelectionEndsAt: number;
  waitingPlayerIds: string[];
  questionRoundNumber: number;
  questionSelectionEndsAt: number | null;
  selectedQuestions: Array<{
    playerId: string;
    questionId: string;
    question: string;
    questionType: 'normal' | 'custom' | 'auto-assigned';
  }>;
  questionOptionsByPlayer: Array<{
    playerId: string;
    options: QuestionOption[];
  }>;
  questionHistory: Array<{
    ownerPlayerId: string;
    questionId: string;
    question: string;
    questionType: 'normal' | 'custom' | 'auto-assigned';
    answer: 'yes' | 'no' | 'maybe';
    roundNumber: number;
  }>;
  customQuestionEditingPlayerIds: string[];
  customQuestionDeadlineByPlayer: Array<{
    playerId: string;
    deadline: number;
  }>;
  currentAnswer: {
    ownerPlayerId: string;
    ownerPlayerName: string;
    questionId: string;
    question: string;
    questionType?: 'normal' | 'custom' | 'auto-assigned';
    imageUrl: string;
  } | null;
  answerEndsAt: number | null;
  answerResults: Array<{
    ownerPlayerId: string;
    questionId?: string;
    selectedQuestion: string;
    questionType?: 'normal' | 'custom' | 'auto-assigned';
    finalAnswer: 'yes' | 'no' | 'maybe';
  }>;
  waitingQuestionBatchPlayerIds: string[];
  scoreboard: ScoreboardPayload | null;
  specialRounds: number[];
  specialRound: SpecialRoundPayload | null;
}

export interface SpecialRoundPayload {
  roundNumber: number;
  minigameId: string;
  title: string;
  description: string;
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
  position: number;
  minigameCorrectCount?: number;
  minigameAnsweredCount?: number;
  minigameVoteCount?: number;
}

export interface ScoreboardPayload {
  lobbyId: string;
  roundNumber: number;
  scores: ScoreboardEntry[];
}

export interface AllImagesReadyPayload {
  lobbyId: string;
  selectedImages: Array<{
    playerId: string;
    imageUrl: string;
    theme: string;
    characterType: string;
  }>;
}

export interface QuestionBackupPayload {
  lobbyId: string;
  roundNumber: number;
  questions: Array<{
    ownerPlayerId: string;
    questionId: string;
    selectedQuestion: string;
    questionType: 'normal' | 'custom' | 'auto-assigned';
    finalAnswer: 'yes' | 'no' | 'maybe' | null;
  }>;
  history?: MatchState['questionHistory'];
}

export interface RoomResponse {
  ok: boolean;
  reason?: string;
  lobby?: LobbyState;
  match?: MatchState;
  waitingNextRound?: boolean;
  waitingQuestionBatch?: boolean;
  excludedPlayers?: Array<{
    playerId: string;
    name: string;
    round: number;
    reason: string;
  }>;
  unreadyPlayers?: Array<{
    playerId: string;
    name: string;
    round: number;
    reason: string;
  }>;
}

const PLAYER_ID_KEY = 'quien-soy-online-player-id';
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
  readonly lobby = signal<LobbyState | null>(null);
  readonly match = signal<MatchState | null>(null);
  readonly allImagesReady = signal<AllImagesReadyPayload | null>(null);
  readonly imageSelectionTimerReset = signal<number | null>(null);
  readonly questionBackup = signal<QuestionBackupPayload | null>(null);
  readonly scoreboard = signal<ScoreboardPayload | null>(null);
  readonly scoreboardCalculateRequest = signal<{
    lobbyId: string;
    roundNumber: number;
    source?: 'questions' | 'minigame';
    results?: MinigameResultPayload[];
  } | null>(null);
  readonly hostPauseDeadline = signal<number | null>(null);
  readonly waitingNextRoundMessage = signal<string | null>(null);
  readonly waitingQuestionBatchMessage = signal<string | null>(null);
  readonly kickedFromRoom = signal<string | null>(null);
  readonly closedRoomMessage = signal<string | null>(null);
  readonly playerId = this.getOrCreatePlayerId();

  connect(): void {
    if (this.socket) {
      return;
    }

    this.socket = io(environment.socketUrl, {
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      this.connected.set(true);
      const activeMatch = this.match();

      if (activeMatch && activeMatch.phase === 'image-selection') {
        this.notifyImageSelectionReconnect(activeMatch.lobbyId);
      }
    });

    this.socket.on('disconnect', () => {
      this.connected.set(false);
    });

    this.socket.on('server:ready', (payload: ServerReadyPayload) => {
      this.serverMessage.set(payload.message);
    });

    this.socket.on('room:lobby-updated', (payload: LobbyState) => {
      this.lobby.set(payload);
      this.startHeartbeat(payload.code);
    });

    this.socket.on('room:kicked', (payload: { code: string }) => {
      this.stopHeartbeat();
      this.lobby.set(null);
      this.match.set(null);
      this.kickedFromRoom.set(payload.code);
    });

    this.socket.on('room:closed', (payload: { code: string; reason: string }) => {
      this.stopHeartbeat();
      this.lobby.set(null);
      this.match.set(null);
      this.hostPauseDeadline.set(null);
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
      this.match.set(payload);
      this.hostPauseDeadline.set(payload.hostPauseDeadline);
      this.startHeartbeat(payload.lobbyId);
    });

    this.socket.on(
      'match:image-selection-updated',
      (payload: {
        lobbyId: string;
        readyPlayerIds: string[];
        readyCount: number;
        totalPlayers: number;
        imageSelectionEndsAt: number;
      }) => {
        this.match.update((currentMatch) => {
          if (!currentMatch || currentMatch.lobbyId !== payload.lobbyId) {
            return currentMatch;
          }

          const readySelectionMap = new Map(
            currentMatch.readySelections.map((selection) => [selection.playerId, selection]),
          );

          return {
            ...currentMatch,
            phase: 'image-selection',
            readySelections: payload.readyPlayerIds.map(
              (playerId) =>
                readySelectionMap.get(playerId) || {
                  playerId,
                  imageUrl: '',
                  theme: '',
                  characterType: '',
                },
            ),
            readyCount: payload.readyCount,
            totalPlayers: payload.totalPlayers,
            imageSelectionEndsAt: payload.imageSelectionEndsAt,
          };
        });
      },
    );

    this.socket.on('match:all-images-ready', (payload: AllImagesReadyPayload) => {
      this.allImagesReady.set(payload);
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'image-selection-complete', readyCount: payload.selectedImages.length }
          : currentMatch,
      );
    });

    this.socket.on('match:question-state', (payload: MatchState) => {
      this.match.set(payload);
      if (payload.scoreboard) {
        this.scoreboard.set(payload.scoreboard);
      }
    });

    this.socket.on(
      'match:scoreboard-calculate',
      (payload: {
        lobbyId: string;
        roundNumber: number;
        source?: 'questions' | 'minigame';
        results?: MinigameResultPayload[];
      }) => {
      this.scoreboardCalculateRequest.set(payload);
      },
    );

    this.socket.on('match:scoreboard-sync', (payload: { lobbyId: string; scoreboard: ScoreboardPayload | null }) => {
      this.scoreboard.set(payload.scoreboard);
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'scoreboard', scoreboard: payload.scoreboard }
          : currentMatch,
      );
    });

    this.socket.on('match:questions-complete', (payload: { lobbyId: string; roundNumber: number }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'questions-complete' }
          : currentMatch,
      );
    });

    this.socket.on('match:special-round-started', (payload: { lobbyId: string; specialRound: SpecialRoundPayload }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'special-round', specialRound: payload.specialRound }
          : currentMatch,
      );
    });

    this.socket.on('match:minigame-prepared', (payload: { lobbyId: string; specialRound: SpecialRoundPayload }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'special-round', specialRound: payload.specialRound }
          : currentMatch,
      );
    });

    this.socket.on('match:paint-prepared', (payload: { lobbyId: string; specialRound: SpecialRoundPayload }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'special-round', specialRound: payload.specialRound }
          : currentMatch,
      );
    });

    this.socket.on('match:paint-submission-updated', (payload: { lobbyId: string; specialRound: SpecialRoundPayload }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'special-round', specialRound: payload.specialRound }
          : currentMatch,
      );
    });

    this.socket.on('match:paint-voting-started', (payload: { lobbyId: string; specialRound: SpecialRoundPayload }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'special-round', specialRound: payload.specialRound }
          : currentMatch,
      );
    });

    this.socket.on('match:paint-results-ready', (payload: { lobbyId: string; specialRound: SpecialRoundPayload }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, specialRound: payload.specialRound }
          : currentMatch,
      );
    });

    this.socket.on(
      'match:minigame-submission-updated',
      (payload: { lobbyId: string; submittedPlayerIds: string[]; totalPlayers: number }) => {
        this.match.update((currentMatch) =>
          currentMatch && currentMatch.lobbyId === payload.lobbyId && currentMatch.specialRound
            ? {
                ...currentMatch,
                totalPlayers: payload.totalPlayers,
                specialRound: {
                  ...currentMatch.specialRound,
                  submittedPlayerIds: payload.submittedPlayerIds,
                },
              }
            : currentMatch,
        );
      },
    );

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

    this.socket.on(
      'match:answer-result',
      (payload: {
        lobbyId: string;
        result: {
          ownerPlayerId: string;
          questionId?: string;
          selectedQuestion: string;
          finalAnswer: 'yes' | 'no' | 'maybe';
        };
      }) => {
        this.match.update((currentMatch) => {
          if (!currentMatch || currentMatch.lobbyId !== payload.lobbyId) {
            return currentMatch;
          }

          const previousResults = currentMatch.answerResults.filter(
            (result) => result.ownerPlayerId !== payload.result.ownerPlayerId,
          );

          return {
            ...currentMatch,
            answerResults: [...previousResults, payload.result],
          };
        });
      },
    );

    this.socket.on('match:waiting-next-question-batch', (payload: { lobbyId: string; reason: string }) => {
      this.waitingQuestionBatchMessage.set(payload.reason || 'Espera a la siguiente tanda de preguntas.');
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? {
              ...currentMatch,
              waitingQuestionBatchPlayerIds: [
                ...new Set([...currentMatch.waitingQuestionBatchPlayerIds, this.playerId]),
              ],
            }
          : currentMatch,
      );
    });

    this.socket.on('match:question-backup-updated', (payload: QuestionBackupPayload) => {
      this.questionBackup.set(payload);
    });

    this.socket.on('match:host-paused', (payload: { lobbyId: string; deadline: number }) => {
      this.hostPauseDeadline.set(payload.deadline);
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, hostPaused: true, hostPauseDeadline: payload.deadline }
          : currentMatch,
      );
    });

    this.socket.on('match:host-resumed', (payload: { lobbyId: string; imageSelectionEndsAt?: number }) => {
      this.hostPauseDeadline.set(null);
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? {
              ...currentMatch,
              hostPaused: false,
              hostPauseDeadline: null,
              imageSelectionEndsAt: payload.imageSelectionEndsAt || currentMatch.imageSelectionEndsAt,
            }
          : currentMatch,
      );
    });

    this.socket.on('match:timer-reset', (payload: { lobbyId: string; imageSelectionEndsAt: number }) => {
      this.imageSelectionTimerReset.set(payload.imageSelectionEndsAt);
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, imageSelectionEndsAt: payload.imageSelectionEndsAt }
          : currentMatch,
      );
    });

    this.socket.on('match:waiting-next-round', (payload: { lobbyId: string; reason: string }) => {
      this.waitingNextRoundMessage.set(payload.reason || 'Espera a la siguiente ronda.');
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, waitingPlayerIds: [...new Set([...currentMatch.waitingPlayerIds, this.playerId])] }
          : currentMatch,
      );
    });

    this.socket.on('match:confirm-image-ready', (payload: { lobbyId: string; playerId: string }, callback) => {
      if (payload.playerId !== this.playerId) {
        callback?.({ ok: false, ready: false });
        return;
      }

      const match = this.match();
      const ready = Boolean(
        match &&
          match.lobbyId === payload.lobbyId &&
          !match.waitingPlayerIds.includes(this.playerId) &&
          match.readySelections.some((selection) => selection.playerId === this.playerId),
      );

      callback?.({ ok: true, ready });
    });

    this.socket.on('match:closed', (payload: { lobbyId: string; reason: string }) => {
      this.match.set(null);
      this.hostPauseDeadline.set(null);
      this.closedRoomMessage.set(payload.reason || 'La partida se ha cerrado.');
      this.clearLobbyUrl();
    });
  }

  createRoom(playerName: string, settings: CreateRoomSettings): Promise<RoomResponse> {
    return this.emitWithResponse('room:create', { playerId: this.playerId, playerName, settings });
  }

  joinRoom(playerName: string, code: string): Promise<RoomResponse> {
    return this.emitWithResponse('room:join', { playerId: this.playerId, playerName, code });
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

  submitImageSelection(code: string, imageUrl: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:image-selection-ready', {
      code,
      imageUrl,
      playerId: this.playerId,
    });
  }

  extendImageSelection(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:extend-image-selection', {
      code,
      hostId: this.playerId,
    });
  }

  excludeUnreadyImagePlayers(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:exclude-unready-players', {
      code,
      hostId: this.playerId,
    });
  }

  verifyImageSelectionReady(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:verify-image-selection-ready', {
      code,
      hostId: this.playerId,
    });
  }

  notifyImageSelectionReconnect(code: string): void {
    this.connect();
    this.socket?.emit('match:player-reconnected-selection', {
      code,
      playerId: this.playerId,
    });
  }

  startCustomQuestionEditing(code: string): Promise<RoomResponse> {
    return this.emitWithResponse('match:player-custom-question-editing', {
      code,
      playerId: this.playerId,
      extraTime: 30,
    });
  }

  selectQuestion(code: string, questionId: string, customQuestion = ''): Promise<RoomResponse> {
    return this.emitWithResponse('match:select-question', {
      code,
      questionId,
      customQuestion,
      playerId: this.playerId,
    });
  }

  submitAnswer(code: string, answer: 'yes' | 'no'): Promise<RoomResponse> {
    return this.emitWithResponse('match:submit-answer', {
      code,
      answer,
      playerId: this.playerId,
    });
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

  prepareMinigame(code: string, operations: MathOperationPayload[]): Promise<RoomResponse> {
    return this.emitWithResponse('match:minigame-prepared', {
      code,
      operations,
      hostId: this.playerId,
    });
  }

  submitMinigameAnswers(code: string, answers: Array<{ operationId: string; answer: number }>): Promise<RoomResponse> {
    return this.emitWithResponse('match:minigame-submit', {
      code,
      answers,
      playerId: this.playerId,
    });
  }

  submitMinigameAnswer(code: string, operationId: string, answer: number): Promise<RoomResponse> {
    return this.emitWithResponse('match:minigame-answer', {
      code,
      operationId,
      answer,
      playerId: this.playerId,
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
    this.allImagesReady.set(null);
    this.waitingNextRoundMessage.set(null);
    this.waitingQuestionBatchMessage.set(null);
    this.questionBackup.set(null);
    this.scoreboardCalculateRequest.set(null);
  }

  clearMatch(): void {
    this.match.set(null);
    this.allImagesReady.set(null);
    this.hostPauseDeadline.set(null);
    this.waitingNextRoundMessage.set(null);
    this.waitingQuestionBatchMessage.set(null);
    this.questionBackup.set(null);
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
        customQuestionsEnabled: lobby.settings.customQuestionsEnabled,
        questionTime: lobby.settings.questionDuration,
        rounds: lobby.settings.rounds,
        specialRounds: lobby.settings.specialRounds || [],
        minigamesOnly: Boolean(lobby.settings.minigamesOnly),
        randomThemePerPlayer: lobby.settings.randomThemePerPlayer,
        randomCharacterTypePerPlayer: lobby.settings.randomCharacterTypePerPlayer,
        respondQuestionTime: lobby.settings.respondQuestionTime,
        themeCategories: lobby.settings.themeCategories,
        characterTypes: lobby.settings.characterTypes,
      }),
    );
  }

  private emitWithResponse(eventName: string, payload: unknown): Promise<RoomResponse> {
    const rawPayload = payload as any;
    const roomCode = rawPayload?.code || rawPayload?.lobbyId;

    if (roomCode === 'TEST_ROOM') {
      return this.handleTestRoomEmit(eventName, rawPayload);
    }

    this.connect();

    return new Promise((resolve) => {
      if (!this.socket?.connected) {
        resolve({
          ok: false,
          reason: 'Todavia no hay conexion con el servidor.',
        });
        return;
      }

      this.socket.emit(eventName, payload, (response: RoomResponse) => {
        if (response.ok && response.lobby) {
          this.lobby.set(response.lobby);
          this.startHeartbeat(response.lobby.code);
        }

        if (response.ok && response.match) {
          this.match.set(response.match);
        }

        if (response.ok && response.waitingNextRound) {
          this.waitingNextRoundMessage.set('No seleccionaste imagen a tiempo. Espera a la siguiente ronda.');
        }

        if (response.ok && response.waitingQuestionBatch) {
          this.waitingQuestionBatchMessage.set('Espera a la siguiente tanda de preguntas.');
        }

        resolve(response);
      });
    });
  }

  private handleTestRoomEmit(eventName: string, payload: any): Promise<RoomResponse> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const match = this.match();
        const lobby = this.lobby();
        if (!match || !lobby) {
          resolve({ ok: false, reason: 'No hay partida de test activa.' });
          return;
        }

        const userPlayerId = this.playerId;
        const specialRound = match.specialRound;

        if (eventName === 'room:leave' || eventName === 'match:special-round-continue' || eventName === 'match:scoreboard-continue') {
          this.clearMatch();
          this.lobby.set(null);
          resolve({ ok: true });
          return;
        }

        if (eventName === 'match:paint-prepared') {
          const target = payload.paintTarget;
          
          const sofiaDrawing = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" style="background:%23fff0f5"><circle cx="200" cy="200" r="80" fill="%23ff6b6b"/><text x="200" y="210" font-family="sans-serif" font-size="20" font-weight="bold" text-anchor="middle" fill="white">Sofia (AI)</text></svg>`;
          const mateoDrawing = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" style="background:%23e6f7ff"><rect x="100" y="100" width="200" height="200" fill="%231890ff" rx="20"/><text x="200" y="210" font-family="sans-serif" font-size="20" font-weight="bold" text-anchor="middle" fill="white">Mateo (AI)</text></svg>`;

          const mockSubmissions = [
            { playerId: 'sofia-ai', playerName: 'Sofia (AI)', imageDataUrl: sofiaDrawing, submittedAt: Date.now() },
            { playerId: 'mateo-ai', playerName: 'Mateo (AI)', imageDataUrl: mateoDrawing, submittedAt: Date.now() }
          ];

          const updatedSpecialRound = {
            ...specialRound!,
            preparedByHost: true,
            paintTarget: target,
            paintPhase: 'drawing' as const,
            paintEndsAt: Date.now() + 60000,
            paintVoteEndsAt: null,
            paintSubmissions: mockSubmissions,
            paintVotes: [],
            results: []
          };

          const updatedMatch = {
            ...match,
            specialRound: updatedSpecialRound
          };

          this.match.set(updatedMatch);
          resolve({ ok: true, lobby, match: updatedMatch });
          return;
        }

        if (eventName === 'match:paint-submit') {
          const userDrawing = payload.imageDataUrl;
          
          const newSubmission = {
            playerId: userPlayerId,
            playerName: 'Jugador (Tú)',
            imageDataUrl: userDrawing,
            submittedAt: Date.now()
          };

          const existingSubmissions = specialRound?.paintSubmissions || [];
          const updatedSubmissions = [...existingSubmissions, newSubmission];

          const updatedSpecialRound = {
            ...specialRound!,
            paintPhase: 'voting' as const,
            paintVoteEndsAt: Date.now() + 30000,
            paintSubmissions: updatedSubmissions
          };

          const updatedMatch = {
            ...match,
            specialRound: updatedSpecialRound
          };

          this.match.set(updatedMatch);
          resolve({ ok: true, lobby, match: updatedMatch });
          return;
        }

        if (eventName === 'match:paint-vote') {
          const targetPlayerId = payload.targetPlayerId;

          const mockVotes = [
            { voterPlayerId: userPlayerId, targetPlayerId },
            { voterPlayerId: 'sofia-ai', targetPlayerId: userPlayerId },
            { voterPlayerId: 'mateo-ai', targetPlayerId: 'sofia-ai' }
          ];

          const voteCounts = new Map<string, number>();
          voteCounts.set(userPlayerId, 0);
          voteCounts.set('sofia-ai', 0);
          voteCounts.set('mateo-ai', 0);

          for (const vote of mockVotes) {
            const currentCount = voteCounts.get(vote.targetPlayerId) || 0;
            voteCounts.set(vote.targetPlayerId, currentCount + 1);
          }

          const results = [
            { playerId: userPlayerId, playerName: 'Jugador (Tú)', correctCount: 0, votesReceived: voteCounts.get(userPlayerId) || 0, finishedAt: null, submitted: true },
            { playerId: 'sofia-ai', playerName: 'Sofia (AI)', correctCount: 0, votesReceived: voteCounts.get('sofia-ai') || 0, finishedAt: null, submitted: true },
            { playerId: 'mateo-ai', playerName: 'Mateo (AI)', correctCount: 0, votesReceived: voteCounts.get('mateo-ai') || 0, finishedAt: null, submitted: true }
          ];

          const updatedSpecialRound = {
            ...specialRound!,
            paintPhase: 'finished' as const,
            paintVotes: mockVotes,
            results: results
          };
          
          const scores = [
            { playerId: userPlayerId, playerName: 'Jugador (Tú)', score: 30, position: 1, minigameCorrectCount: 0, minigameAnsweredCount: 0, minigameVoteCount: voteCounts.get(userPlayerId) || 0 },
            { playerId: 'sofia-ai', playerName: 'Sofia (AI)', score: 30, position: 1, minigameCorrectCount: 0, minigameAnsweredCount: 0, minigameVoteCount: voteCounts.get('sofia-ai') || 0 },
            { playerId: 'mateo-ai', playerName: 'Mateo (AI)', score: 0, position: 3, minigameCorrectCount: 0, minigameAnsweredCount: 0, minigameVoteCount: voteCounts.get('mateo-ai') || 0 }
          ];

          const scoreboard = {
            lobbyId: 'TEST_ROOM',
            roundNumber: 1,
            scores: scores.sort((a, b) => b.score - a.score)
          };

          const updatedMatch = {
            ...match,
            phase: 'scoreboard' as const,
            scoreboardSource: 'minigame' as any,
            specialRound: updatedSpecialRound,
            scoreboard: scoreboard
          };

          this.scoreboard.set(scoreboard);
          this.match.set(updatedMatch);
          resolve({ ok: true, lobby, match: updatedMatch });
          return;
        }

        if (eventName === 'match:minigame-prepared') {
          const operations = payload.operations;

          const updatedSpecialRound = {
            ...specialRound!,
            preparedByHost: true,
            operations,
            submissions: [],
            progress: [],
            results: []
          };

          const updatedMatch = {
            ...match,
            specialRound: updatedSpecialRound
          };

          this.match.set(updatedMatch);
          resolve({ ok: true, lobby, match: updatedMatch });
          return;
        }

        if (eventName === 'match:minigame-answer') {
          const progress = {
            playerId: userPlayerId,
            playerName: 'Jugador (Tú)',
            correctCount: payload.correctCount || 0,
            answeredCount: payload.answeredCount || 0,
            completed: Boolean(payload.completed),
            finishedAt: payload.finishedAt || null
          };

          const currentProgressList = specialRound?.progress || [];
          const otherProgressList = currentProgressList.filter(p => p.playerId !== userPlayerId);
          const updatedProgressList = [...otherProgressList, progress];

          if (progress.completed) {
            const sofiaProgress = {
              playerId: 'sofia-ai',
              playerName: 'Sofia (AI)',
              correctCount: 5,
              answeredCount: 5,
              completed: true,
              finishedAt: Date.now() + 12000
            };
            const mateoProgress = {
              playerId: 'mateo-ai',
              playerName: 'Mateo (AI)',
              correctCount: 4,
              answeredCount: 5,
              completed: true,
              finishedAt: Date.now() + 15000
            };

            const finalProgressList = [...updatedProgressList, sofiaProgress, mateoProgress];

            const results = finalProgressList.map(p => ({
              playerId: p.playerId,
              playerName: p.playerName,
              correctCount: p.correctCount,
              answeredCount: p.answeredCount,
              finishedAt: p.finishedAt,
              submitted: true
            }));

            const sortedResults = [...results].sort((a, b) => {
              if (b.correctCount !== a.correctCount) {
                return b.correctCount - a.correctCount;
              }
              return (a.finishedAt || 0) - (b.finishedAt || 0);
            });

            const pointsMap = new Map<string, number>();
            if (sortedResults[0]) pointsMap.set(sortedResults[0].playerId, 30);
            if (sortedResults[1]) pointsMap.set(sortedResults[1].playerId, 20);
            if (sortedResults[2]) pointsMap.set(sortedResults[2].playerId, 10);

            const scores = results.map((r, index) => ({
              playerId: r.playerId,
              playerName: r.playerName,
              score: pointsMap.get(r.playerId) || 0,
              position: 0,
              minigameCorrectCount: r.correctCount,
              minigameAnsweredCount: r.answeredCount,
              minigameVoteCount: undefined
            }));

            scores.sort((a, b) => b.score - a.score);
            scores.forEach((s, idx) => {
              s.position = idx + 1;
            });

            const scoreboard = {
              lobbyId: 'TEST_ROOM',
              roundNumber: 1,
              scores
            };

            const updatedSpecialRound = {
              ...specialRound!,
              progress: finalProgressList,
              results
            };

            const updatedMatch = {
              ...match,
              phase: 'scoreboard' as const,
              scoreboardSource: 'minigame' as any,
              specialRound: updatedSpecialRound,
              scoreboard
            };

            this.scoreboard.set(scoreboard);
            this.match.set(updatedMatch);
            resolve({ ok: true, lobby, match: updatedMatch });
            return;
          } else {
            const updatedSpecialRound = {
              ...specialRound!,
              progress: updatedProgressList
            };

            const updatedMatch = {
              ...match,
              specialRound: updatedSpecialRound
            };

            this.match.set(updatedMatch);
            resolve({ ok: true, lobby, match: updatedMatch });
            return;
          }
        }

        resolve({ ok: true });
      }, 50);
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
    });
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private getOrCreatePlayerId(): string {
    const savedPlayerId = localStorage.getItem(PLAYER_ID_KEY);

    if (savedPlayerId) {
      return savedPlayerId;
    }

    const playerId = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, playerId);
    return playerId;
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
