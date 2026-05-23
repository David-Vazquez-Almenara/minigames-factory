import { computed, effect, Injectable, inject, signal } from '@angular/core';
import {
  AllImagesReadyPayload,
  LobbyState,
  MatchAssignment,
  MatchState,
  RoomResponse,
  SocketService,
} from './socket.service';

const MATCH_DATA_KEY = 'matchData';
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

  readonly match = this.socketService.match;
  readonly lobby = this.socketService.lobby;
  readonly hostPauseDeadline = this.socketService.hostPauseDeadline;
  readonly imageSelectionTimerReset = this.socketService.imageSelectionTimerReset;
  readonly waitingNextRoundMessage = this.socketService.waitingNextRoundMessage;
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
  }

  async startMatch(lobby: LobbyState): Promise<RoomResponse> {
    if (this.socketService.isCurrentPlayerHost(lobby)) {
      this.cleanOldHostMatchStorage(lobby.code);
      this.socketService.saveHostForRoom(lobby.code);
      this.socketService.prepareHostReconnectSnapshot(lobby);
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

  private cleanOldHostMatchStorage(currentLobbyId: string): void {
    localStorage.removeItem(MATCH_DATA_KEY);
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
}
