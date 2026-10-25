import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { neighbourWindow } from '../../../../shared/neighbour-window';
import { getPlayerColor } from '../../../../shared/player-colors';
import { BOWLING_MAX_LANES, BowlingLaneView, BowlingScene } from './bowling-scene';
import { BowlingSimulation, simulateBowling } from './bowling-sim';

// Ida y vuelta completa de cada medidor: rapidisimos, para que acertar direccion y efecto sea muy dificil.
const DIRECTION_PERIOD_MS = 360;
const SPIN_PERIOD_MS = 300;

type AimStep = 'direction' | 'spin' | 'thrown';

/** Onda triangular entre -1 y 1. */
function sweep(now: number, periodMs: number): number {
  const phase = (now % periodMs) / periodMs;
  return phase < 0.5 ? -1 + phase * 4 : 3 - phase * 4;
}

@Component({
  selector: 'app-bowling',
  imports: [PlayerAvatarComponent],
  templateUrl: './bowling.component.html',
  styleUrl: './bowling.component.scss',
})
export class BowlingComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private scene?: BowlingScene;
  private destroyed = false;
  private frameHandle = 0;
  private othersStarted = false;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.bowling || null);
  readonly unsupported = signal(false);
  private readonly sceneReady = signal(false);
  readonly step = signal<AimStep>('direction');
  /** Valores en vivo de los medidores (corren solo en esta pantalla). */
  readonly directionValue = signal(0);
  readonly spinValue = signal(0);
  readonly lockedDirection = signal<number | null>(null);
  readonly myResult = signal<{ pins: number; simulation: BowlingSimulation } | null>(null);
  readonly myRollDone = signal(false);

  readonly startTimer = this.timerService.countdown(() => this.state()?.aimStartsAt);
  readonly aimTimer = this.timerService.countdown(() => (this.state()?.stage === 'aiming' ? this.state()?.aimEndsAt : null), {
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
    onExpire: () => this.autoThrow(),
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly aiming = computed(() => this.state()?.stage === 'aiming' && this.startTimer.remainingMs() <= 0 && this.step() !== 'thrown' && this.isPlayer());

  /** Pistas visibles (hasta 5): la propia en el centro y los jugadores anteriores a los lados. */
  readonly lanes = computed<BowlingLaneView[]>(() => {
    const window = neighbourWindow(this.matchService.match()?.specialRound?.participantIds || [], this.currentPlayerId, BOWLING_MAX_LANES);
    const others = window.filter((id) => id !== this.currentPlayerId);
    const ordered = window.includes(this.currentPlayerId)
      ? [...others.slice(0, Math.floor(others.length / 2)), this.currentPlayerId, ...others.slice(Math.floor(others.length / 2))]
      : window;
    return ordered.map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      color: getPlayerColor(this.matchService.playerColor(playerId)).body,
      isLocal: playerId === this.currentPlayerId,
    }));
  });

  readonly tags = computed(() => {
    const results = new Map((this.state()?.results || []).map((entry) => [entry.playerId, entry.pins]));
    return this.lanes().map((lane) => {
      const pins = lane.isLocal ? (this.myRollDone() ? this.myResult()?.pins : undefined) : this.state()?.stage !== 'aiming' ? results.get(lane.playerId) : undefined;
      return { ...lane, detail: pins === undefined ? '' : pins === 10 ? '¡STRIKE!' : `${pins} bolos` };
    });
  });

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state || state.stage === 'finished') {
      return 'Fin de la partida de bolos.';
    }

    if (this.startTimer.remainingMs() > 0) {
      return 'Prepárate para lanzar…';
    }

    if (!this.isPlayer()) {
      return 'Mira cómo tiran los demás.';
    }

    switch (this.step()) {
      case 'direction':
        return 'Para el medidor de DIRECCIÓN (ESPACIO o el botón).';
      case 'spin':
        return 'Ahora el de EFECTO: curva la bola hacia un lado.';
      default:
        return this.myRollDone() ? `¡${this.myResult()?.pins} bolos! Esperando al resto…` : '¡Allá va!';
    }
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
      // Tiradas de los demas: cuando el servidor reparte los bolos, todas salen a la vez.
      const state = this.state();

      if (state && state.stage !== 'aiming' && state.rollStartsAt && !this.othersStarted && this.sceneReady()) {
        this.othersStarted = true;
        const startedAt = performance.now() + (state.rollStartsAt - this.matchService.serverNow());
        untracked(() => {
          for (const result of state.results) {
            this.scene?.rollOther(result.playerId, result.pins, startedAt);
          }
        });
      }

      const outcome = state?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && mine.pins > 0) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    this.runMeters();
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
      this.scene = new BowlingScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, this.lanes());
      this.scene.onStrikeSound = (playerId, pins) => {
        const mine = playerId === this.currentPlayerId;
        this.audioService.playSfx('bolos', { gain: mine ? 1 : 0.45, rate: 0.9 + Math.random() * 0.2 });

        if (mine && pins === 10) {
          this.audioService.playFileEffect('win');
        }
      };
      this.sceneReady.set(true);
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
    this.press();
  }

  /** Para el medidor que toca: primero la direccion y despues el efecto (y se lanza). */
  press(): void {
    if (!this.aiming()) {
      return;
    }

    if (this.step() === 'direction') {
      this.lockedDirection.set(this.directionValue());
      this.step.set('spin');
      this.audioService.playEffect('select');
      return;
    }

    this.throwBall(this.lockedDirection() ?? 0, this.spinValue());
  }

  /** Se acaba el tiempo: se lanza con lo que marquen los medidores en ese momento. */
  private autoThrow(): void {
    if (this.isPlayer() && this.step() !== 'thrown') {
      this.throwBall(this.lockedDirection() ?? this.directionValue(), this.spinValue());
    }
  }

  /** La tirada se simula aqui entera (bola y bolos) y empieza a rodar ya; al servidor solo van los bolos. */
  private throwBall(direction: number, spin: number): void {
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!lobbyId) {
      return;
    }

    const simulation = simulateBowling(direction, spin);
    this.step.set('thrown');
    this.myResult.set({ pins: simulation.pins, simulation });
    this.scene?.rollLocal(this.currentPlayerId, simulation);
    this.audioService.playSfx('deslizar', { rate: 0.7 });
    setTimeout(() => !this.destroyed && this.myRollDone.set(true), simulation.frames.length * simulation.frameMs * 0.75);
    void this.matchService.bowlingThrow(lobbyId, simulation.pins, Math.round(direction * 1000) / 1000, Math.round(spin * 1000) / 1000);
  }

  /** Medidores que van y vienen; solo se mueve el que toca. */
  private runMeters(): void {
    const tick = () => {
      if (this.destroyed) {
        return;
      }

      this.frameHandle = requestAnimationFrame(tick);

      if (!this.aiming()) {
        return;
      }

      const now = performance.now();

      if (this.step() === 'direction') {
        this.directionValue.set(sweep(now, DIRECTION_PERIOD_MS));
      } else {
        this.spinValue.set(sweep(now, SPIN_PERIOD_MS));
      }
    };

    tick();
  }
}
