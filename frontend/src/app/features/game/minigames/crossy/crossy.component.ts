import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { CrossyChickenView, CrossyScene } from './crossy-scene';
import { canEnter, hitAt, startColumn } from './crossy-world';

// Ritmo maximo de saltos (si se pulsa antes, el salto queda en cola) y cada cuanto se envia la posicion.
const HOP_INTERVAL_MS = 115;
const REPORT_INTERVAL_MS = 500;

type Direction = 'up' | 'down' | 'left' | 'right';
const STEPS: Record<Direction, [number, number]> = { up: [1, 0], down: [-1, 0], left: [0, -1], right: [0, 1] };
const KEYS: Record<string, Direction> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};

@Component({
  selector: 'app-crossy',
  imports: [PlayerAvatarComponent],
  templateUrl: './crossy.component.html',
  styleUrl: './crossy.component.scss',
})
export class CrossyComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('chickenTags');
  private THREE?: typeof import('three');
  private scene?: CrossyScene;
  private destroyed = false;
  private frameHandle = 0;
  private lastHopAt = 0;
  private queued: Direction | null = null;
  private lastReportAt = 0;
  private reported = { row: 0, col: 0 };
  private finalReported = false;
  private announcedFinal = false;
  private restored = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.crossy || null);
  readonly unsupported = signal(false);
  private readonly threeReady = signal(false);
  private readonly sceneReady = signal(false);
  /** Posicion propia: manda el cliente (se mueve y detecta los atropellos al instante). */
  readonly position = signal({ row: 0, col: 0 });
  readonly best = signal(0);
  readonly dead = signal<'car' | 'train' | null>(null);
  readonly finished = signal(false);

  readonly startTimer = this.timerService.countdown(() => this.state()?.startsAt);
  readonly playTimer = this.timerService.countdown(() => (this.state()?.stage === 'playing' ? this.state()?.endsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 40000,
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly started = computed(() => Boolean(this.state()) && this.startTimer.remainingMs() <= 0);
  readonly timeUp = computed(() => this.started() && this.playTimer.remainingMs() <= 0);
  readonly canMove = computed(() => this.isPlayer() && this.started() && !this.timeUp() && !this.dead() && !this.finished() && this.state()?.stage === 'playing');
  readonly countdownText = computed(() => {
    const remaining = this.startTimer.remainingMs();

    if (remaining > 0) {
      return this.state() && remaining <= 3000 ? String(Math.ceil(remaining / 1000)) : '';
    }

    // "¡YA!" solo el primer momento de la partida.
    return this.state()?.stage === 'playing' && this.playTimer.remainingMs() > 39200 ? '¡YA!' : '';
  });

  readonly views = computed<CrossyChickenView[]>(() =>
    (this.matchService.match()?.specialRound?.participantIds || []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      color: getPlayerColor(this.matchService.playerColor(playerId)).body,
      isLocal: playerId === this.currentPlayerId,
    })),
  );

  /** Clasificacion en vivo: la fila mas lejana de cada uno (la propia, la del cliente). */
  readonly standings = computed(() => {
    const state = this.state();
    const live = this.matchService.crossyPositions();
    return (state?.players || [])
      .map((player) => {
        const mine = player.playerId === this.currentPlayerId;
        const remote = live[player.playerId];
        return {
          playerId: player.playerId,
          name: this.matchService.playerName(player.playerId),
          avatarUrl: this.matchService.playerAvatar(player.playerId),
          colorId: this.matchService.playerColor(player.playerId),
          mine,
          best: mine ? this.best() : Math.max(player.best, remote?.best ?? 0),
          dead: mine ? Boolean(this.dead()) : player.dead || Boolean(remote?.dead),
          finished: mine ? this.finished() : player.finished || Boolean(remote?.finished),
        };
      })
      .sort((first, second) => Number(second.finished) - Number(first.finished) || second.best - first.best);
  });

  /** Fuera de juego (atropellado, en la meta o sin jugar): se puede ver a los que siguen en carrera. */
  readonly spectateOut = computed(
    () => this.state()?.stage === 'playing' && this.started() && (this.isPlayer() ? Boolean(this.dead()) || this.finished() : true),
  );
  /** A quien se puede espectar: solo los que siguen vivos y sin llegar a la meta (en el orden de la partida). */
  readonly spectatable = computed(() => {
    const status = new Map(this.standings().map((row) => [row.playerId, row]));
    return (this.matchService.match()?.specialRound?.participantIds || []).filter((playerId) => {
      const row = status.get(playerId);
      return playerId !== this.currentPlayerId && row && !row.dead && !row.finished;
    });
  });
  /** Gallina que se esta espectando (null = la propia). */
  readonly spectateId = signal<string | null>(null);
  readonly spectateName = computed(() => {
    const id = this.spectateId();
    return id ? this.matchService.playerName(id) : '';
  });
  private spectateTimer = 0;

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state || state.stage === 'finished') {
      return 'Fin de Cruza la carretera.';
    }

    if (this.spectateOut() && this.spectateId() && !this.spectatable().includes(this.spectateId()!)) {
      return `${this.spectateName()} ya no está en carrera.`;
    }

    if (!this.started()) {
      return 'Prepárate: avanza con ↑ / W (o los botones) y esquiva los coches y los trenes.';
    }

    if (!this.isPlayer()) {
      return 'Mira cómo cruzan los demás.';
    }

    if (this.finished()) {
      return '¡Has llegado a la meta! Esperando al resto…';
    }

    if (this.dead()) {
      return `${this.dead() === 'train' ? '¡Te ha arrollado el tren!' : '¡Te han atropellado!'} Llegaste a la fila ${this.best()} (−5 puntos).`;
    }

    if (this.timeUp()) {
      return `¡Tiempo! Has llegado a la fila ${this.best()}.`;
    }

    return 'Cuando parpadee la luz roja de la vía, ¡viene un tren!';
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
      // Posicion de salida (o, si se recarga la pagina a mitad de partida, donde estaba la gallina).
      const mine = this.state()?.players.find((player) => player.playerId === this.currentPlayerId);

      if (mine && !this.restored) {
        this.restored = true;
        untracked(() => {
          if (mine.row > 0 || mine.dead || mine.finished) {
            this.position.set({ row: mine.row, col: mine.col });
            this.best.set(mine.best);
            this.reported = { row: mine.row, col: mine.col };
            this.dead.set(mine.dead ? 'car' : null);
            this.finished.set(mine.finished);
          } else {
            this.position.set({ row: 0, col: this.startCol(this.currentPlayerId) });
            this.reported = { ...this.position() };
          }
        });
      }
    });

    effect(() => {
      // La escena se monta cuando ya estan Three.js y el nivel (que llega con el estado).
      const state = this.state();

      if (!state || !this.threeReady() || this.scene || this.destroyed) {
        return;
      }

      untracked(() => this.createScene());
    });

    effect(() => {
      // Gallinas de los demas: saltan a la ultima posicion recibida (llega cada ~500 ms).
      const live = this.matchService.crossyPositions();
      const players = this.state()?.players || [];

      if (!this.sceneReady()) {
        return;
      }

      untracked(() => {
        for (const player of players) {
          if (player.playerId === this.currentPlayerId) {
            continue;
          }

          const remote = live[player.playerId];
          const row = remote?.row ?? player.row;
          const col = remote ? remote.col : player.row > 0 ? player.col : this.startCol(player.playerId);
          this.scene?.moveChicken(player.playerId, row, col);

          if (remote?.dead || player.dead) {
            this.scene?.killChicken(player.playerId, 'car');
          }
        }
      });
    });

    effect(() => {
      // Espectador: al caer (o llegar a la meta) la camara se queda ahi 2 s y despues pasa a otro jugador vivo.
      // Lo mismo si cae (o llega) aquel al que se esta viendo.
      const out = this.spectateOut();
      const candidates = this.spectatable();
      const current = this.spectateId();

      untracked(() => {
        if (!out || this.spectateTimer || (current !== null && candidates.includes(current)) || !candidates.length) {
          return;
        }

        this.spectateTimer = window.setTimeout(
          () => {
            this.spectateTimer = 0;
            this.cycleSpectate(1);
          },
          current === null && !this.isPlayer() ? 0 : 2000,
        );
      });
    });

    effect(() => {
      const followId = this.spectateId();

      if (this.sceneReady()) {
        untracked(() => this.scene?.setFollow(followId));
      }
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && mine.rows > 0) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    this.runLoop();

    try {
      this.THREE = await import('three');
    } catch {
      this.unsupported.set(true);
      return;
    }

    if (!this.destroyed) {
      this.threeReady.set(true);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.spectateTimer);
    cancelAnimationFrame(this.frameHandle);
    this.scene?.dispose();
    this.scene = undefined;
  }

  /** Flechas del espectador: siguiente o anterior jugador que sigue en carrera. */
  cycleSpectate(step: 1 | -1): void {
    const candidates = this.spectatable();

    if (!candidates.length) {
      return;
    }

    clearTimeout(this.spectateTimer);
    this.spectateTimer = 0;
    const index = candidates.indexOf(this.spectateId() || '');
    const nextIndex = index < 0 ? (step > 0 ? 0 : candidates.length - 1) : (index + step + candidates.length) % candidates.length;
    this.spectateId.set(candidates[nextIndex]);
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const direction = KEYS[event.code];

    if (!direction) {
      return;
    }

    // Espectando, izquierda y derecha cambian de jugador.
    if (this.spectateOut() && (direction === 'left' || direction === 'right')) {
      event.preventDefault();

      if (!event.repeat) {
        this.cycleSpectate(direction === 'right' ? 1 : -1);
      }

      return;
    }

    event.preventDefault();

    if (!event.repeat) {
      this.press(direction);
    }
  }

  /** Boton o tecla: salta ya o, si aun no ha terminado el salto anterior, deja este en cola. */
  press(direction: Direction): void {
    if (!this.canMove()) {
      return;
    }

    if (performance.now() - this.lastHopAt < HOP_INTERVAL_MS) {
      this.queued = direction;
      return;
    }

    this.hop(direction);
  }

  private hop(direction: Direction): void {
    const state = this.state();

    if (!state || !this.canMove()) {
      return;
    }

    const [rowStep, colStep] = STEPS[direction];
    const current = this.position();
    const next = { row: current.row + rowStep, col: current.col + colStep };

    // No se puede salir por los lados, ni bajar de la salida, ni atravesar arboles.
    if (next.row < 0 || !canEnter(state.rows, next.row, next.col)) {
      this.scene?.moveChicken(this.currentPlayerId, current.row, current.col);
      return;
    }

    this.lastHopAt = performance.now();
    this.position.set(next);
    this.best.update((best) => Math.max(best, next.row));
    this.scene?.moveChicken(this.currentPlayerId, next.row, next.col);
    this.audioService.playSfx('cacareo', { gain: 0.55, rate: 0.9 + Math.random() * 0.25 });

    if (next.row >= state.finishRow) {
      this.finished.set(true);
      this.audioService.playSfx('yuju');
      this.report(true);
    }
  }

  private die(cause: 'car' | 'train'): void {
    this.dead.set(cause);
    this.queued = null;
    this.scene?.killChicken(this.currentPlayerId, cause);
    this.audioService.playSfx(cause === 'train' ? 'tren' : 'atropello');
    this.report(true, true);
  }

  /** Envia la posicion propia: como mucho cada 500 ms (o al momento si muere o llega a la meta). */
  private report(force = false, dead = false): void {
    const lobbyId = this.matchService.match()?.lobbyId;
    const position = this.position();
    const now = performance.now();

    if (!lobbyId || !this.isPlayer()) {
      return;
    }

    if (!force && (now - this.lastReportAt < REPORT_INTERVAL_MS || (position.row === this.reported.row && position.col === this.reported.col))) {
      return;
    }

    this.lastReportAt = now;
    this.reported = { ...position };
    void this.matchService.crossyMove(lobbyId, { ...position, dead });
  }

  private createScene(): void {
    const state = this.state();

    if (!state || !this.THREE) {
      return;
    }

    try {
      this.scene = new CrossyScene(
        this.THREE,
        this.canvasRef().nativeElement,
        this.rootRef().nativeElement,
        this.labelsRef().nativeElement,
        state.rows,
        state.wrap,
        state.finishRow,
      );
      this.scene.clock = () => this.matchService.serverNow() - (this.state()?.startsAt ?? 0);
      this.scene.onWarning = (rowIndex) => {
        // Campana del paso a nivel solo si la via esta cerca.
        if (Math.abs(rowIndex - this.position().row) <= 3 && this.started() && !this.dead()) {
          this.audioService.playSfx('campana-tren', { gain: 0.7 });
        }
      };
      const start = new Map(
        state.players.map((player) => [
          player.playerId,
          player.playerId === this.currentPlayerId
            ? this.position()
            : { row: player.row, col: player.row > 0 ? player.col : this.startCol(player.playerId) },
        ]),
      );
      this.scene.setChickens(this.views(), start);

      if (this.dead()) {
        this.scene.killChicken(this.currentPlayerId, 'car');
      }

      this.sceneReady.set(true);
    } catch {
      this.unsupported.set(true);
    }
  }

  private startCol(playerId: string): number {
    const ids = this.matchService.match()?.specialRound?.participantIds || [];
    return startColumn(Math.max(0, ids.indexOf(playerId)), ids.length);
  }

  /** Bucle propio: saltos en cola, atropellos (contra el reloj comun) y envio de la posicion. */
  private runLoop(): void {
    const tick = () => {
      if (this.destroyed) {
        return;
      }

      this.frameHandle = requestAnimationFrame(tick);
      const state = this.state();

      if (!state || !this.isPlayer() || !this.started()) {
        return;
      }

      if (this.queued && performance.now() - this.lastHopAt >= HOP_INTERVAL_MS) {
        const direction = this.queued;
        this.queued = null;
        this.hop(direction);
      }

      if (this.canMove()) {
        const { row, col } = this.position();
        const hit = hitAt(state.rows, row, col, this.matchService.serverNow() - state.startsAt, state.wrap);

        if (hit) {
          this.die(hit);
          return;
        }

        this.report();
      } else if (this.timeUp() && !this.finalReported && !this.dead() && !this.finished()) {
        this.finalReported = true;
        this.report(true);
      }
    };

    tick();
  }
}
