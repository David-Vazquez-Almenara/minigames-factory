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
  rounds: number;
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
}

export interface MatchSelection {
  playerId: string;
  targetPlayerId?: string;
  imageUrl: string;
  theme: string;
  characterType: string;
}

export interface MatchState {
  lobbyId: string;
  phase: 'lobby' | 'countdown' | 'image-selection' | 'image-selection-complete' | 'game-started';
  assignments: MatchAssignment[];
  readySelections: MatchSelection[];
  readyCount: number;
  totalPlayers: number;
  hostPaused: boolean;
  hostPauseDeadline: number | null;
  countdownEndsAt: number;
  imageSelectionEndsAt: number;
  waitingPlayerIds: string[];
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

export interface RoomResponse {
  ok: boolean;
  reason?: string;
  lobby?: LobbyState;
  match?: MatchState;
  waitingNextRound?: boolean;
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
  readonly hostPauseDeadline = signal<number | null>(null);
  readonly waitingNextRoundMessage = signal<string | null>(null);
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

    this.socket.on('match:game-started', (payload: { lobbyId: string }) => {
      this.match.update((currentMatch) =>
        currentMatch && currentMatch.lobbyId === payload.lobbyId
          ? { ...currentMatch, phase: 'game-started' }
          : currentMatch,
      );
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
  }

  clearMatch(): void {
    this.match.set(null);
    this.allImagesReady.set(null);
    this.hostPauseDeadline.set(null);
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
        randomThemePerPlayer: lobby.settings.randomThemePerPlayer,
        randomCharacterTypePerPlayer: lobby.settings.randomCharacterTypePerPlayer,
        themeCategories: lobby.settings.themeCategories,
        characterTypes: lobby.settings.characterTypes,
      }),
    );
  }

  private emitWithResponse(eventName: string, payload: unknown): Promise<RoomResponse> {
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
