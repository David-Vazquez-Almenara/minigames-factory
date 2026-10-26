import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { SnakePublicState } from '../../../../core/services/socket.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { BoardSnake, SnakeBoard } from './snake-board';

type Direction = 'up' | 'down' | 'left' | 'right';
type Cell = [number, number];
const STEPS: Record<Direction, Cell> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYS: Record<string, Direction> = {
  KeyW: 'up',
  ArrowUp: 'up',
  KeyS: 'down',
  ArrowDown: 'down',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};
// Distancia minima (px) de un deslizamiento del dedo para contar como giro.
const SWIPE_PX = 24;

interface RemoteSnake {
  body: Cell[];
  previous: Cell[];
  movedAt: number;
  seq: number;
  diedAt: number | null;
}

@Component({
  selector: 'app-snake',
  imports: [PlayerAvatarComponent],
  templateUrl: './snake.component.html',
  styleUrl: './snake.component.scss',
})
export class SnakeComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly controlsRef = viewChild<ElementRef<HTMLElement>>('controls');
  private board?: SnakeBoard;
  private insetObserver?: ResizeObserver;
  private frameHandle = 0;
  private destroyed = false;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.snake || null);
  readonly startTimer = this.timerService.countdown(() => this.state()?.startsAt);
  readonly playTimer = this.timerService.countdown(() => (this.state()?.stage === 'playing' ? this.state()?.endsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 150000,
  });

  /* ------------------------------ Mi serpiente ------------------------------ */
  // Se mueve aqui al momento, a paso fijo; cada casilla nueva de la cabeza se envia al servidor.
  private body: Cell[] = [];
  private previous: Cell[] = [];
  private direction: Cell = [1, 0];
  private readonly turns: Cell[] = [];
  private grow = 0;
  private lastStepAt = 0;
  private seq = 0;
  private started = false;
  readonly dead = signal(false);
  private myDiedAt: number | null = null;
  readonly eaten = signal(0);

  /* ------------------------------ Las demas --------------------------------- */
  private readonly remotes = new Map<string, RemoteSnake>();
  /** Frutas que acabo de comer (desaparecen aqui al momento; el servidor pone otra). */
  private readonly eatenFruits = new Map<number, number>();
  private swipeStart: { x: number; y: number } | null = null;

  readonly me = computed(() => this.state()?.players.find((player) => player.playerId === this.currentPlayerId) || null);
  readonly isPlayer = computed(() => Boolean(this.me()));
  readonly aliveCount = computed(() => (this.state()?.players || []).filter((player) => player.alive).length);
  readonly hasStarted = computed(() => Boolean(this.state()) && this.startTimer.remainingMs() <= 0);
  readonly countdownText = computed(() => {
    const remaining = this.startTimer.remainingMs();

    if (remaining > 0) {
      return remaining <= 3000 ? String(Math.ceil(remaining / 1000)) : '';
    }

    return this.state()?.stage === 'playing' && this.playTimer.remainingMs() > 149200 ? '¡YA!' : '';
  });
  readonly canPlay = computed(() => this.isPlayer() && this.hasStarted() && !this.dead() && this.state()?.stage === 'playing');
  readonly timeText = computed(() => {
    const seconds = this.playTimer.seconds();
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
      const state = this.state();

      if (state) {
        untracked(() => this.syncFromServer(state));
      }
    });

    effect(() => {
      // Cabezas nuevas de las demas: cada una alarga su cuerpo por delante y lo recorta a su largo.
      const moves = this.matchService.snakeMoves();
      untracked(() => this.applyMoves(moves));
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
    this.board = new SnakeBoard(this.canvasRef().nativeElement, this.rootRef().nativeElement);

    for (const player of this.state()?.players || []) {
      this.board.setAvatar(player.playerId, this.matchService.playerAvatar(player.playerId));
    }

    this.insetObserver = new ResizeObserver(() => this.updateInsets());
    this.insetObserver.observe(this.rootRef().nativeElement);
    this.insetObserver.observe(this.topBarRef().nativeElement);
    const controls = this.controlsRef()?.nativeElement;

    if (controls) {
      this.insetObserver.observe(controls);
    }

    this.updateInsets();
    const loop = () => {
      if (this.destroyed) {
        return;
      }

      this.frameHandle = requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frameHandle);
    this.insetObserver?.disconnect();
    this.board?.dispose();
  }

  /* --------------------------------- Mandos --------------------------------- */

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const direction = KEYS[event.code];

    if (direction) {
      event.preventDefault();
      this.turn(direction);
    }
  }

  /** Giro (en cola: hasta dos seguidos; nunca media vuelta sobre si misma). */
  turn(direction: Direction, event?: Event): void {
    event?.preventDefault();

    if (!this.canPlay()) {
      return;
    }

    const next = STEPS[direction];
    const last = this.turns[this.turns.length - 1] || this.direction;

    if ((next[0] === last[0] && next[1] === last[1]) || (next[0] === -last[0] && next[1] === -last[1]) || this.turns.length >= 2) {
      return;
    }

    this.turns.push(next);
  }

  /** Deslizar el dedo (o el raton) sobre el tablero tambien gira. */
  swipeDown(event: PointerEvent): void {
    this.swipeStart = { x: event.clientX, y: event.clientY };
  }

  swipeMove(event: PointerEvent): void {
    if (!this.swipeStart) {
      return;
    }

    const dx = event.clientX - this.swipeStart.x;
    const dy = event.clientY - this.swipeStart.y;

    if (Math.max(Math.abs(dx), Math.abs(dy)) >= SWIPE_PX) {
      this.turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
      this.swipeStart = { x: event.clientX, y: event.clientY };
    }
  }

  swipeUp(): void {
    this.swipeStart = null;
  }

  /* ----------------------------- Estado del servidor ----------------------------- */

  private syncFromServer(state: SnakePublicState): void {
    for (const player of state.players) {
      if (player.playerId === this.currentPlayerId) {
        // Mi serpiente arranca donde dice el servidor (y si cae, se marca).
        if (!this.body.length) {
          this.body = player.body.map(([x, y]) => [x, y] as Cell);
          this.previous = this.body.map((cell) => [...cell] as Cell);
          this.direction = [...player.dir] as Cell;
        }

        if (!player.alive && !this.dead()) {
          this.dead.set(true);
          this.myDiedAt = performance.now();
        }

        continue;
      }

      let remote = this.remotes.get(player.playerId);

      if (!remote) {
        remote = { body: [], previous: [], movedAt: 0, seq: 0, diedAt: null };
        this.remotes.set(player.playerId, remote);
      }

      // El cuerpo del servidor esta al dia (le llegan los movimientos antes que este estado): se adopta.
      remote.body = player.body.map(([x, y]) => [x, y] as Cell);

      if (remote.previous.length !== remote.body.length) {
        remote.previous = remote.body.map((cell) => [...cell] as Cell);
      }

      if (!player.alive && remote.diedAt === null) {
        remote.diedAt = performance.now();
      }
    }

    for (const id of [...this.eatenFruits.keys()]) {
      if (!state.fruits.some((fruit) => fruit.id === id) || performance.now() - (this.eatenFruits.get(id) || 0) > 2000) {
        this.eatenFruits.delete(id);
      }
    }
  }

  private applyMoves(moves: Array<{ playerId: string; x: number; y: number; s: number }>): void {
    const state = this.state();

    for (const move of moves) {
      const remote = this.remotes.get(move.playerId);

      if (!remote || move.s <= remote.seq || remote.diedAt !== null) {
        continue;
      }

      remote.seq = move.s;
      const length = state?.players.find((player) => player.playerId === move.playerId)?.length || remote.body.length;
      remote.previous = remote.body.map((cell) => [...cell] as Cell);
      remote.body = [[move.x, move.y] as Cell, ...remote.body].slice(0, Math.max(length, 1));
      remote.movedAt = performance.now();
    }
  }

  /* --------------------------------- Bucle --------------------------------- */

  private tick(): void {
    const state = this.state();

    if (!state || !this.board) {
      return;
    }

    const now = performance.now();
    const serverNow = this.matchService.serverNow();

    // Paso fijo desde la salida (el mismo ritmo en todas las pantallas).
    if (this.canPlay() && !this.matchService.hostPaused()) {
      if (!this.started) {
        this.started = true;
        this.lastStepAt = now - Math.max(0, serverNow - state.startsAt) % state.stepMs;
      }

      let steps = 0;

      while (now - this.lastStepAt >= state.stepMs && steps < 3 && !this.dead()) {
        this.lastStepAt += state.stepMs;
        this.step(state, now);
        steps += 1;
      }

      // Si la pestana estuvo parada, no recupera todos los pasos de golpe.
      if (now - this.lastStepAt >= state.stepMs) {
        this.lastStepAt = now;
      }
    } else if (this.matchService.hostPaused()) {
      this.lastStepAt = now;
    }

    this.board.draw({ size: state.size, snakes: this.snakes(state, now), fruits: this.visibleFruits(state) }, now);
  }

  /** Un paso: la cabeza avanza; si choca (pared, otra serpiente o ella misma) cae aqui mismo. */
  private step(state: SnakePublicState, now: number): void {
    const next = this.turns.shift();

    if (next) {
      this.direction = next;
    }

    const [hx, hy] = this.body[0];
    const head: Cell = [hx + this.direction[0], hy + this.direction[1]];
    const blocked = new Set<number>();
    // La cola propia se mueve en este paso (salvo que este creciendo).
    const mine = this.grow > 0 ? this.body : this.body.slice(0, -1);

    for (const [x, y] of mine) {
      blocked.add(y * state.size + x);
    }

    for (const [playerId, remote] of this.remotes) {
      const alive = state.players.find((player) => player.playerId === playerId)?.alive;

      if (alive && remote.diedAt === null) {
        for (const [x, y] of remote.body) {
          blocked.add(y * state.size + x);
        }
      }
    }

    const outside = head[0] < 0 || head[1] < 0 || head[0] >= state.size || head[1] >= state.size;

    if (outside || blocked.has(head[1] * state.size + head[0])) {
      this.crash();
      return;
    }

    this.previous = this.body.map((cell) => [...cell] as Cell);
    this.body.unshift(head);

    if (this.grow > 0) {
      this.grow -= 1;
    } else {
      this.body.pop();
    }

    this.seq += 1;
    const lobbyId = this.matchService.match()?.lobbyId;

    if (lobbyId) {
      this.matchService.snakeMove(lobbyId, head[0], head[1], this.seq);
    }

    // Manzana: crece al momento (el servidor se la da al primero que llega y pone otra).
    const fruit = this.visibleFruits(state).find((item) => item.x === head[0] && item.y === head[1]);

    if (fruit) {
      this.eatenFruits.set(fruit.id, now);
      this.grow += state.grow;
      this.eaten.update((count) => count + 1);
      this.audioService.playSfx('acierto', { gain: 0.6, rate: 1 + Math.min(0.6, this.eaten() * 0.03) });
    }
  }

  private crash(): void {
    this.dead.set(true);
    this.myDiedAt = performance.now();
    this.turns.length = 0;
    this.audioService.playSfx('aplastar', { gain: 0.9, rate: 1.1 });
    const lobbyId = this.matchService.match()?.lobbyId;

    if (lobbyId) {
      void this.matchService.snakeDead(lobbyId);
    }
  }

  /* --------------------------------- Dibujo -------------------------------- */

  private visibleFruits(state: SnakePublicState): SnakePublicState['fruits'] {
    return state.fruits.filter((fruit) => !this.eatenFruits.has(fruit.id));
  }

  private snakes(state: SnakePublicState, now: number): BoardSnake[] {
    // El tablero desliza la cabeza y la cola entre el paso anterior y el actual (y redondea las esquinas).
    return state.players.map((player) => {
      const mine = player.playerId === this.currentPlayerId;
      const color = getPlayerColor(this.matchService.playerColor(player.playerId)).body;
      const name = this.matchService.playerName(player.playerId);

      if (mine) {
        const progress = this.dead() ? 1 : Math.min(1, (now - this.lastStepAt) / state.stepMs);
        return {
          playerId: player.playerId,
          name,
          color,
          body: this.body,
          previous: this.started ? this.previous : this.body,
          progress,
          dir: this.direction,
          alive: !this.dead(),
          diedAt: this.myDiedAt,
          mine: true,
        };
      }

      const remote = this.remotes.get(player.playerId);
      const body = remote?.body.length ? remote.body : (player.body as Cell[]);
      const progress = remote ? Math.min(1, (now - remote.movedAt) / state.stepMs) : 1;
      const head = body[0];
      const neck = body[1] || head;
      return {
        playerId: player.playerId,
        name,
        color,
        body,
        previous: remote?.previous || body,
        progress,
        dir: [Math.sign(head[0] - neck[0]) || player.dir[0], Math.sign(head[1] - neck[1]) || player.dir[1]],
        alive: player.alive && remote?.diedAt == null,
        diedAt: remote?.diedAt ?? null,
        mine: false,
      };
    });
  }

  private updateInsets(): void {
    if (!this.board || this.destroyed) {
      return;
    }

    const root = this.rootRef().nativeElement.getBoundingClientRect();
    const top = this.topBarRef().nativeElement.getBoundingClientRect();
    const controls = this.controlsRef()?.nativeElement.getBoundingClientRect();
    // En vertical (movil) las flechas van debajo del tablero.
    const portrait = root.height > root.width;
    const bottom = portrait && controls?.height ? root.bottom - controls.top + 4 : 8;
    this.board.setInsets({ top: Math.max(0, top.bottom - root.top + 4), right: 8, bottom, left: 8 });
  }
}
