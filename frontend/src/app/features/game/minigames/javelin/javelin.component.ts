import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { JavelinBoard, JavelinShot, JavelinThrower } from './javelin-board';
import { JAVELIN_MAPS, JavelinFlight, roundShot, simulateJavelin } from './javelin-course';

/** Metros que abarca la barra de arriba (mini mapa). */
const TRACK_METERS = 75;

@Component({
  selector: 'app-javelin',
  imports: [PlayerAvatarComponent],
  templateUrl: './javelin.component.html',
  styleUrl: './javelin.component.scss',
})
export class JavelinComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly hostRef = viewChild.required<ElementRef<HTMLElement>>('playfield');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private board?: JavelinBoard;
  private insetObserver?: ResizeObserver;
  private readonly images = new Map<string, HTMLImageElement>();
  /** Vuelos ya calculados (por jugador e indice), con su instante de salida en este reloj. */
  private readonly flights = new Map<string, { flight: JavelinFlight; startedAt: number }>();
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.javelin || null);
  readonly map = computed(() => JAVELIN_MAPS[this.state()?.map ?? 0]);
  /** Tiros propios: se simulan y vuelan al momento, sin esperar al servidor. */
  readonly myThrows = signal<Array<{ flight: JavelinFlight; startedAt: number }>>([]);
  /** Reloj local para saber cuando ha caido la jabalina propia. */
  private readonly now = signal(performance.now());
  private clockHandle = 0;

  readonly startTimer = this.timerService.countdown(() => this.state()?.startsAt);
  readonly playTimer = this.timerService.countdown(() => (this.state()?.stage === 'throwing' ? this.state()?.endsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 40000,
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly throwsPerPlayer = computed(() => this.state()?.throwsPerPlayer ?? 3);
  /** Tiros propios contando los que ya conoce el servidor (por si se recarga la pagina). */
  readonly myThrowCount = computed(() =>
    Math.max(this.myThrows().length, (this.state()?.throws || []).filter((entry) => entry.playerId === this.currentPlayerId).length),
  );
  readonly throwsLeft = computed(() => Math.max(0, this.throwsPerPlayer() - this.myThrowCount()));
  /** La jabalina propia aun vuela (no se puede lanzar otra hasta que caiga). */
  readonly myFlying = computed(() => {
    const last = this.myThrows().at(-1);
    return Boolean(last && this.now() < last.startedAt + last.flight.time * 1000 + 300);
  });
  readonly canThrow = computed(
    () =>
      this.isPlayer() &&
      this.state()?.stage === 'throwing' &&
      this.startTimer.remainingMs() <= 0 &&
      this.playTimer.remainingMs() > 0 &&
      this.throwsLeft() > 0 &&
      !this.myFlying(),
  );

  /** Ya no me quedan jabalinas (y la ultima ha caido): la camara se abre para ver lanzar al resto. */
  readonly spectating = computed(
    () => this.state()?.stage === 'throwing' && this.startTimer.remainingMs() <= 0 && (!this.isPlayer() || (this.throwsLeft() === 0 && !this.myFlying())),
  );

  /** Distancias a la bandera de mis jabalinas (las que ya han caido). */
  readonly myDistances = computed(() => {
    const flagX = this.state()?.flagX ?? 0;
    return this.myThrows()
      .filter((entry) => this.now() >= entry.startedAt + entry.flight.time * 1000)
      .map((entry) => Math.abs(entry.flight.landX - flagX));
  });
  readonly myBest = computed(() => {
    const distances = this.myDistances();
    const server = (this.state()?.throws || []).filter((entry) => entry.playerId === this.currentPlayerId).map((entry) => entry.distance);
    const all = distances.length >= server.length ? distances : server;
    return all.length ? Math.min(...all) : null;
  });

  /** Mini mapa de arriba: bandera, jabalinas de los demas (semitransparentes) y las mias (blancas). */
  readonly track = computed(() => {
    const state = this.state();
    const now = this.now();
    const toPercent = (x: number) => Math.max(0, Math.min(100, (x / TRACK_METERS) * 100));
    const others = (state?.throws || [])
      .filter((entry) => entry.playerId !== this.currentPlayerId)
      .map((entry) => ({ key: `${entry.playerId}:${entry.index}`, left: toPercent(entry.landX), color: getPlayerColor(this.matchService.playerColor(entry.playerId)).body }));
    const mine = this.myThrows()
      .filter((entry) => now >= entry.startedAt + entry.flight.time * 1000)
      .map((entry, index) => ({ key: `me:${index}`, left: toPercent(entry.flight.landX) }));
    return { flag: toPercent(state?.flagX ?? 0), others, mine, marks: [10, 20, 30, 40, 50, 60, 70].map((meters) => ({ meters, left: toPercent(meters) })) };
  });

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state || state.stage === 'finished') {
      return 'Fin del tiro de jabalina.';
    }

    if (state.stage === 'zoom') {
      return '¡Veamos quién ha quedado más cerca!';
    }

    if (this.startTimer.remainingMs() > 0) {
      return `Mira arriba dónde está la bandera (a ${state.flagX.toLocaleString('es-ES')} m)…`;
    }

    if (!this.isPlayer()) {
      return 'Mira cómo lanzan los demás.';
    }

    const best = this.myBest();
    const bestText = best === null ? '' : ` Tu mejor: a ${this.formatMeters(best)} de la bandera.`;

    if (this.myFlying()) {
      return '¡Allá va!';
    }

    if (this.throwsLeft() === 0) {
      return `Ya has lanzado tus 3 jabalinas.${bestText}`;
    }

    if (this.playTimer.remainingMs() <= 0) {
      return `¡Tiempo!${bestText}`;
    }

    return `Arrastra hacia atrás y suelta para lanzar.${bestText}`;
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      text: row.distance === null ? 'No lanzó' : `a ${this.formatMeters(row.distance)}`,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
    })),
  );

  constructor() {
    effect(() => {
      const state = this.state();
      const map = this.map();

      if (state) {
        untracked(() => this.board?.setCourse(map, state.flagX));
      }
    });

    effect(() => {
      const shots = this.shots();
      untracked(() => this.board?.setShots(shots));
    });

    effect(() => {
      const throwers = this.throwers();
      untracked(() => this.board?.setThrowers(throwers));
    });

    effect(() => {
      const aiming = this.canThrow();
      untracked(() => this.board?.setAiming(aiming));
    });

    effect(() => {
      const stage = this.state()?.stage;
      untracked(() => this.board?.setZoomOut(stage === 'zoom' || stage === 'finished'));
    });

    effect(() => {
      const spectate = this.spectating();
      untracked(() => this.board?.setSpectate(spectate));
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && mine.distance !== null) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  ngAfterViewInit(): void {
    const state = this.state();
    this.board = new JavelinBoard(this.canvasRef().nativeElement, this.hostRef().nativeElement, this.map());
    this.board.setCourse(this.map(), state?.flagX ?? 30);
    this.board.onThrow = (angle, power) => this.throwJavelin(angle, power);
    this.board.onLand = (shot) => {
      this.audioService.playSfx('clavar', { gain: shot.mine ? 1 : 0.4, rate: 0.9 + Math.random() * 0.2 });
    };
    this.board.setThrowers(this.throwers());
    this.board.setShots(this.shots());
    this.board.setAiming(this.canThrow());
    this.board.setZoomOut(state?.stage === 'zoom' || state?.stage === 'finished');
    this.board.setSpectate(this.spectating());
    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.hostRef(), this.topBarRef(), this.dockRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.updateInsets();
    const tick = () => {
      this.now.set(performance.now());
      this.clockHandle = window.setTimeout(tick, 100);
    };
    tick();
  }

  ngOnDestroy(): void {
    clearTimeout(this.clockHandle);
    this.insetObserver?.disconnect();
    this.board?.dispose();
    this.board = undefined;
  }

  formatMeters(meters: number): string {
    return `${meters.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`;
  }

  /** Lanzamiento propio: se simula aqui (fisica determinista) y vuela al instante; despues se envia el tiro. */
  private throwJavelin(rawAngle: number, rawPower: number): void {
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!lobbyId || !this.canThrow()) {
      return;
    }

    const angle = roundShot(rawAngle);
    const power = roundShot(rawPower);
    const flight = simulateJavelin(this.map(), angle, power);
    this.myThrows.update((throws) => [...throws, { flight, startedAt: performance.now() }]);
    this.now.set(performance.now());
    this.audioService.playSfx('lanzar', { rate: 0.9 + power * 0.3 });
    void this.matchService.javelinThrow(lobbyId, { angle, power, landX: flight.landX });
  }

  /** Personajes en la linea de lanzamiento. */
  private throwers(): JavelinThrower[] {
    return (this.matchService.match()?.specialRound?.participantIds || []).map((playerId) => ({
      playerId,
      mine: playerId === this.currentPlayerId,
      color: getPlayerColor(this.matchService.playerColor(playerId)).body,
      image: this.imageFor(playerId),
    }));
  }

  /** Jabalinas que se ven: las propias (al momento) y las de los demas (en cuanto llega su tiro). */
  private shots(): JavelinShot[] {
    const state = this.state();

    if (!state) {
      return [];
    }

    const map = this.map();
    const toLocal = (serverTime: number) => performance.now() + (serverTime - this.matchService.serverNow());
    const mine = this.myThrows();
    const shots: JavelinShot[] = mine.map((entry, index) => ({
      key: `me:${index}`,
      playerId: this.currentPlayerId,
      mine: true,
      color: getPlayerColor(this.matchService.playerColor(this.currentPlayerId)).body,
      image: this.imageFor(this.currentPlayerId),
      flight: entry.flight,
      startedAt: entry.startedAt,
    }));

    for (const entry of state.throws) {
      const isMine = entry.playerId === this.currentPlayerId;

      // Las propias ya estan (salvo que se haya recargado la pagina y solo las conozca el servidor).
      if (isMine && entry.index < mine.length) {
        continue;
      }

      const key = `${entry.playerId}:${entry.index}`;
      let known = this.flights.get(key);

      if (!known) {
        // Misma fisica que en su pantalla: con su angulo y su fuerza, la jabalina cae en el mismo sitio.
        known = { flight: simulateJavelin(map, entry.angle, entry.power), startedAt: Math.min(performance.now(), toLocal(entry.at)) };
        this.flights.set(key, known);
      }

      shots.push({
        key,
        playerId: entry.playerId,
        mine: isMine,
        color: getPlayerColor(this.matchService.playerColor(entry.playerId)).body,
        image: this.imageFor(entry.playerId),
        flight: known.flight,
        startedAt: known.startedAt,
      });
    }

    return shots;
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
    this.board?.setInsets(Math.max(0, top.bottom - host.top + 8), dock.height ? Math.max(0, host.bottom - dock.top + 8) : 12);
  }
}
