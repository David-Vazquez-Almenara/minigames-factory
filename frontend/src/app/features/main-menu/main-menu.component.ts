import { Component, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioService } from '../../core/services/audio.service';
import { BackendWakeService } from '../../core/services/backend-wake.service';
import { ConfigService } from '../../core/services/config.service';
import { SocketService } from '../../core/services/socket.service';
import { BackendWakeOverlayComponent } from '../../shared/components/backend-wake-overlay/backend-wake-overlay.component';
import { GameScreenComponent } from '../game/game-screen/game-screen.component';
import { GameSetupFlowComponent } from '../game-setup/game-setup-flow.component';
import { SettingsModalComponent } from '../settings/settings-modal.component';

// Margen para saber si el navegador deja sonar la musica sin interaccion (si la bloquea, responde enseguida).
const MUSIC_CHECK_MS = 1500;

@Component({
  selector: 'app-main-menu',
  imports: [BackendWakeOverlayComponent, GameScreenComponent, GameSetupFlowComponent, SettingsModalComponent],
  templateUrl: './main-menu.component.html',
  styleUrl: './main-menu.component.scss',
})
export class MainMenuComponent implements OnInit, OnDestroy {
  private readonly backendWakeService = inject(BackendWakeService);
  private readonly configService = inject(ConfigService);
  private readonly socketService = inject(SocketService);
  private readonly audioService = inject(AudioService);
  private musicCheckTimer?: ReturnType<typeof setTimeout>;

  /**
   * Entrada al menu: si la musica no puede sonar (el navegador exige un gesto) se muestra el aviso y las
   * animaciones del menu esperan a que se pulse "Continuar", que es el gesto que arranca la musica.
   */
  readonly introState = signal<'checking' | 'disclaimer' | 'ready'>('checking');

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

    // Al terminar una partida el host vuelve primero al lobby de la misma sala y, cuando confirma que es el
    // mismo (mismo codigo), el servidor trae al resto de jugadores 3 segundos despues.
    effect(() => {
      const lobby = this.socketService.returnedToLobby();

      if (!lobby) {
        return;
      }

      this.socketService.returnedToLobby.set(null);
      this.setupRoomCode.set('');
      this.setupAutoJoin.set(false);
      this.setupResumeLobby.set(true);
      this.setupMode.set('join');

      if (this.socketService.isCurrentPlayerHost(lobby)) {
        setTimeout(() => {
          if (this.socketService.lobby()?.code === lobby.code) {
            void this.socketService.confirmLobbyReturn(lobby.code);
          }
        }, 300);
      }
    });

    effect(() => {
      const state = this.audioService.musicState();

      if (untracked(this.introState) !== 'checking') {
        return;
      }

      if (state === 'playing') {
        this.introState.set('ready');
      } else if (state === 'blocked') {
        this.introState.set('disclaimer');
      }
    });
  }

  ngOnInit(): void {
    this.backendWakeService.startMonitoring();
    this.openLobbyFromUrl();
    // Si en un momento no hay respuesta clara (archivo lento, etc.), se decide con lo que haya.
    this.musicCheckTimer = setTimeout(() => {
      if (this.introState() === 'checking') {
        this.introState.set(this.audioService.isMusicPlaying() ? 'ready' : 'disclaimer');
      }
    }, MUSIC_CHECK_MS);
  }

  ngOnDestroy(): void {
    clearTimeout(this.musicCheckTimer);
  }

  /** El clic en "Continuar" es el gesto que desbloquea el audio: la musica arranca y empieza la animacion del menu. */
  continueFromDisclaimer(): void {
    this.audioService.ensureMusicPlaying();
    this.introState.set('ready');
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
