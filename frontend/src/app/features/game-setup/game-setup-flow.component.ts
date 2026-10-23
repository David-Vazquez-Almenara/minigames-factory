import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Component, OnInit, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import {
  CreateRoomSettings,
  LobbyPlayer,
  LobbyState,
  SocketService,
} from '../../core/services/socket.service';
import { MatchService } from '../../core/services/match.service';
import { MusicDirectorService } from '../../core/services/music-director.service';
import { MiiStageComponent, MiiStagePlayer } from '../../shared/components/mii-stage/mii-stage.component';
import { PlayerAvatarComponent } from '../../shared/components/player-avatar/player-avatar.component';

type SetupMode = 'create' | 'join';
type FlowStep = 'name' | 'create-settings' | 'join-code' | 'lobby';

const PLAYER_NAME_KEY = 'quien-soy-online-player-name';
const PLAYER_AVATAR_KEY = 'quien-soy-online-player-avatar';
const ROUND_OPTIONS = [3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20];

@Component({
  selector: 'app-game-setup-flow',
  imports: [FormsModule, MiiStageComponent, NgTemplateOutlet, PlayerAvatarComponent],
  templateUrl: './game-setup-flow.component.html',
  styleUrl: './game-setup-flow.component.scss',
})
export class GameSetupFlowComponent implements OnInit {
  private readonly socketService = inject(SocketService);
  private readonly matchService = inject(MatchService);
  private readonly musicDirector = inject(MusicDirectorService);
  private catalogApplied = false;

  readonly mode = input.required<SetupMode>();
  readonly initialRoomCode = input('');
  readonly autoJoinAfterName = input(false);
  /** Al volver de una partida terminada se abre directamente el lobby ya existente. */
  readonly resumeLobby = input(false);
  readonly closed = output<void>();

  readonly roundOptions = ROUND_OPTIONS;
  readonly step = signal<FlowStep>('name');
  readonly playerName = signal(localStorage.getItem(PLAYER_NAME_KEY) || '');
  readonly avatarUrl = signal(localStorage.getItem(PLAYER_AVATAR_KEY) || '');
  readonly roomCode = signal('');
  readonly errorMessage = signal('');
  readonly loading = signal(false);
  readonly lobby = signal<LobbyState | null>(null);
  readonly pendingKickPlayer = signal<LobbyPlayer | null>(null);
  readonly showLobbySettings = signal(false);
  readonly minigameCatalog = this.socketService.minigameCatalog;

  readonly settings = signal<CreateRoomSettings>({
    rounds: 5,
    enabledMinigames: [],
  });

  readonly enabledMinigameCount = computed(() => this.resolvedEnabledMinigames().length);
  readonly canContinueCreate = computed(
    () => !this.loading() && (this.enabledMinigameCount() > 0 || !this.minigameCatalog().length),
  );
  readonly currentPlayerId = this.socketService.playerId;
  readonly isHost = computed(() => this.socketService.isCurrentPlayerHost(this.lobby()));
  readonly canStartGame = computed(() => {
    const lobby = this.lobby();

    if (!lobby || !this.isHost() || lobby.players.length < 2) {
      return false;
    }

    return lobby.players.filter((player) => player.id !== lobby.hostId).every((player) => player.ready);
  });
  readonly lobbyMiis = computed<MiiStagePlayer[]>(() => {
    const lobby = this.lobby();

    return (lobby?.players || []).map((player) => ({
      id: player.id,
      name: player.name,
      avatarUrl: player.avatarUrl,
      color: player.color,
      label: (player.id === lobby?.hostId ? '👑 ' : player.ready ? '✓ ' : '') + player.name + (player.id === this.currentPlayerId ? ' (tú)' : ''),
      labelTone: 'name',
    }));
  });
  readonly lockedMinigames = computed(() => {
    const playerCount = this.lobby()?.players.length || 0;
    return this.minigameCatalog().filter((minigame) => this.isMinigameEnabled(minigame.id) && minigame.minPlayers > playerCount);
  });

  readonly title = computed(() => {
    if (this.step() === 'name') {
      return this.mode() === 'create' ? 'Crear partida' : 'Unirse a partida';
    }

    if (this.step() === 'create-settings') {
      return 'Configurar partida';
    }

    if (this.step() === 'join-code') {
      return 'Codigo de sala';
    }

    return 'Lobby listo';
  });

  readonly nextLabel = computed(() => (this.mode() === 'create' ? 'Continuar' : 'Siguiente'));

