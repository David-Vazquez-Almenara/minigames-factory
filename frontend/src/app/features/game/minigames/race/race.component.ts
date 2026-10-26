import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { RacePublicState } from '../../../../core/services/socket.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { BoardCar, RaceBoard } from './race-board';
import { CarState, carProgress, createCar, stepCar } from './race-physics';
import { RACE_LAPS, TRACKS, Track, buildTrack, gridSlot } from './race-tracks';

// Cada cuanto se envia la posicion propia y con cuanto retraso se dibuja a los demas (para que se muevan suaves).
const SEND_MS = 100;
const INTERPOLATION_MS = 120;
const SPECTATE_DELAY_MS = 2000;

type Control = 'left' | 'right' | 'gas' | 'brake';
const KEYS: Record<string, Control> = {
  ArrowUp: 'gas',
  KeyW: 'gas',
  ArrowDown: 'brake',
  KeyS: 'brake',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};

@Component({
  selector: 'app-race',
  imports: [PlayerAvatarComponent],
  templateUrl: './race.component.html',
  styleUrl: './race.component.scss',
})
export class RaceComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly minimapRef = viewChild.required<ElementRef<HTMLCanvasElement>>('minimap');
  private board?: RaceBoard;
  private track?: Track;
  private car?: CarState;
  private frameHandle = 0;
  private lastFrame = performance.now();
  private lastSentAt = 0;
  private sendSeq = 0;
  private destroyed = false;
  private announcedFinal = false;
  private readonly held = new Set<Control>();
  private readonly touchHeld = new Set<Control>();
  private spectateTimer = 0;
  private flashTimer = 0;
  private lastCountdown = '';

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.race || null);
  readonly trackName = computed(() => TRACKS.find((track) => track.id === this.state()?.mapId)?.name || '');
  readonly startTimer = this.timerService.countdown(() => this.state()?.startsAt);
  readonly limitTimer = this.timerService.countdown(() => (this.state()?.stage === 'racing' ? this.state()?.endsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
  });

  /* ------------------------------ Mi carrera ------------------------------- */
  readonly lap = signal(1);
  readonly finishedMs = signal<number | null>(null);
  readonly wrongWay = signal(false);
  readonly respawning = signal(false);
  readonly elapsedMs = signal(0);
  readonly speedKmh = signal(0);
  /** Posicion en directo (1 = primero). */
  readonly place = signal(1);
  readonly lapFlash = signal<string | null>(null);
  /** Siguiente punto de control (desde 0) y cuantos hay por vuelta. */
  readonly checkpoint = signal(0);
  readonly checkpointCount = signal(0);
  /** Se ha dejado atras el punto de control que tocaba: hay que volver a por el (su numero, desde 1). */
  readonly missedCheckpoint = signal<number | null>(null);

  /* ------------------------------ Espectador ------------------------------- */
  readonly spectateId = signal<string | null>(null);

  readonly me = computed(() => this.state()?.players.find((player) => player.playerId === this.currentPlayerId) || null);
  readonly isPlayer = computed(() => Boolean(this.me()));
  readonly started = computed(() => Boolean(this.state()) && this.startTimer.remainingMs() <= 0);
  readonly racing = computed(() => this.isPlayer() && this.started() && this.finishedMs() === null && this.state()?.stage === 'racing');
  /** Fuera de carrera (meta o sin jugar): se puede ver a los que siguen corriendo. */
  readonly spectating = computed(() => this.state()?.stage === 'racing' && this.started() && (!this.isPlayer() || this.finishedMs() !== null));
  readonly racingOthers = computed(() =>
    (this.state()?.players || []).filter((player) => player.playerId !== this.currentPlayerId && player.finishMs === null).map((player) => player.playerId),
  );
  readonly spectateName = computed(() => this.matchService.playerName(this.spectateId()));
  /** Semaforo de salida: 3 luces rojas que se encienden y, al final, verde. */
  readonly lights = computed(() => {
    const remaining = this.startTimer.remainingMs();

    if (!this.state() || remaining > 3000 || (remaining <= 0 && this.elapsedMs() > 1200)) {
      return null;
    }

    // 3 s: una roja; 2 s: dos; 1 s: tres; y verdes al salir.
    return { lit: remaining > 0 ? Math.min(3, 4 - Math.ceil(remaining / 1000)) : 3, go: remaining <= 0 };
  });
  readonly totalPlayers = computed(() => this.state()?.players.length || 0);

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      timeText: row.finished && row.timeMs !== null ? this.formatTime(row.timeMs) : 'No terminó',
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
    })),
  );

  constructor() {
    effect(() => {
      const state = this.state();

      if (state) {
        untracked(() => this.ensureTrack(state));
      }
    });

    effect(() => {
      // Espectador: al llegar a la meta, 2 s despues pasa a ver a otro que siga corriendo (y si ese llega, a otro).
      const out = this.spectating();
      const candidates = this.racingOthers();
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
          current === null && !this.isPlayer() ? 0 : SPECTATE_DELAY_MS,
        );
      });
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && mine.finished) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  ngAfterViewInit(): void {
    const state = this.state();

    if (state) {
      this.ensureTrack(state);
    }

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
    clearTimeout(this.spectateTimer);
    cancelAnimationFrame(this.frameHandle);
    this.board?.dispose();
  }

  /* --------------------------------- Mandos --------------------------------- */

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const control = KEYS[event.code];

    if (!control) {
      return;
    }

    event.preventDefault();

    // Espectando, izquierda y derecha cambian de coche.
    if (this.spectating() && (control === 'left' || control === 'right')) {
      if (!event.repeat) {
        this.cycleSpectate(control === 'right' ? 1 : -1);
      }

      return;
    }

    this.held.add(control);
  }

  @HostListener('window:keyup', ['$event'])
  onKeyup(event: KeyboardEvent): void {
    const control = KEYS[event.code];

    if (control) {
      this.held.delete(control);
    }
  }

  @HostListener('window:blur')
  onBlur(): void {
    this.held.clear();
    this.touchHeld.clear();
  }

  press(control: Control, event: Event): void {
    event.preventDefault();
    this.touchHeld.add(control);
  }

  release(control: Control): void {
    this.touchHeld.delete(control);
  }

  cycleSpectate(step: 1 | -1): void {
    const candidates = this.racingOthers();

    if (!candidates.length) {
      return;
    }

    clearTimeout(this.spectateTimer);
    this.spectateTimer = 0;
    const index = candidates.indexOf(this.spectateId() || '');
    const next = index < 0 ? (step > 0 ? 0 : candidates.length - 1) : (index + step + candidates.length) % candidates.length;
    this.spectateId.set(candidates[next]);
  }

  formatTime(ms: number): string {
    const total = Math.max(0, ms) / 1000;
    const minutes = Math.floor(total / 60);
    const seconds = total - minutes * 60;
    return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
  }

  /* --------------------------------- Bucle --------------------------------- */

  private ensureTrack(state: RacePublicState): void {
    if (this.track || !this.canvasRef()) {
      return;
    }

    const definition = TRACKS.find((track) => track.id === state.mapId) || TRACKS[0];
    this.track = buildTrack(definition);
    this.checkpointCount.set(this.track.checkpoints.length);
    this.board = new RaceBoard(this.canvasRef().nativeElement, this.rootRef().nativeElement, this.track);

    for (const player of state.players) {
      this.board.setAvatar(player.playerId, this.matchService.playerAvatar(player.playerId));
    }

    const me = state.players.find((player) => player.playerId === this.currentPlayerId);

    if (me) {
      const slot = gridSlot(this.track, me.slot);
      this.car = createCar(this.track, slot.x, slot.y, slot.angle, slot.index);

      // Si se recarga la pagina a mitad de carrera, se sigue desde donde iba.
      if (me.x !== null && me.y !== null && me.progress > 0) {
        Object.assign(this.car, { x: me.x, y: me.y, angle: me.a });
        const lapDistance = ((me.progress % this.track.length) + this.track.length) % this.track.length;
        this.car.index = me.index ?? this.indexAt(lapDistance);
        this.car.lap = Math.floor(me.progress / this.track.length);
        this.car.checkpoint = Math.min(me.checkpoint || 0, this.track.checkpoints.length);
        this.checkpoint.set(this.car.checkpoint);
        this.lap.set(Math.max(1, Math.min(RACE_LAPS, this.car.lap + 1)));
      }

      if (me.finishMs !== null) {
        this.car.finished = true;
        this.finishedMs.set(me.finishMs);
      }
    }
  }

  private tick(): void {
    const state = this.state();
    const track = this.track;

    if (!state || !track || !this.board) {
      return;
    }

    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const serverNow = this.matchService.serverNow();
    this.elapsedMs.set(Math.max(0, serverNow - state.startsAt));
    this.countdownSounds();
    const car = this.car;

    if (car && this.racing() && !this.matchService.hostPaused()) {
      const controls = new Set([...this.held, ...this.touchHeld]);
      const events = stepCar(track, car, { throttle: controls.has('gas'), brake: controls.has('brake'), steer: (controls.has('right') ? 1 : 0) - (controls.has('left') ? 1 : 0) }, dt);
      this.wrongWay.set(events.wrongWay);
      this.respawning.set(car.offRoadMs > 600);
      this.speedKmh.set(Math.round(Math.abs(car.speed) * 0.3));

      if (events.lap !== undefined && events.lap >= 0) {
        this.lap.set(Math.min(RACE_LAPS, events.lap + 1));

        if (events.lap > 0) {
          this.showFlash(events.lap + 1 === RACE_LAPS ? '¡Última vuelta!' : `Vuelta ${events.lap + 1}`);
          this.audioService.playSfx('acierto', { gain: 0.7 });
        }
      }

      if (events.checkpoint !== undefined) {
        this.audioService.playSfx('voto', { gain: 0.6, rate: 1.25 });
      }

      if (events.lapRejected) {
        this.showFlash('¡Te faltan puntos de control!');
        this.audioService.playSfx('error');
      } else if (events.missedCheckpoint !== undefined && this.missedCheckpoint() === null) {
        this.audioService.playSfx('error');
      }

      this.checkpoint.set(car.checkpoint);
      // Si el punto de control que toca se ha quedado atras (atajo o saltado), se avisa hasta que se vuelve a por el.
      const pending = car.lap >= 0 && car.checkpoint < track.checkpoints.length ? track.checkpoints[car.checkpoint] : -1;
      this.missedCheckpoint.set(pending >= 0 && track.distances[car.index] > track.distances[pending] + track.width ? car.checkpoint + 1 : null);

      if (events.finished) {
        this.crossFinish(serverNow - state.startsAt);
      }

      if (now - this.lastSentAt >= SEND_MS) {
        this.lastSentAt = now;
        this.sendSeq += 1;
        const lobbyId = this.matchService.match()?.lobbyId;

        if (lobbyId) {
          this.matchService.racePosition(lobbyId, car.x, car.y, car.angle, carProgress(track, car), car.index, car.checkpoint, this.sendSeq);
        }
      }
    }

    const cars = this.cars(state, track, now);
    this.updatePlace(state, track, cars);
    const followId = this.spectating() ? this.spectateId() : this.currentPlayerId;
    const followed = cars.find((item) => item.playerId === followId) || cars.find((item) => item.mine) || cars[0];

    if (followed) {
      // Puntos de control resaltados segun por cual vaya uno mismo (viendo a otro, todos iguales).
      const next = followed.mine && this.car && this.finishedMs() === null ? this.car.checkpoint : null;
      this.board.draw(cars, followed, dt, { next, guide: this.missedCheckpoint() !== null });
      this.board.drawMinimap(this.minimapRef().nativeElement, cars, followId, next);
    }
  }

  private showFlash(text: string): void {
    clearTimeout(this.flashTimer);
    this.lapFlash.set(text);
    this.flashTimer = window.setTimeout(() => !this.destroyed && this.lapFlash.set(null), 1800);
  }

  /** Meta en la ultima vuelta: el tiempo lo mide esta pantalla (reloj comun desde la salida). */
  private crossFinish(timeMs: number): void {
    this.finishedMs.set(timeMs);
    this.audioService.playSfx('yuju');
    this.held.clear();
    this.touchHeld.clear();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (lobbyId) {
      void this.matchService.raceFinish(lobbyId, Math.round(timeMs));
    }
  }

  private countdownSounds(): void {
    const remaining = this.startTimer.remainingMs();
    const label = remaining > 0 && remaining <= 3000 ? String(Math.ceil(remaining / 1000)) : remaining <= 0 && this.elapsedMs() < 500 ? 'go' : '';

    if (label && label !== this.lastCountdown) {
      this.lastCountdown = label;
      this.audioService.playSfx('tic', { rate: label === 'go' ? 2 : 1 });
    }
  }

  /** Coches que se dibujan: el propio (aqui al momento) y los demas, 120 ms por detras, entre dos posiciones recibidas. */
  private cars(state: RacePublicState, track: Track, now: number): Array<BoardCar & { progress: number }> {
    const samples = this.matchService.raceSamples();
    const renderAt = now - INTERPOLATION_MS;

    return state.players.map((player) => {
      const color = getPlayerColor(this.matchService.playerColor(player.playerId)).body;
      const name = this.matchService.playerName(player.playerId);
      const finished = player.finishMs !== null;

      if (player.playerId === this.currentPlayerId && this.car) {
        return {
          playerId: player.playerId,
          name,
          color,
          x: this.car.x,
          y: this.car.y,
          angle: this.car.angle,
          mine: true,
          upper: Boolean(track.upper[this.car.index]),
          finished: this.finishedMs() !== null,
          progress: carProgress(track, this.car),
        };
      }

      const list = samples[player.playerId] || [];
      let x: number;
      let y: number;
      let angle: number;
      let progress: number;
      // Punto de la linea central en el que va (lo manda el propio coche): decide si se pinta encima o debajo de un puente.
      let index: number | null = player.index;

      if (list.length) {
        let older = list[0];
        let newer = list[list.length - 1];

        for (let index = 0; index < list.length - 1; index += 1) {
          if (list[index].at <= renderAt && list[index + 1].at >= renderAt) {
            older = list[index];
            newer = list[index + 1];
          }
        }

        const t = newer.at === older.at ? 1 : Math.max(0, Math.min(1, (renderAt - older.at) / (newer.at - older.at)));
        let turn = newer.a - older.a;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        x = older.x + (newer.x - older.x) * t;
        y = older.y + (newer.y - older.y) * t;
        angle = older.a + turn * t;
        progress = older.p + (newer.p - older.p) * t;
        index = (t < 0.5 ? older.i : newer.i) ?? index;
      } else if (player.x !== null && player.y !== null) {
        ({ x, y } = { x: player.x, y: player.y });
        angle = player.a;
        progress = player.progress;
      } else {
        const slot = gridSlot(track, player.slot);
        ({ x, y, angle } = slot);
        progress = -(track.length - track.distances[slot.index]);
        index = slot.index;
      }

      const lapDistance = ((progress % track.length) + track.length) % track.length;
      const upper = Boolean(track.upper[index !== null && index < track.xs.length ? index : this.indexAt(lapDistance)]);
      return { playerId: player.playerId, name, color, x, y, angle, mine: false, upper, finished, progress };
    });
  }

  /** Posicion en directo: los que ya han llegado (por tiempo) y despues por lo recorrido. */
  private updatePlace(state: RacePublicState, _track: Track, cars: Array<BoardCar & { progress?: number }>): void {
    const myFinish = this.finishedMs();
    const entries = state.players.map((player) => {
      const car = cars.find((item) => item.playerId === player.playerId);
      const finishMs = player.playerId === this.currentPlayerId ? myFinish : player.finishMs;
      return { playerId: player.playerId, finishMs, progress: car?.progress ?? player.progress };
    });
    entries.sort((first, second) => {
      if (first.finishMs !== null || second.finishMs !== null) {
        return (first.finishMs ?? Infinity) - (second.finishMs ?? Infinity);
      }

      return second.progress - first.progress;
    });
    this.place.set(entries.findIndex((entry) => entry.playerId === this.currentPlayerId) + 1 || 1);
  }

  /** Indice de la linea central para una distancia dentro de la vuelta (busqueda binaria). */
  private indexAt(distance: number): number {
    const distances = this.track!.distances;
    let low = 0;
    let high = distances.length - 1;

    while (low < high) {
      const middle = (low + high + 1) >> 1;

      if (distances[middle] <= distance) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    return low;
  }
}
