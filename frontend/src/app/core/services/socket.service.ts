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

export interface RoomResponse {
  ok: boolean;
  reason?: string;
  lobby?: LobbyState;
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
      this.kickedFromRoom.set(payload.code);
    });

    this.socket.on('room:closed', (payload: { code: string; reason: string }) => {
      this.stopHeartbeat();
      this.lobby.set(null);
      this.closedRoomMessage.set(payload.reason || 'El lobby se ha cerrado.');
      this.clearLobbyUrl();
    });

    this.socket.on('room:presence-check', (payload: { code: string; playerId: string }) => {
      if (payload.playerId !== this.playerId) {
        return;
      }

      const params = new URLSearchParams(window.location.search);

      this.socket?.emit('room:presence-response', {
        code: payload.code,
        playerId: this.playerId,
        currentUrl: window.location.href,
        inLobby: params.get('room') === payload.code && params.get('lobby') === 'true',
      });
    });

    this.socket.on('room:get-banned-players', (_payload: { code: string }, callback) => {
      callback({
        ok: true,
        bannedPlayerIds: this.getBannedPlayerIds(_payload.code),
      });
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
    localStorage.setItem(HOST_ROOM_KEY, code);
    localStorage.setItem(HOST_ID_KEY, this.playerId);
  }

  hasHostIdentityForRoom(code: string): boolean {
    return localStorage.getItem(HOST_ROOM_KEY) === code && localStorage.getItem(HOST_ID_KEY) === this.playerId;
  }

  clearRoomNotices(): void {
    this.kickedFromRoom.set(null);
    this.closedRoomMessage.set(null);
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
