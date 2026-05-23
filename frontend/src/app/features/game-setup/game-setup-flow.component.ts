import { FormsModule } from '@angular/forms';
import { Component, OnInit, computed, effect, inject, input, output, signal } from '@angular/core';
import {
  CreateRoomSettings,
  LobbyPlayer,
  LobbyState,
  SocketService,
} from '../../core/services/socket.service';
import { MatchService } from '../../core/services/match.service';

type SetupMode = 'create' | 'join';
type FlowStep = 'name' | 'create-settings' | 'join-code' | 'lobby';

const PLAYER_NAME_KEY = 'quien-soy-online-player-name';

@Component({
  selector: 'app-game-setup-flow',
  imports: [FormsModule],
  templateUrl: './game-setup-flow.component.html',
  styleUrl: './game-setup-flow.component.scss',
})
export class GameSetupFlowComponent {
  private readonly socketService = inject(SocketService);
  private readonly matchService = inject(MatchService);

  readonly mode = input.required<SetupMode>();
  readonly initialRoomCode = input('');
  readonly autoJoinAfterName = input(false);
  readonly closed = output<void>();

  readonly step = signal<FlowStep>('name');
  readonly playerName = signal(localStorage.getItem(PLAYER_NAME_KEY) || '');
  readonly roomCode = signal('');
  readonly themeInput = signal('');
  readonly characterTypeInput = signal('');
  readonly errorMessage = signal('');
  readonly loading = signal(false);
  readonly lobby = signal<LobbyState | null>(null);
  readonly pendingKickPlayer = signal<LobbyPlayer | null>(null);
  readonly showLobbySettings = signal(false);

  readonly settings = signal<CreateRoomSettings>({
    customQuestionsEnabled: true,
    randomThemePerPlayer: true,
    randomCharacterTypePerPlayer: true,
    questionDuration: 30,
    rounds: 5,
    themeCategories: [],
    characterTypes: [],
  });

  readonly themeLimitReached = computed(
    () => !this.settings().randomThemePerPlayer && this.settings().themeCategories.length >= this.settings().rounds,
  );

  readonly characterTypeLimitReached = computed(
    () =>
      !this.settings().randomCharacterTypePerPlayer &&
      this.settings().characterTypes.length >= this.settings().rounds,
  );

  readonly themeCountInvalid = computed(() => {
    const settings = this.settings();
    return !settings.randomThemePerPlayer && settings.themeCategories.length !== settings.rounds;
  });

  readonly characterTypeCountInvalid = computed(() => {
    const settings = this.settings();
    return !settings.randomCharacterTypePerPlayer && settings.characterTypes.length !== settings.rounds;
  });

  readonly canContinueCreate = computed(
    () => !this.loading() && !this.themeCountInvalid() && !this.characterTypeCountInvalid(),
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
    if (!this.initialRoomCode()) {
      return;
    }

    this.roomCode.set(this.initialRoomCode().toUpperCase());
  }

  cancel(): void {
    this.closed.emit();
  }

  continueFromName(): void {
    const name = this.playerName().trim();

    if (!name) {
      this.errorMessage.set('Escribe un nombre de usuario para continuar.');
      return;
    }

    localStorage.setItem(PLAYER_NAME_KEY, name);
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

  updateRoomCode(value: string): void {
    this.roomCode.set(value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
  }

  updateCustomQuestions(value: boolean): void {
    this.patchSettings({ customQuestionsEnabled: value });
  }

  updateRandomTheme(value: boolean): void {
    this.patchSettings({ randomThemePerPlayer: value });
  }

  updateRandomCharacterType(value: boolean): void {
    this.patchSettings({ randomCharacterTypePerPlayer: value });
  }

  updateQuestionDuration(value: string): void {
    this.patchSettings({ questionDuration: Number(value) as 15 | 30 | 60 });
  }

  updateRounds(value: string): void {
    this.patchSettings({ rounds: Number(value) });
  }

  updateThemeInput(value: string): void {
    this.themeInput.set(value);
  }

  updateCharacterTypeInput(value: string): void {
    this.characterTypeInput.set(value);
  }

  addThemeCategory(): void {
    const category = this.themeInput().trim();

    if (!category || this.themeLimitReached()) {
      return;
    }

    this.patchSettings({ themeCategories: [...this.settings().themeCategories, category] });
    this.themeInput.set('');
  }

  removeThemeCategory(categoryIndex: number): void {
    this.patchSettings({
      themeCategories: this.settings().themeCategories.filter((_, index) => index !== categoryIndex),
    });
  }

  addCharacterType(): void {
    const characterType = this.characterTypeInput().trim();

    if (!characterType || this.characterTypeLimitReached()) {
      return;
    }

    this.patchSettings({ characterTypes: [...this.settings().characterTypes, characterType] });
    this.characterTypeInput.set('');
  }

  removeCharacterType(characterTypeIndex: number): void {
    this.patchSettings({
      characterTypes: this.settings().characterTypes.filter((_, index) => index !== characterTypeIndex),
    });
  }

  async createRoom(): Promise<void> {
    if (!this.canContinueCreate()) {
      this.errorMessage.set('Ajusta las categorias o tipos para que coincidan con las rondas.');
      return;
    }

    this.errorMessage.set('');
    this.loading.set(true);

    const response = await this.socketService.createRoom(this.playerName().trim(), this.settings());
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
    const response = await this.socketService.joinRoom(this.playerName().trim(), code);
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
    const response = await this.socketService.updateRoomSettings(lobby.code, this.settings());
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

  themeValidationMessage(): string {
    const settings = this.settings();
    return settings.themeCategories.length > settings.rounds
      ? `Necesitas ${settings.rounds} categorias. Ahora tienes ${settings.themeCategories.length}.`
      : `Necesitas ${settings.rounds} categorias.`;
  }

  characterTypeValidationMessage(): string {
    const settings = this.settings();
    return settings.characterTypes.length > settings.rounds
      ? `Necesitas ${settings.rounds} tipos. Ahora tienes ${settings.characterTypes.length}.`
      : `Necesitas ${settings.rounds} tipos.`;
  }

  private handleRoomResponse(response: { ok: boolean; reason?: string; lobby?: LobbyState }): void {
    this.loading.set(false);

    if (!response.ok || !response.lobby) {
      this.errorMessage.set(response.reason || 'No se pudo completar la accion.');
      return;
    }

    this.lobby.set(response.lobby);
    this.step.set('lobby');
    this.updateLobbyUrl(response.lobby.code);
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
