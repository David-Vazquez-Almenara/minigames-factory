import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { BeerScene, BeerSceneState } from './beer-scene';

// Una subida y bajada completa del medidor: muy rapido, para que dejarlo en la linea roja sea cuestion de habilidad.
const METER_PERIOD_MS = 600;

/** "11,4" con coma decimal. */
function meters(value: number, decimals = 2): string {
  return value.toFixed(decimals).replace('.', ',');
}

@Component({
  selector: 'app-beer',
  imports: [PlayerAvatarComponent],
  templateUrl: './beer.component.html',
  styleUrl: './beer.component.scss',
})
export class BeerComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private scene?: BeerScene;
  private destroyed = false;
  private frameHandle = 0;
  private slideAnnounced = false;
  private finalAnnounced = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.beer || null);
  readonly unsupported = signal(false);
  /** Valor del medidor (0-1) en esta pantalla; corre solo aqui. */
  readonly meter = signal(0);
  readonly myPower = signal<number | null>(null);

  readonly aimTimer = this.timerService.countdown(() => (this.state()?.stage === 'aiming' ? this.state()?.aimEndsAt : null), {
    paused: () => this.matchService.hostPaused(),
    totalMs: 12000,
    onExpire: () => this.autoThrow(),
  });
  readonly startTimer = this.timerService.countdown(() => this.state()?.aimStartsAt);

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly aiming = computed(() => this.state()?.stage === 'aiming' && this.startTimer.remainingMs() <= 0);
  readonly canThrow = computed(() => this.isPlayer() && this.aiming() && this.myPower() === null);
  /** Posicion (%) de la linea roja del medidor: la fuerza que deja la jarra justo en el borde. */
  readonly perfectLine = computed(() => (this.state()?.perfectPower ?? 0.8) * 100);
  readonly lengthText = computed(() => meters(this.state()?.length || 0, 1));
  readonly playerCount = computed(() => this.matchService.match()?.specialRound?.participantIds.length || 0);

  /** Jarras de todos, con la propia la primera de la fila. */
  readonly jugs = computed(() => {
    const ids = this.matchService.match()?.specialRound?.participantIds || [];
    const ordered = [...ids.filter((id) => id === this.currentPlayerId), ...ids.filter((id) => id !== this.currentPlayerId)];
    return ordered.map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      colorId: this.matchService.playerColor(playerId),
      mine: playerId === this.currentPlayerId,
    }));
  });

  readonly jugTags = computed(() => {
    const outcome = this.state()?.outcome;
    return this.jugs().map((jug) => {
      const row = outcome?.ranking.find((entry) => entry.playerId === jug.playerId);
      return { ...jug, detail: row ? (row.fell ? '¡Al suelo!' : `a ${meters(row.gap)} m`) : '', fell: Boolean(row?.fell) };
    });
  });

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state) {
      return 'Preparando la barra…';
    }

    if (state.stage === 'aiming') {
      if (!this.aiming()) {
        return 'Para el medidor justo en la línea roja (sin pasarte) para dejar la jarra en el borde.';
      }

      if (!this.isPlayer()) {
        return 'Los jugadores están eligiendo la fuerza…';
      }

      return this.myPower() === null
        ? 'Para el medidor (ESPACIO o el botón) con la fuerza que quieras.'
        : `¡Lanzada! Esperando al resto (${state.thrownPlayerIds.length}/${this.playerCount()})…`;
    }

    if (state.stage === 'sliding') {
      return '¡Allá van todas las jarras!';
    }

    return 'Así han quedado las jarras.';
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
      detail: row.fell ? `Se pasó (${meters(row.distance, 1)} m) y la tiró` : `A ${meters(row.gap)} m del borde`,
      pointsText: row.points < 0 ? `−${-row.points}` : `+${row.points}`,
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
      const state = this.state();

      if (state?.stage === 'sliding' && !this.slideAnnounced) {
        this.slideAnnounced = true;
        const delay = Math.max(0, (state.slideStartsAt || 0) - this.matchService.serverNow());
        untracked(() => setTimeout(() => !this.destroyed && this.audioService.playSfx('deslizar'), delay));
      }

      if (state?.outcome && !this.finalAnnounced) {
        this.finalAnnounced = true;
        const mine = state.outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && !mine.fell) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    this.runMeter();
    let THREE: typeof import('three');

    try {
      THREE = await import('three');
    } catch {
      this.unsupported.set(true);
      return;
    }

    const state = this.state();
    const sceneState = this.sceneState();

    if (this.destroyed || !state || !sceneState) {
      return;
    }

    try {
      this.scene = new BeerScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, state.length, sceneState);
      this.scene.onJugBroken = () => this.audioService.playSfx('cristal', { rate: 0.9 + Math.random() * 0.2 });
    } catch {
      this.unsupported.set(true);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frameHandle);
    this.scene?.dispose();
    this.scene = undefined;
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || event.repeat) {
      return;
    }

    event.preventDefault();
    this.throw();
  }

  /** Para el medidor: la fuerza es la que marca en este instante en esta pantalla. */
  throw(): void {
    if (!this.canThrow()) {
      return;
    }

    this.commit(this.meter());
  }

  /** Si se acaba el tiempo sin lanzar, se lanza con lo que marque el medidor en ese momento. */
  private autoThrow(): void {
    if (this.canThrow()) {
      this.commit(this.meter());
    }
  }

  private commit(power: number): void {
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!lobbyId) {
      return;
    }

    const rounded = Math.round(power * 1000) / 1000;
    this.myPower.set(rounded);
    this.audioService.playSfx('voto');
    void this.matchService.throwBeer(lobbyId, rounded);
  }

  /** Medidor que sube y baja (onda triangular). Se queda quieto en cuanto se elige la fuerza. */
  private runMeter(): void {
    const step = () => {
      if (this.destroyed) {
        return;
      }

      this.frameHandle = requestAnimationFrame(step);

      if (this.myPower() !== null || !this.aiming()) {
        return;
      }

      const phase = (performance.now() % METER_PERIOD_MS) / METER_PERIOD_MS;
      this.meter.set(phase < 0.5 ? phase * 2 : 2 - phase * 2);
    };

    step();
  }

  private sceneState(): BeerSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    const throws = new Map(state.throws.map((entry) => [entry.playerId, entry]));
    return {
      jugs: this.jugs().map((jug) => ({
        playerId: jug.playerId,
        distance: throws.get(jug.playerId)?.distance ?? null,
        fell: Boolean(throws.get(jug.playerId)?.fell),
        mine: jug.mine,
      })),
      slideStartsAt: state.slideStartsAt ? performance.now() + (state.slideStartsAt - this.matchService.serverNow()) : null,
      slideMs: state.slideMs,
    };
  }
}
