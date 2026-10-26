import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { BombermanPublicState } from '../../../../core/services/socket.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { BoardFrame, BoardPlayer, BombermanBoard } from './bomberman-board';
import { FlameShape, RuleBomb, canEnter, canPlaceBomb, computeBlast, leaveOwnBombs } from './bomberman-rules';

// Lo que tarda el personaje en pasar de una casilla a la siguiente (y lo que se anima a los demas).
const STEP_MS = 165;
// Tiempo durante el que las llamas de una explosion matan (la animacion dura algo mas, pero no hace dano).
const LETHAL_MS = 450;
const FLAME_MS = 650;
const RUBBLE_MS = 500;

type Direction = 'up' | 'down' | 'left' | 'right';
const STEPS: Record<Direction, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
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

interface RemoteView {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  startedAt: number;
  diedAt: number | null;
}

@Component({
  selector: 'app-bomberman',
  imports: [PlayerAvatarComponent],
  templateUrl: './bomberman.component.html',
  styleUrl: './bomberman.component.scss',
})
export class BombermanComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly controlsRef = viewChild<ElementRef<HTMLElement>>('controls');
  private board?: BombermanBoard;
  private insetObserver?: ResizeObserver;
  private frameHandle = 0;
  private destroyed = false;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.bomberman || null);
  readonly startTimer = this.timerService.countdown(() => this.state()?.startsAt);
  readonly playTimer = this.timerService.countdown(() => (this.state()?.stage === 'playing' ? this.state()?.endsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 180000,
  });

  /* ------------------------- Mundo local (prediccion) ------------------------ */
  // El mapa que se ve: el del servidor con las piedras que ya han roto aqui las explosiones que el servidor aun
  // no ha confirmado (cada pantalla explota las bombas a su hora, sin esperar).
  private cells: string[] = [];
  private readonly pendingStones: Array<{ index: number; at: number }> = [];
  private bombs: RuleBomb[] = [];
  /** Bombas propias recien puestas (id negativo) a la espera de que el servidor las confirme. */
  private localBombs: RuleBomb[] = [];
  private localBombId = 0;
  /** Bombas que ya han explotado en esta pantalla (no se vuelven a pintar aunque el estado tarde). */
  private readonly exploded = new Set<number>();
  /** Relacion explicita dueno-casilla: casillas de mis bombas de las que aun no he salido. */
  private readonly myInside = new Set<number>();
  private powerups: BombermanPublicState['powerups'] = [];
  private readonly burnt: Array<{ index: number; at: number }> = [];
  private readonly picked = new Set<number>();
  private flames: Array<{ index: number; shape: FlameShape; startedAt: number }> = [];
  private rubble: Array<{ index: number; startedAt: number }> = [];
  private lethal: Array<{ hit: Set<number>; at: number; until: number }> = [];
  private readonly remotes = new Map<string, RemoteView>();

  /* ------------------------------ Mi personaje ------------------------------ */
  private position: { x: number; y: number } | null = null;
  private from = { x: 0, y: 0 };
  private stepStartedAt = -Infinity;
  private moveSeq = 0;
  private held: Direction[] = [];
  private touchDirection: Direction | null = null;
  private queued: Direction | null = null;
  private deathReported = false;
  private myDiedAt: number | null = null;
  readonly dead = signal(false);
  /** Mis bombas activas (para el contador de la interfaz). */
  readonly activeBombs = signal(0);

  readonly me = computed(() => this.state()?.players.find((player) => player.playerId === this.currentPlayerId) || null);
  readonly isPlayer = computed(() => Boolean(this.me()));
  readonly aliveCount = computed(() => (this.state()?.players || []).filter((player) => player.alive).length);
  readonly started = computed(() => Boolean(this.state()) && this.startTimer.remainingMs() <= 0);
  readonly countdownText = computed(() => {
    const remaining = this.startTimer.remainingMs();

    if (remaining > 0) {
      return remaining <= 3000 ? String(Math.ceil(remaining / 1000)) : '';
    }

    return this.state()?.stage === 'playing' && this.playTimer.remainingMs() > 179200 ? '¡YA!' : '';
  });
  readonly canAct = computed(() => this.isPlayer() && this.started() && !this.dead() && Boolean(this.me()?.alive) && this.state()?.stage === 'playing');
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
  readonly resultTitle = computed(() => {
    const outcome = this.state()?.outcome;

    if (!outcome) {
      return '';
    }

    if (outcome.draw) {
      return '¡Empate!';
    }

    return outcome.winnerId === this.currentPlayerId ? '¡Has ganado!' : `Gana ${this.matchService.playerName(outcome.winnerId)}`;
  });

  constructor() {
    effect(() => {
      const state = this.state();

      if (state) {
        untracked(() => this.syncFromServer(state));
      }
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1) {
          untracked(() => this.audioService.playFileEffect('win'));
        }

        untracked(() => setTimeout(() => this.updateInsets(), 600));
      }
    });
  }

  ngAfterViewInit(): void {
    this.board = new BombermanBoard(this.canvasRef().nativeElement, this.rootRef().nativeElement);

    for (const player of this.state()?.players || []) {
      this.board.setPlayer(
        player.playerId,
        this.matchService.playerAvatar(player.playerId),
        getPlayerColor(this.matchService.playerColor(player.playerId)).body,
        this.matchService.playerName(player.playerId),
      );
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
    // Bomba: Espacio o Intro.
    if (event.code === 'Space' || event.code === 'Enter' || event.code === 'NumpadEnter') {
      event.preventDefault();

      if (!event.repeat) {
        this.placeBomb();
      }

      return;
    }

    const direction = KEYS[event.code];

    if (!direction) {
      return;
    }

    event.preventDefault();

    if (!this.held.includes(direction)) {
      this.held.push(direction);
    }

    // Un toque rapido tambien mueve (aunque se suelte antes de que acabe el paso anterior).
    if (!event.repeat) {
      this.queued = direction;
    }
  }

  @HostListener('window:keyup', ['$event'])
  onKeyup(event: KeyboardEvent): void {
    const direction = KEYS[event.code];

    if (direction) {
      this.held = this.held.filter((item) => item !== direction);
    }
  }

  @HostListener('window:blur')
  onBlur(): void {
    this.held = [];
    this.touchDirection = null;
  }

  /** Cruceta en pantalla: mientras se mantiene pulsada, el personaje sigue andando. */
  pressDirection(direction: Direction, event: Event): void {
    event.preventDefault();
    this.touchDirection = direction;
    this.queued = direction;
  }

  releaseDirection(direction: Direction): void {
    if (this.touchDirection === direction) {
      this.touchDirection = null;
    }
  }

  /** Bomba en la casilla del personaje (sin moverlo). Sale al instante aqui y el servidor la confirma. */
  placeBomb(event?: Event): void {
    event?.preventDefault();
    const state = this.state();
    const me = this.me();
    const lobbyId = this.matchService.match()?.lobbyId;
    const position = this.position;

    if (!state || !me || !lobbyId || !position || !this.canAct() || this.matchService.hostPaused()) {
      return;
    }

    if (!canPlaceBomb(state.size, this.cells, this.bombs, this.currentPlayerId, me.capacity, position.x, position.y)) {
      return;
    }

    const placedAt = this.matchService.serverNow();
    const local: RuleBomb = {
      id: -++this.localBombId,
      owner: this.currentPlayerId,
      x: position.x,
      y: position.y,
      radius: me.radius,
      explodeAt: placedAt + state.fuseMs,
      ownerInside: true,
    };
    this.myInside.add(position.y * state.size + position.x);
    this.localBombs.push(local);
    this.rebuildBombs();
    this.audioService.playSfx('martillo', { gain: 0.8, rate: 0.8 });

    void this.matchService.bombermanBomb(lobbyId, position.x, position.y, placedAt).then((response) => {
      this.localBombs = this.localBombs.filter((bomb) => bomb !== local);

      // Rechazada (p. ej. otra bomba llego antes a esa casilla): se quita la que se habia puesto aqui.
      if (!response.ok) {
        this.myInside.delete(local.y * state.size + local.x);
      }

      this.rebuildBombs();
    });
  }

  /* ----------------------------- Estado del servidor ----------------------------- */

  /** Mezcla el estado del servidor con lo que ya ha pasado en esta pantalla y aun no ha confirmado. */
  private syncFromServer(state: BombermanPublicState): void {
    // Lo que el servidor ya ha procesado deja de estar pendiente.
    const confirmed = (at: number) => at <= state.lastBoomAt;
    this.removeWhere(this.pendingStones, (entry) => confirmed(entry.at));
    this.removeWhere(this.burnt, (entry) => confirmed(entry.at));
    this.cells = state.cells.split('');

    for (const entry of this.pendingStones) {
      this.cells[entry.index] = '.';
    }

    // Mejoras: las del servidor salvo las que acabo de coger o se han quemado aqui (aun sin confirmar).
    for (const index of [...this.picked]) {
      if (!state.powerups.some((powerup) => powerup.y * state.size + powerup.x === index)) {
        this.picked.delete(index);
      }
    }

    this.powerups = state.powerups.filter((powerup) => {
      const index = powerup.y * state.size + powerup.x;
      return !this.picked.has(index) && !this.burnt.some((entry) => entry.index === index);
    });

    // Explosiones que el servidor ha hecho y esta pantalla no (p. ej. con la pestana en segundo plano).
    for (const blast of state.blasts) {
      if (blast.bombIds.some((id) => !this.exploded.has(id)) && this.matchService.serverNow() - blast.at < 1500) {
        blast.bombIds.forEach((id) => this.exploded.add(id));
        // La forma de cada trozo de llama sale de sus vecinas (horizontal, vertical o cruce).
        const hit = new Set(blast.hit);
        const shapes = new Map<number, FlameShape>(
          blast.hit.map((index) => {
            const horizontal = hit.has(index - 1) || hit.has(index + 1);
            const vertical = hit.has(index - state.size) || hit.has(index + state.size);
            return [index, horizontal && vertical ? 'center' : horizontal ? 'h' : vertical ? 'v' : 'center'];
          }),
        );
        this.showBlast(blast.hit, shapes, blast.stones, blast.at, true);
        // Las llamas hacen dano igual que si hubiera explotado aqui (antes solo se pintaban y no mataban).
        const late = Math.max(0, this.matchService.serverNow() - blast.at);
        this.lethal.push({ hit, at: blast.at, until: performance.now() + Math.max(150, LETHAL_MS - late) });
      } else {
        blast.bombIds.forEach((id) => this.exploded.add(id));
      }
    }

    // Mi posicion inicial (spawn) y mi muerte si me la ha marcado el servidor.
    const me = state.players.find((player) => player.playerId === this.currentPlayerId);

    if (me && !this.position) {
      this.position = { x: me.x, y: me.y };
      this.from = { ...this.position };
    }

    if (me && !me.alive && !this.dead()) {
      this.dead.set(true);
      this.myDiedAt = performance.now();
    }

    this.rebuildBombs();
  }

  private rebuildBombs(): void {
    const state = this.state();

    if (!state) {
      return;
    }

    const size = state.size;
    const serverBombs: RuleBomb[] = state.bombs
      .filter((bomb) => !this.exploded.has(bomb.id))
      .map((bomb) => ({ ...bomb, explodeAt: bomb.explodeAt, ownerInside: bomb.owner === this.currentPlayerId && this.myInside.has(bomb.y * size + bomb.x) }));
    // Las propias aun sin confirmar, salvo que ya este la del servidor en esa casilla.
    const pending = this.localBombs.filter((bomb) => !this.exploded.has(bomb.id) && !serverBombs.some((other) => other.x === bomb.x && other.y === bomb.y));
    pending.forEach((bomb) => (bomb.ownerInside = this.myInside.has(bomb.y * size + bomb.x)));
    this.bombs = [...serverBombs, ...pending];
    this.activeBombs.set(this.bombs.filter((bomb) => bomb.owner === this.currentPlayerId).length);
  }

  /* --------------------------------- Bucle --------------------------------- */

  private tick(): void {
    const state = this.state();

    if (!state || !this.board) {
      return;
    }

    const now = performance.now();
    const serverNow = this.matchService.serverNow();
    const paused = this.matchService.hostPaused();

    if (!paused) {
      this.updateMovement(state, now);
      this.updateExplosions(state, now, serverNow);
      this.checkDeath(state, now);
    }

    this.flames = this.flames.filter((flame) => now - flame.startedAt < FLAME_MS);
    this.rubble = this.rubble.filter((piece) => now - piece.startedAt < RUBBLE_MS);
    this.lethal = this.lethal.filter((entry) => now < entry.until);
    this.board.draw(this.frame(state, now, serverNow), now);
  }

  /** Paso a paso por la cuadricula: la casilla logica cambia al empezar el paso y el dibujo se desliza. */
  private updateMovement(state: BombermanPublicState, now: number): void {
    const position = this.position;

    if (!position || !this.canAct()) {
      return;
    }

    if (now - this.stepStartedAt < STEP_MS) {
      return;
    }

    const direction = this.queued ?? this.held[this.held.length - 1] ?? this.touchDirection;
    this.queued = null;

    if (!direction) {
      return;
    }

    const [dx, dy] = STEPS[direction];
    const target = { x: position.x + dx, y: position.y + dy };

    // Solo se puede entrar en suelo libre; las bombas nunca empujan: si no se puede, el personaje se queda quieto.
    if (!canEnter(state.size, this.cells, this.bombs, this.currentPlayerId, position, target.x, target.y)) {
      return;
    }

    this.from = { ...position };
    this.position = target;
    this.stepStartedAt = now;
    // Al entrar en otra casilla, mis bombas pasan a ser solidas para mi (para siempre).
    this.myInside.clear();
    leaveOwnBombs(this.bombs, this.currentPlayerId, target.x, target.y);
    this.moveSeq += 1;
    const lobbyId = this.matchService.match()?.lobbyId;

    if (lobbyId) {
      this.matchService.bombermanMove(lobbyId, target.x, target.y, this.moveSeq);
    }

    // Mejora: desaparece aqui al pisarla (el servidor se la da al primero que llega).
    const index = target.y * state.size + target.x;

    if (this.powerups.some((powerup) => powerup.y * state.size + powerup.x === index)) {
      this.picked.add(index);
      this.powerups = this.powerups.filter((powerup) => powerup.y * state.size + powerup.x !== index);
      this.audioService.playSfx('acierto', { gain: 0.8 });
    }
  }

  /** Cada bomba explota a su hora del reloj comun (todas las pantallas a la vez), con su reaccion en cadena. */
  private updateExplosions(state: BombermanPublicState, now: number, serverNow: number): void {
    const due = this.bombs.filter((bomb) => bomb.explodeAt <= serverNow).sort((first, second) => first.explodeAt - second.explodeAt || first.id - second.id);

    for (const bomb of due) {
      if (this.exploded.has(bomb.id)) {
        continue;
      }

      const result = computeBlast(state.size, this.cells, this.bombs, [bomb.id]);
      result.detonated.forEach((id) => this.exploded.add(id));
      this.localBombs = this.localBombs.filter((item) => !result.detonated.includes(item.id));

      for (const index of result.stones) {
        this.cells[index] = '.';
        this.pendingStones.push({ index, at: bomb.explodeAt });
      }

      // Las mejoras alcanzadas se queman.
      for (const index of result.hit) {
        if (this.powerups.some((powerup) => powerup.y * state.size + powerup.x === index)) {
          this.burnt.push({ index, at: bomb.explodeAt });
        }
      }

      this.powerups = this.powerups.filter((powerup) => !result.hit.includes(powerup.y * state.size + powerup.x));
      this.showBlast(result.hit, result.shapes, result.stones, bomb.explodeAt, false);
      this.lethal.push({ hit: new Set(result.hit), at: bomb.explodeAt, until: now + LETHAL_MS });
      this.bombs = this.bombs.filter((item) => !result.detonated.includes(item.id));
    }

    if (due.length) {
      this.rebuildBombs();
    }
  }

  private showBlast(hit: number[], shapes: Map<number, FlameShape>, stones: number[], at: number, late: boolean): void {
    const now = performance.now();
    const startedAt = late ? now - Math.min(FLAME_MS * 0.5, Math.max(0, this.matchService.serverNow() - at)) : now;

    for (const index of hit) {
      this.flames.push({ index, shape: shapes.get(index) || 'center', startedAt });
    }

    for (const index of stones) {
      this.rubble.push({ index, startedAt });
    }

    this.audioService.playSfx('explosion', { gain: 0.55, rate: 1.1 + Math.random() * 0.2 });
  }

  /** Si mi personaje esta en una llama (mientras hace dano), he caido: lo decide esta pantalla, sin lag. */
  private checkDeath(state: BombermanPublicState, now: number): void {
    const position = this.position;

    if (!position || this.deathReported || this.dead() || !this.isPlayer() || state.stage !== 'playing') {
      return;
    }

    // La casilla en la que esta; y, durante la primera mitad de un paso, tambien la que esta dejando (aun se le
    // ve en ella): asi una llama al lado nunca "falla" por haber empezado a moverse justo antes.
    const cells = [position.y * state.size + position.x];

    if (now - this.stepStartedAt < STEP_MS / 2) {
      cells.push(this.from.y * state.size + this.from.x);
    }

    const fire = this.lethal.find((entry) => now < entry.until && cells.some((index) => entry.hit.has(index)));

    if (!fire) {
      return;
    }

    this.deathReported = true;
    this.dead.set(true);
    this.myDiedAt = now;
    this.held = [];
    this.touchDirection = null;
    this.audioService.playSfx('aplastar', { gain: 1, rate: 0.9 });
    const lobbyId = this.matchService.match()?.lobbyId;

    if (lobbyId) {
      void this.matchService.bombermanDead(lobbyId, fire.at);
    }
  }

  /* --------------------------------- Dibujo -------------------------------- */

  private frame(state: BombermanPublicState, now: number, serverNow: number): BoardFrame {
    const moves = this.matchService.bombermanMoves();
    const players: BoardPlayer[] = state.players.map((player) => {
      const mine = player.playerId === this.currentPlayerId;
      const color = getPlayerColor(this.matchService.playerColor(player.playerId)).body;
      const name = this.matchService.playerName(player.playerId);

      if (mine && this.position) {
        const progress = Math.min(1, (now - this.stepStartedAt) / STEP_MS);
        return {
          playerId: player.playerId,
          name,
          color,
          x: this.from.x + (this.position.x - this.from.x) * progress,
          y: this.from.y + (this.position.y - this.from.y) * progress,
          mine: true,
          alive: !this.dead(),
          diedAt: this.myDiedAt,
          moving: progress < 1,
        };
      }

      // Los demas se deslizan hasta la ultima casilla recibida (en lo que dura un paso).
      const live = moves[player.playerId];
      const target = live ? { x: live.x, y: live.y } : { x: player.x, y: player.y };
      let view = this.remotes.get(player.playerId);

      if (!view) {
        view = { fromX: target.x, fromY: target.y, toX: target.x, toY: target.y, startedAt: -Infinity, diedAt: null };
        this.remotes.set(player.playerId, view);
      }

      if (view.toX !== target.x || view.toY !== target.y) {
        const progress = Math.min(1, (now - view.startedAt) / STEP_MS);
        view.fromX = view.fromX + (view.toX - view.fromX) * progress;
        view.fromY = view.fromY + (view.toY - view.fromY) * progress;
        view.toX = target.x;
        view.toY = target.y;
        view.startedAt = now;
      }

      if (!player.alive && view.diedAt === null) {
        view.diedAt = now;
      }

      const progress = Math.min(1, (now - view.startedAt) / STEP_MS);
      return {
        playerId: player.playerId,
        name,
        color,
        x: view.fromX + (view.toX - view.fromX) * progress,
        y: view.fromY + (view.toY - view.fromY) * progress,
        mine: false,
        alive: player.alive,
        diedAt: view.diedAt,
        moving: progress < 1,
      };
    });

    const toLocal = (serverTime: number) => now + (serverTime - serverNow);
    return {
      size: state.size,
      cells: this.cells,
      bombs: this.bombs.map((bomb) => ({ x: bomb.x, y: bomb.y, explodeAt: toLocal(bomb.explodeAt), fuseMs: state.fuseMs })),
      flames: this.flames,
      powerups: this.powerups,
      rubble: this.rubble,
      players,
    };
  }

  private removeWhere<T>(list: T[], test: (item: T) => boolean): void {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (test(list[index])) {
        list.splice(index, 1);
      }
    }
  }

  private updateInsets(): void {
    if (!this.board || this.destroyed) {
      return;
    }

    const root = this.rootRef().nativeElement.getBoundingClientRect();
    const top = this.topBarRef().nativeElement.getBoundingClientRect();
    const controls = this.controlsRef()?.nativeElement.getBoundingClientRect();
    // En vertical (movil) los mandos van debajo del tablero; en horizontal, a los lados.
    const portrait = root.height > root.width;
    const bottom = portrait && controls?.height ? root.bottom - controls.top + 8 : 12;
    this.board.setInsets({ top: Math.max(0, top.bottom - root.top + 8), right: 12, bottom, left: 12 });
  }
}
