import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { neighbourWindow } from '../../../../shared/neighbour-window';
import { getPlayerColor } from '../../../../shared/player-colors';
import { CHOP_MAX_VISIBLE, ChopCookView, ChopScene, ChopSceneState } from './chop-scene';

const CLICKS_PER_VEGGIE = 10;
// La animacion propia sigue mientras haya al menos un clic en el ultimo medio segundo (no se reinicia por clic).
const ACTIVE_WINDOW_MS = 500;
const ACTIVITY_CHECK_MS = 100;
// El sonido de corte no suena en cada clic si se hace spam (evita saturar el audio).
const CUT_SOUND_GAP_MS = 70;
const CLOSE_UP_BEFORE_START_MS = 3200;

@Component({
  selector: 'app-chop',
  imports: [PlayerAvatarComponent],
  templateUrl: './chop.component.html',
  styleUrl: './chop.component.scss',
})
export class ChopComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private scene?: ChopScene;
  private insetObserver?: ResizeObserver;
  private activityTimer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private lastClickAt = -Infinity;
  private lastCutSoundAt = 0;
  private lastCountdownSecond = -1;
  private reported = false;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.chop || null);
  readonly unsupported = signal(false);
  /** Clics propios: se cuentan solo aqui y al final se envian las verduras (clics / 10). */
  readonly clicks = signal(0);
  readonly myChopping = signal(false);
  readonly veggies = computed(() => Math.floor(this.clicks() / CLICKS_PER_VEGGIE));
  readonly progress = computed(() => this.clicks() % CLICKS_PER_VEGGIE);
  readonly segments = Array.from({ length: CLICKS_PER_VEGGIE }, (_unused, index) => index);

  readonly startTimer = this.timerService.countdown(() => this.state()?.startsAt);
  readonly playTimer = this.timerService.countdown(() => (this.state()?.stage === 'playing' ? this.state()?.endsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 10000,
    onExpire: () => this.finishLocal(),
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly started = computed(() => this.state()?.stage === 'playing' && this.startTimer.remainingMs() <= 0);
  readonly over = computed(() => this.started() && this.playTimer.remainingMs() <= 0);
  readonly playing = computed(() => this.started() && !this.over());
  readonly showGo = computed(() => this.playing() && this.playTimer.remainingMs() > 9200);

  /** Cocineros visibles (hasta 5): el propio en el centro y los anteriores a los lados. */
  readonly cooks = computed<ChopCookView[]>(() => {
    const window = neighbourWindow(this.matchService.match()?.specialRound?.participantIds || [], this.currentPlayerId, CHOP_MAX_VISIBLE);
    const others = window.filter((id) => id !== this.currentPlayerId);
    const ordered = window.includes(this.currentPlayerId)
      ? [...others.slice(0, Math.floor(others.length / 2)), this.currentPlayerId, ...others.slice(Math.floor(others.length / 2))]
      : window;
    return ordered.map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
      isLocal: playerId === this.currentPlayerId,
    }));
  });

  readonly statusText = computed(() => {
    if (!this.isPlayer()) {
      return 'Mira cómo cortan los demás.';
    }

    if (!this.started()) {
      return 'Prepara el cuchillo: cuando salga «¡YA!», haz clic sin parar.';
    }

    if (this.over()) {
      return this.state()?.outcome ? 'Así ha quedado la cocina.' : `¡Tiempo! Has cortado ${this.veggies()} ${this.veggies() === 1 ? 'verdura' : 'verduras'}. Contando…`;
    }

    return 'Haz clic en cualquier parte (o en el botón) lo más rápido que puedas.';
  });

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

      if (this.state()?.stage !== 'playing' || seconds === this.lastCountdownSecond) {
        return;
      }

      const first = this.lastCountdownSecond < 0;
      this.lastCountdownSecond = seconds;
      untracked(() => {
        if (seconds > 0 && seconds <= 3) {
          this.audioService.playEffect('tick');
        } else if (seconds === 0 && !first) {
          this.audioService.playEffect('reveal');
        }
      });
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && mine.veggies > 0) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });

    effect(() => {
      this.playing();
      untracked(() => queueMicrotask(() => this.updateInsets()));
    });
  }

  async ngAfterViewInit(): Promise<void> {
    // Animacion propia: cada 100 ms se mira si ha habido algun clic en el ultimo medio segundo.
    this.activityTimer = setInterval(() => {
      const active = this.playing() && performance.now() - this.lastClickAt < ACTIVE_WINDOW_MS;

      if (active !== this.myChopping()) {
        this.myChopping.set(active);
      }
    }, ACTIVITY_CHECK_MS);

    let THREE: typeof import('three');

    try {
      THREE = await import('three');
    } catch {
      this.unsupported.set(true);
      return;
    }

    if (this.destroyed) {
      return;
    }

    try {
      this.scene = new ChopScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, this.cooks(), environment.apiUrl);
      const sceneState = this.sceneState();

      if (sceneState) {
        this.scene.sync(sceneState);
      }
    } catch {
      this.unsupported.set(true);
      return;
    }

    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.rootRef(), this.topBarRef(), this.dockRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.updateInsets();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearInterval(this.activityTimer);
    this.insetObserver?.disconnect();
    this.scene?.dispose();
    this.scene = undefined;
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.code === 'Space' && !event.repeat) {
      event.preventDefault();
      this.chop();
    }
  }

  /** Un clic = un corte. Solo se cuenta en esta pantalla y dentro de los 10 s (reloj del servidor). */
  chop(): void {
    const state = this.state();

    if (!state || !this.isPlayer() || this.reported) {
      return;
    }

    const now = this.matchService.serverNow();

    if (now < state.startsAt || now >= state.endsAt) {
      return;
    }

    this.lastClickAt = performance.now();
    this.clicks.update((clicks) => clicks + 1);

    if (!this.myChopping()) {
      // La animacion arranca al primer clic, sin esperar a la siguiente comprobacion.
      this.myChopping.set(true);
    }

    if (this.clicks() % CLICKS_PER_VEGGIE === 0) {
      this.scene?.cut(this.currentPlayerId);
      this.audioService.playEffect('pop');
    } else if (this.lastClickAt - this.lastCutSoundAt > CUT_SOUND_GAP_MS) {
      this.lastCutSoundAt = this.lastClickAt;
      this.audioService.playSfx('corte', { rate: 0.9 + Math.random() * 0.25 });
    }
  }

  /** Fin de los 10 s: se para el cuchillo y se envian las verduras cortadas (el propio cliente divide entre 10). */
  private finishLocal(): void {
    this.myChopping.set(false);

    if (!this.isPlayer() || this.reported) {
      return;
    }

    this.reported = true;
    this.audioService.playEffect('vote-end');
    const lobbyId = this.matchService.match()?.lobbyId;

    if (lobbyId) {
      void this.matchService.reportChop(lobbyId, this.veggies());
    }
  }

  private sceneState(): ChopSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    // Los demas cortan sin parar durante la fase (no se pregunta al servidor); el propio, segun sus clics.
    const chopping = this.playing()
      ? this.cooks()
          .filter((cook) => (cook.isLocal ? this.myChopping() : true))
          .map((cook) => cook.playerId)
      : [];
    return { chopping, closeUp: this.startTimer.remainingMs() <= CLOSE_UP_BEFORE_START_MS };
  }

  private updateInsets(): void {
    const scene = this.scene;

    if (!scene || this.destroyed) {
      return;
    }

    const root = this.rootRef().nativeElement.getBoundingClientRect();
    const top = this.topBarRef().nativeElement.getBoundingClientRect();
    const dock = this.dockRef().nativeElement.getBoundingClientRect();
    scene.setInsets({
      top: Math.max(0, top.bottom - root.top + 6),
      bottom: dock.height ? Math.max(0, root.bottom - dock.top + 6) : 0,
      left: 0,
      right: 0,
    });
  }
}
