import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { PushBoard, PushDisc } from './push-board';
import { PushResult, STEP, roundImpulse, simulatePush } from './push-physics';

@Component({
  selector: 'app-push',
  imports: [PlayerAvatarComponent],
  templateUrl: './push.component.html',
  styleUrl: './push.component.scss',
})
export class PushComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly hostRef = viewChild.required<ElementRef<HTMLElement>>('playfield');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private board?: PushBoard;
  private insetObserver?: ResizeObserver;
  private readonly images = new Map<string, HTMLImageElement>();
  private announcedFinal = false;
  private lastHitSound = 0;
  private clockHandle = 0;
  private aimingRound = 0;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.push || null);
  /** Direccion y fuerza elegidas (aun sin confirmar) y la confirmada de la ronda. */
  readonly aim = signal<{ vx: number; vy: number } | null>(null);
  readonly confirmedRound = signal(0);
  /** Simulacion de la ronda calculada en este cliente con los impulsos de todos. */
  readonly simulation = signal<{ round: number; result: PushResult; startAt: number } | null>(null);
  private readonly now = signal(performance.now());

  readonly aimTimer = this.timerService.countdown(() => (this.state()?.stage === 'aiming' ? this.state()?.aimEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });
  private lastShrinkAt = 0;
  readonly startTimer = this.timerService.countdown(() => (this.state()?.stage === 'aiming' ? this.state()?.aimStartsAt : null));
  readonly launchTimer = this.timerService.countdown(() => (this.state()?.stage === 'launching' ? this.state()?.launchAt : null));

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  /** Ha terminado la animacion de la ronda (o no hay ninguna en curso). */
  readonly playbackDone = computed(() => {
    const simulation = this.simulation();
    return !simulation || this.now() >= simulation.startAt + simulation.result.steps * STEP * 1000 + 400;
  });
  /** Vivo segun lo que se ve en pantalla: quien cae solo cuenta como caido cuando cae en la animacion. */
  readonly aliveIds = computed(() => {
    const state = this.state();
    const simulation = this.simulation();

    if (!state) {
      return [];
    }

    if (simulation && simulation.round === state.round && state.stage !== 'aiming') {
      const elapsedSteps = (this.now() - simulation.startAt) / 1000 / STEP;
      const fallen = new Set(simulation.result.falls.filter((fall) => fall.step <= elapsedSteps).map((fall) => fall.playerId));
      return simulation.result.ids.filter((playerId) => !fallen.has(playerId));
    }

    return state.players.filter((player) => player.alive).map((player) => player.playerId);
  });
  readonly amAlive = computed(() => this.aliveIds().includes(this.currentPlayerId));
  readonly confirmed = computed(() => {
    const state = this.state();
    return Boolean(state && (this.confirmedRound() === state.round || state.confirmedPlayerIds.includes(this.currentPlayerId)));
  });
  readonly canAim = computed(
    () =>
      this.isPlayer() &&
      this.amAlive() &&
      this.state()?.stage === 'aiming' &&
      this.startTimer.remainingMs() <= 0 &&
      this.aimTimer.remainingMs() > 0 &&
      !this.confirmed(),
  );
  readonly powerPercent = computed(() => {
    const aim = this.aim();
    return aim ? Math.round((Math.hypot(aim.vx, aim.vy) / (this.state()?.maxSpeed || 16)) * 100) : 0;
  });
  /** Lo que queda de pista (en diametro) respecto a la inicial. */
  readonly arenaPercent = computed(() => {
    const state = this.state();
    return state ? Math.round((state.arenaRadius / state.fullRadius) * 100) : 100;
  });
  readonly launchCountdown = computed(() => {
    const remaining = this.launchTimer.remainingMs();
    return this.state()?.stage === 'launching' && remaining > 0 ? String(Math.ceil(remaining / 1000)) : '';
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      text: row.survived ? '¡Sigue en pie!' : `Cayó en la ronda ${row.fellRound}`,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
    })),
  );

  constructor() {
    effect(() => {
      // Ronda nueva: se olvida la direccion anterior y la ficha vuelve a estar quieta (solo una vez por ronda).
      const round = this.state()?.round;

      if (round && this.state()?.stage === 'aiming' && round !== this.aimingRound) {
        this.aimingRound = round;
        untracked(() => {
          this.aim.set(null);
          this.board?.setAim(null);
          this.board?.play(null);
        });
      }
    });

    effect(() => {
      // Salen todos: con los impulsos de todos se calcula aqui la fisica (igual en todas las pantallas). Tambien si
      // el resultado de otro cliente ya ha llegado ('resolved'): la animacion se ve siempre.
      const state = this.state();

      if (!this.canSimulate(state) || this.simulation()?.round === state?.round) {
        return;
      }

      untracked(() => this.runSimulation());
    });

    effect(() => {
      const discs = this.discs();
      untracked(() => this.board?.setDiscs(discs));
    });

    effect(() => {
      // Tamano de la pista, anillo rojo de la ronda siguiente y, al empezar ronda, el anillo que se hunde.
      const state = this.state();

      if (state) {
        untracked(() => this.syncArena(state));
      }
    });

    effect(() => {
      const aiming = this.canAim();
      untracked(() => this.board?.setAiming(aiming));
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  ngAfterViewInit(): void {
    this.board = new PushBoard(this.canvasRef().nativeElement, this.hostRef().nativeElement);
    this.board.onAim = (vx, vy) => {
      this.aim.set(Math.hypot(vx, vy) > 0 ? { vx, vy } : null);
      this.saveDraft(vx, vy);
    };
    this.board.onHit = (strength) => {
      const now = performance.now();

      if (now - this.lastHitSound > 60) {
        this.lastHitSound = now;
        this.audioService.playSfx('rebote', { gain: Math.min(1, 0.35 + strength / 16), rate: 0.9 + Math.random() * 0.25 });
      }
    };
    this.board.onFall = () => this.audioService.playSfx('chapuzon');
    this.board.setDiscs(this.discs());
    this.board.setAiming(this.canAim());

    if (this.state()) {
      this.syncArena(this.state()!);
    }

    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.hostRef(), this.topBarRef(), this.dockRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.updateInsets();
    const tick = () => {
      this.now.set(performance.now());
      this.clockHandle = window.setTimeout(tick, 120);
    };
    tick();

    if (this.canSimulate(this.state())) {
      this.runSimulation();
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.clockHandle);
    this.insetObserver?.disconnect();
    this.board?.dispose();
    this.board = undefined;
  }

  /** Confirma la direccion y fuerza elegidas (sin elegir = quedarse quieto). */
  confirm(): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canAim()) {
      return;
    }

    const aim = this.aim();
    const vx = roundImpulse(aim?.vx ?? 0);
    const vy = roundImpulse(aim?.vy ?? 0);
    this.confirmedRound.set(state.round);
    this.board?.setAiming(false);
    this.audioService.playSfx('voto');
    void this.matchService.pushAim(lobbyId, state.round, vx, vy, true);
  }

  clearAim(): void {
    if (this.canAim()) {
      this.aim.set(null);
      this.board?.setAim(null);
      this.saveDraft(0, 0);
    }
  }

  /**
   * Direccion elegida pero sin confirmar: se guarda en el servidor como borrador, asi si se acaba el tiempo sale con
   * esa (aunque no se haya pulsado "Confirmar").
   */
  private saveDraft(vx: number, vy: number): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (state && lobbyId && this.canAim()) {
      void this.matchService.pushAim(lobbyId, state.round, roundImpulse(vx), roundImpulse(vy), false);
    }
  }

  private syncArena(state: NonNullable<ReturnType<typeof this.state>>): void {
    const shrink = state.shrink;
    let animation: { from: number; to: number; startAt: number } | null = null;

    if (shrink) {
      const startAt = performance.now() + (shrink.at - this.matchService.serverNow());
      animation = { from: shrink.from, to: shrink.to, startAt };

      // Las fichas que estaban en la zona roja se hunden con el anillo (una vez por encogimiento).
      if (shrink.at !== this.lastShrinkAt) {
        this.lastShrinkAt = shrink.at;
        const sinking = state.players
          .filter((player) => shrink.fallen.includes(player.playerId))
          .map((player) => ({
            playerId: player.playerId,
            x: player.x,
            y: player.y,
            color: getPlayerColor(this.matchService.playerColor(player.playerId)).body,
            image: this.imageFor(player.playerId),
            mine: player.playerId === this.currentPlayerId,
            name: this.matchService.playerName(player.playerId),
            confirmed: false,
          }));
        this.board?.sink(sinking, startAt);
      }
    }

    this.board?.setArena(state.arenaRadius, state.nextRadius, animation);
  }

  /** Fichas en pantalla: posicion de la ronda (la animacion la mueve el tablero). */
  private discs(): PushDisc[] {
    const state = this.state();

    if (!state) {
      return [];
    }

    const simulation = this.simulation();
    // Mientras se ve la animacion de la ronda, las fichas salen de donde estaban al empezar.
    const players =
      simulation && simulation.round === state.round && state.stage !== 'aiming'
        ? simulation.result.ids.map((playerId, index) => ({ playerId, x: simulation.result.frames[0][index * 2], y: simulation.result.frames[0][index * 2 + 1] }))
        : state.players.filter((player) => player.alive);

    return players.map((player) => ({
      playerId: player.playerId,
      x: player.x,
      y: player.y,
      color: getPlayerColor(this.matchService.playerColor(player.playerId)).body,
      image: this.imageFor(player.playerId),
      mine: player.playerId === this.currentPlayerId,
      name: this.matchService.playerName(player.playerId),
      confirmed: state.stage === 'aiming' && state.confirmedPlayerIds.includes(player.playerId),
    }));
  }

  /** Hay impulsos y posiciones de salida de la ronda (lanzando o ya resuelta, pero sin pasar a la siguiente). */
  private canSimulate(state: ReturnType<typeof this.state>): boolean {
    return Boolean(state && (state.stage === 'launching' || state.stage === 'resolved') && state.launchAt && state.launchBodies?.length);
  }

  private runSimulation(): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !this.canSimulate(state) || !state.launchAt || this.simulation()?.round === state.round) {
      return;
    }

    // Siempre desde las posiciones de salida de la ronda (no las finales, que pueden haber llegado ya).
    const bodies = state.launchBodies.map(({ playerId, x, y }) => ({ playerId, x, y }));
    const result = simulatePush(bodies, state.impulses, state.arenaRadius);
    const startAt = performance.now() + (state.launchAt - this.matchService.serverNow());
    this.simulation.set({ round: state.round, result, startAt });
    this.board?.setAim(null);
    this.board?.play(result, startAt);
    setTimeout(() => this.audioService.playSfx('deslizar', { rate: 1.3, gain: 0.6 }), Math.max(0, startAt - performance.now()));

    // Todas las pantallas calculan lo mismo: el servidor se queda con el primer resultado que le llega.
    if (lobbyId && this.isPlayer() && state.stage === 'launching') {
      void this.matchService.pushResult(lobbyId, {
        round: state.round,
        positions: result.finals,
        falls: result.falls.map((fall) => ({ playerId: fall.playerId, step: fall.step })),
        steps: result.steps,
      });
    }
  }

  private imageFor(playerId: string): HTMLImageElement | null {
    const url = this.matchService.playerAvatar(playerId);

    if (!url) {
      return null;
    }

    let image = this.images.get(playerId);

    if (!image) {
      image = new Image();
      image.src = url;
      this.images.set(playerId, image);
    }

    return image;
  }

  private updateInsets(): void {
    const host = this.hostRef().nativeElement.getBoundingClientRect();
    const top = this.topBarRef().nativeElement.getBoundingClientRect();
    const dock = this.dockRef().nativeElement.getBoundingClientRect();
    // Reserva fija abajo para que la pista no cambie de tamano cuando aparecen o desaparecen los botones.
    this.board?.setInsets(Math.max(0, top.bottom - host.top + 8), Math.max(130, dock.height ? host.bottom - dock.top + 8 : 0));
  }
}
