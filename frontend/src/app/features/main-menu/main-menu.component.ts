import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { BackendWakeService } from '../../core/services/backend-wake.service';
import { ConfigService } from '../../core/services/config.service';
import { SocketService } from '../../core/services/socket.service';
import { BackendWakeOverlayComponent } from '../../shared/components/backend-wake-overlay/backend-wake-overlay.component';
import { GameScreenComponent } from '../game/game-screen/game-screen.component';
import { GameSetupFlowComponent } from '../game-setup/game-setup-flow.component';
import { SettingsModalComponent } from '../settings/settings-modal.component';

@Component({
  selector: 'app-main-menu',
  imports: [BackendWakeOverlayComponent, GameScreenComponent, GameSetupFlowComponent, SettingsModalComponent],
  templateUrl: './main-menu.component.html',
  styleUrl: './main-menu.component.scss',
})
export class MainMenuComponent implements OnInit {
  private readonly backendWakeService = inject(BackendWakeService);
  private readonly configService = inject(ConfigService);
  private readonly socketService = inject(SocketService);

  readonly config = computed(() => this.configService.config());
  readonly backendStatus = this.backendWakeService.status;
  readonly backendSleeping = this.backendWakeService.sleeping;
  readonly socketConnected = this.socketService.connected;
  readonly serverMessage = this.socketService.serverMessage;
  readonly match = this.socketService.match;
  readonly showSettings = signal(false);
  readonly setupMode = signal<'create' | 'join' | null>(null);
  readonly setupRoomCode = signal('');
  readonly setupAutoJoin = signal(false);
  readonly setupResumeLobby = signal(false);

  readonly youtubeUrl = 'https://www.youtube.com/@DVaz-Dev';
  readonly githubUrl = 'https://github.com/David-Vazquez-Almenara';

  constructor() {
    effect(() => {
      if (this.backendWakeService.online()) {
        this.socketService.connect();
      }
    });

    // Al terminar una partida el host devuelve a todos al lobby de la misma sala.
    effect(() => {
      if (!this.socketService.returnedToLobby()) {
        return;
      }

      this.socketService.returnedToLobby.set(null);
      this.setupRoomCode.set('');
      this.setupAutoJoin.set(false);
      this.setupResumeLobby.set(true);
      this.setupMode.set('join');
    });
  }

  ngOnInit(): void {
    this.backendWakeService.startMonitoring();
    this.openLobbyFromUrl();
  }

  createRoom(): void {
    this.socketService.clearRoomNotices();
    this.setupRoomCode.set('');
    this.setupAutoJoin.set(false);
    this.setupMode.set('create');
  }

  joinRoom(): void {
    this.socketService.clearRoomNotices();
    this.setupRoomCode.set('');
    this.setupAutoJoin.set(false);
    this.setupMode.set('join');
  }

  openSettings(): void {
    this.showSettings.set(true);
  }

  closeSettings(): void {
    this.showSettings.set(false);
  }

  closeSetup(): void {
    this.setupMode.set(null);
    this.setupResumeLobby.set(false);
    this.setupRoomCode.set('');
    this.setupAutoJoin.set(false);
  }

  openSocial(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  private openLobbyFromUrl(): void {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    const inLobby = params.get('lobby') === 'true';

    if (!roomCode || !inLobby) {
      return;
    }

    this.setupRoomCode.set(roomCode.toUpperCase());
    this.setupAutoJoin.set(true);
    this.setupMode.set('join');
  }
}