  constructor() {
    effect(() => {
      const catalog = this.minigameCatalog();

      // Un lobby nuevo arranca con todos los minijuegos del catalogo activos.
      if (catalog.length && !this.catalogApplied && !this.lobby() && !untracked(this.settings).enabledMinigames.length) {
        this.catalogApplied = true;
        this.patchSettings({ enabledMinigames: catalog.map((minigame) => minigame.id) });
      }
    });

    effect(() => {
      const lobby = this.socketService.lobby();
      const currentLobby = this.lobby();

      if (!lobby || !currentLobby || lobby.code !== currentLobby.code) {
        return;
      }

      this.lobby.set(lobby);
      this.settings.set(lobby.settings);
    });

    effect(() => {
      const kickedRoomCode = this.socketService.kickedFromRoom();
      const currentLobby = this.lobby();

      if (!kickedRoomCode || !currentLobby || kickedRoomCode !== currentLobby.code) {
        return;
      }

      this.lobby.set(null);
      this.socketService.clearRoomNotices();
      this.step.set('join-code');
      this.errorMessage.set('Has sido expulsado del lobby por el host.');
    });

    effect(() => {
      const closedRoomMessage = this.socketService.closedRoomMessage();

      if (!closedRoomMessage) {
        return;
      }

      this.lobby.set(null);
      this.socketService.clearRoomNotices();
      this.closed.emit();
    });

    effect(() => {
      const match = this.socketService.match();
      const lobby = this.lobby();

      if (!match || !lobby || match.lobbyId !== lobby.code) {
        return;
      }

      this.closed.emit();
    });
  }

  ngOnInit(): void {
    const existingLobby = this.socketService.lobby();

    if (this.resumeLobby() && existingLobby) {
      this.lobby.set(existingLobby);
      this.settings.set(existingLobby.settings);
      this.step.set('lobby');
      return;
    }

    if (!this.initialRoomCode()) {
      return;
    }

    this.roomCode.set(this.initialRoomCode().toUpperCase());
  }

  cancel(): void {
    this.closed.emit();
  }

  async continueFromName(): Promise<void> {
    const name = this.playerName().trim();

    if (!name) {
      this.errorMessage.set('Escribe un nombre de usuario para continuar.');
      return;
    }

    const avatarUrl = this.avatarUrl().trim();

    if (!avatarUrl) {
      this.errorMessage.set('La foto de perfil es obligatoria: pega la URL de una imagen.');
      return;
    }

    if (!/^https?:\/\/\S+$/i.test(avatarUrl)) {
      this.errorMessage.set('La imagen debe ser una URL que empiece por http:// o https://');
      return;
    }

    this.loading.set(true);
    const loads = await this.imageLoads(avatarUrl);
    this.loading.set(false);

    if (!loads) {
      this.errorMessage.set('No se pudo cargar esa imagen. Prueba con otra URL.');
      return;
    }

    localStorage.setItem(PLAYER_NAME_KEY, name);
    localStorage.setItem(PLAYER_AVATAR_KEY, avatarUrl);
    this.errorMessage.set('');

    if (this.mode() === 'join' && this.autoJoinAfterName() && this.roomCode()) {
      void this.joinRoom();
      return;
    }

    this.step.set(this.mode() === 'create' ? 'create-settings' : 'join-code');
  }

  updatePlayerName(value: string): void {
    this.playerName.set(value);
  }

  updateAvatarUrl(value: string): void {
    this.avatarUrl.set(value);
  }

  updateRoomCode(value: string): void {
    this.roomCode.set(value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
  }

  updateRounds(value: string | number): void {
    this.patchSettings({ rounds: Number(value) });
  }

  isMinigameEnabled(minigameId: string): boolean {
    return this.resolvedEnabledMinigames().includes(minigameId);
  }

  toggleMinigame(minigameId: string, enabled: boolean): void {
    const current = this.resolvedEnabledMinigames();
    const next = enabled ? [...new Set([...current, minigameId])] : current.filter((id) => id !== minigameId);
    this.patchSettings({ enabledMinigames: next });
  }

  minigameTitle(minigameId: string): string {
    return this.minigameCatalog().find((minigame) => minigame.id === minigameId)?.title || minigameId;
  }

  async createRoom(): Promise<void> {
    if (!this.canContinueCreate()) {
      this.errorMessage.set('Activa al menos un minijuego para la ruleta.');
      return;
    }

    this.errorMessage.set('');
    this.loading.set(true);

    const response = await this.socketService.createRoom(this.playerName().trim(), this.avatarUrl().trim(), {
      ...this.settings(),
      enabledMinigames: this.resolvedEnabledMinigames(),
    });
    if (response.ok && response.lobby) {
      this.socketService.saveHostForRoom(response.lobby.code);
    }
    this.handleRoomResponse(response);
  }

  async joinRoom(): Promise<void> {
    const code = this.roomCode().trim();

    if (!code) {
      this.errorMessage.set('Introduce el codigo de sala.');
      return;
    }

    this.errorMessage.set('');
    this.loading.set(true);

    this.socketService.clearStoredHostIdentity();
    const response = await this.socketService.joinRoom(this.playerName().trim(), this.avatarUrl().trim(), code);
    this.handleRoomResponse(response);
  }

  requestKick(player: LobbyPlayer): void {
    this.pendingKickPlayer.set(player);
  }

  cancelKick(): void {
    this.pendingKickPlayer.set(null);
  }

  async confirmKick(): Promise<void> {
    const lobby = this.lobby();
    const player = this.pendingKickPlayer();

    if (!lobby || !player) {
      return;
    }

    this.loading.set(true);
    const response = await this.socketService.kickPlayer(lobby.code, player.id);
    this.loading.set(false);
    this.pendingKickPlayer.set(null);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo expulsar al jugador.');
      return;
    }

    if (response.lobby) {
      this.lobby.set(response.lobby);
    }
  }

