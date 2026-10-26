import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { CountScene, CountSceneState } from './count-scene';

// Lo que dura el travelling de la camara antes de la cuenta atras (el resto del margen inicial es la cuenta 3-2-1).
const CAMERA_TRAVEL_LEAD_MS = 3000;
const MAX_DIGITS = 3;

@Component({
  selector: 'app-count',
  imports: [PlayerAvatarComponent],
  templateUrl: './count.component.html',
  styleUrl: './count.component.scss',
})
export class CountComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private scene?: CountScene;
  private destroyed = false;
  private lastCountdownSecond = -1;
  private announced = { time: false, reveal: false };

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.count || null);
  readonly unsupported = signal(false);
  readonly digits = signal('');
  readonly sent = signal<number | null>(null);
  readonly sending = signal(false);
  readonly errorMessage = signal('');
  readonly keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];

  readonly startTimer = this.timerService.countdown(() => this.state()?.watchStartsAt);
  readonly watchTimer = this.timerService.countdown(() => this.state()?.watchEndsAt);
  readonly answerTimer = this.timerService.countdown(() => (this.state()?.outcome ? null : this.state()?.answerEndsAt), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly showCountdown = computed(() => this.startTimer.remainingMs() > 0 && this.startTimer.remainingMs() <= 3000);
  readonly showIntro = computed(() => this.startTimer.remainingMs() > 3000);
  readonly watching = computed(() => this.startTimer.remainingMs() <= 0 && this.watchTimer.remainingMs() > 0);
  readonly showTimeBanner = computed(() => {
    const state = this.state();
    return Boolean(state && !state.outcome && this.watchTimer.remainingMs() <= 0 && this.answerTimer.remainingMs() > 15000);
  });
  readonly answering = computed(() => Boolean(this.state() && !this.state()!.outcome && this.watchTimer.remainingMs() <= 0 && !this.showTimeBanner()));
  readonly myAnswer = computed(() => this.sent() ?? this.state()?.outcome?.ranking.find((row) => row.playerId === this.currentPlayerId)?.answer ?? null);
  readonly answeredCount = computed(() => this.state()?.answeredPlayerIds.length || 0);
  readonly playerCount = computed(() => this.matchService.match()?.specialRound?.participantIds.length || 0);

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
    })),
  );

  constructor() {
    effect(() => {
      const sceneState = this.sceneState();

      if (sceneState) {
        untracked(() => this.scene?.sync(sceneState));
      }
    });

    effect(() => {
      const seconds = this.startTimer.seconds();

      if (!this.showCountdown() && seconds !== 0) {
        return;
      }

      if (seconds !== this.lastCountdownSecond) {
        const first = this.lastCountdownSecond < 0;
        this.lastCountdownSecond = seconds;
        untracked(() => {
          if (seconds > 0) {
            this.audioService.playEffect('tick');
          } else if (!first) {
            this.audioService.playEffect('reveal');
          }
        });
      }
    });

    effect(() => {
      if (this.showTimeBanner() && !this.announced.time) {
        this.announced.time = true;
        untracked(() => this.audioService.playEffect('vote-end'));
      }

      const outcome = this.state()?.outcome;

      if (outcome && !this.announced.reveal) {
        this.announced.reveal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);
        untracked(() => (mine?.position === 1 && mine.answer !== null ? this.audioService.playFileEffect('win') : this.audioService.playEffect('reveal')));
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    let THREE: typeof import('three');

    try {
      THREE = await import('three');
    } catch {
      this.unsupported.set(true);
      return;
    }

    const initial = this.sceneState();

    if (this.destroyed || !initial) {
      return;
    }

    try {
      this.scene = new CountScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, initial);
    } catch {
      this.unsupported.set(true);
      return;
    }

    // Un coche o una moto que pasa suena a motor; una bici, a timbre.
    this.scene.onVehicle = (kind) => {
      if (kind === 'car' || kind === 'moto') {
        this.audioService.playEngine(kind === 'car' ? 1700 : 2400);
      } else if (kind === 'bike') {
        this.audioService.playSfx('timbre');
      }
    };
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.scene?.dispose();
    this.scene = undefined;
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.canType()) {
      return;
    }

    if (/^[0-9]$/.test(event.key)) {
      this.press(event.key);
    } else if (event.key === 'Backspace') {
      this.press('del');
    } else if (event.key === 'Enter') {
      this.press('ok');
    }
  }

  canType(): boolean {
    return this.answering() && this.isPlayer() && this.sent() === null && !this.sending();
  }

  press(key: string): void {
    if (!this.canType()) {
      return;
    }

    if (key === 'ok') {
      void this.submit();
    } else if (key === 'del') {
      this.digits.update((value) => value.slice(0, -1));
    } else if (this.digits().length < MAX_DIGITS) {
      this.digits.update((value) => (value === '0' ? key : value + key));
      this.audioService.playSfx('boton', { rate: 1.1 });
    }
  }

  private async submit(): Promise<void> {
    const value = Number(this.digits());
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!this.digits() || !lobbyId) {
      return;
    }

    this.sending.set(true);
    this.errorMessage.set('');
    const response = await this.matchService.answerCount(lobbyId, value);
    this.sending.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo enviar la respuesta.');
      return;
    }

    this.sent.set(value);
    this.audioService.playSfx('voto');
  }

  private sceneState(): CountSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    // Los tiempos del servidor se pasan al reloj local de animacion.
    const toLocal = (serverTime: number) => performance.now() + (serverTime - this.matchService.serverNow());
    const watchStartsAt = toLocal(state.watchStartsAt);
    return {
      schedule: state.schedule,
      travel: state.travel,
      watchStartsAt,
      cameraArrivesAt: watchStartsAt - CAMERA_TRAVEL_LEAD_MS,
    };
  }
}