  async toggleReady(): Promise<void> {
    const lobby = this.lobby();
    const currentPlayer = lobby?.players.find((player) => player.id === this.currentPlayerId);

    if (!lobby || !currentPlayer || this.isHost()) {
      return;
    }

    this.loading.set(true);
    const response = await this.socketService.setReady(lobby.code, !currentPlayer.ready);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo actualizar el estado listo.');
      return;
    }

    if (response.lobby) {
      this.lobby.set(response.lobby);
    }
  }

  openLobbySettings(): void {
    const lobby = this.lobby();

    if (lobby) {
      this.settings.set(lobby.settings);
    }

    this.showLobbySettings.set(true);
  }

  closeLobbySettings(): void {
    this.showLobbySettings.set(false);
  }

  closeReadonlyLobbySettings(): void {
    if (this.isHost()) {
      return;
    }

    this.closeLobbySettings();
  }

  async saveLobbySettings(): Promise<void> {
    const lobby = this.lobby();

    if (!lobby || !this.isHost() || !this.canContinueCreate()) {
      return;
    }

    this.loading.set(true);
    const response = await this.socketService.updateRoomSettings(lobby.code, {
      ...this.settings(),
      enabledMinigames: this.resolvedEnabledMinigames(),
    });
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo guardar la configuracion.');
      return;
    }

    if (response.lobby) {
      this.lobby.set(response.lobby);
    }

    this.showLobbySettings.set(false);
  }

  async leaveLobby(): Promise<void> {
    const lobby = this.lobby();

    if (!lobby) {
      this.socketService.clearLobbyNavigation();
      this.cancel();
      return;
    }

    this.socketService.clearLobbyNavigation();
    this.loading.set(true);
    await this.socketService.leaveRoom(lobby.code);
    this.loading.set(false);
    this.lobby.set(null);
    this.socketService.lobby.set(null);
    this.cancel();
  }

  async startGame(): Promise<void> {
    const lobby = this.lobby();

    if (!lobby || !this.isHost()) {
      return;
    }

    if (!this.canStartGame()) {
      this.errorMessage.set('Todos los jugadores deben estar listos antes de iniciar.');
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.startMatch(lobby);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo iniciar la partida.');
      return;
    }
  }

  currentPlayerReady(): boolean {
    return Boolean(this.lobby()?.players.find((player) => player.id === this.currentPlayerId)?.ready);
  }

  private imageLoads(url: string): Promise<boolean> {
    return new Promise((resolve) => {
      const image = new Image();
      const timer = setTimeout(() => resolve(false), 8000);
      image.referrerPolicy = 'no-referrer';
      image.onload = () => {
        clearTimeout(timer);
        resolve(image.naturalWidth > 0);
      };
      image.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      image.src = url;
    });
  }

  private resolvedEnabledMinigames(): string[] {
    return Array.isArray(this.settings().enabledMinigames) ? this.settings().enabledMinigames : [];
  }

  private handleRoomResponse(response: { ok: boolean; reason?: string; lobby?: LobbyState }): void {
    this.loading.set(false);

    if (!response.ok || !response.lobby) {
      this.errorMessage.set(response.reason || 'No se pudo completar la accion.');
      return;
    }

    this.lobby.set(response.lobby);
    this.settings.set(response.lobby.settings);
    this.step.set('lobby');
    this.updateLobbyUrl(response.lobby.code);
    // Tarea secundaria y de baja prioridad: confirmar que la musica del lobby esta sonando.
    this.musicDirector.verifyMusicSoon();
  }

  private updateLobbyUrl(code: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set('room', code);
    url.searchParams.set('lobby', 'true');
    window.history.replaceState({}, '', url);
  }

  private patchSettings(settings: Partial<CreateRoomSettings>): void {
    this.settings.update((currentSettings) => ({
      ...currentSettings,
      ...settings,
    }));
  }
}
