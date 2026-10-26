import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { CarsPlayerView, CarsScene, CarsSceneState } from './cars-scene';

@Component({
  selector: 'app-cars',
  imports: [PlayerAvatarComponent],
  templateUrl: './cars.component.html',
  styleUrl: './cars.component.scss',
})
export class CarsComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private scene?: CarsScene;
  private insetObserver?: ResizeObserver;
  private engineTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private lastStageKey = '';

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.cars || null);
  readonly unsupported = signal(false);
  /** Carril elegido por este jugador: se marca (y su Mii echa a andar) al instante. */
  readonly localPick = signal<{ round: number; lane: number } | null>(null);
  readonly laneNumbers = [0, 1, 2, 3];

  readonly chooseTimer = this.timerService.countdown(() => (this.state()?.stage === 'choosing' ? this.state()?.chooseEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly alive = computed(() => Boolean(this.state()?.alive.includes(this.currentPlayerId)));
  readonly canChoose = computed(() => this.state()?.stage === 'choosing' && this.alive());
  readonly myLane = computed(() => {
    const state = this.state();
    const pick = this.localPick();

    if (pick && pick.round === state?.round && state?.stage === 'choosing') {
      return pick.lane;
    }

    return state?.choices.find((choice) => choice.playerId === this.currentPlayerId)?.lane ?? null;
  });
  readonly laneCounts = computed(() => {
    const counts = [0, 0, 0, 0];

    for (const choice of this.choicesWithLocal()) {
      counts[choice.lane] += 1;
    }

    return counts;
  });
  readonly players = computed<CarsPlayerView[]>(() =>
    (this.state()?.sides || []).map((seat) => ({
      playerId: seat.playerId,
      name: this.matchService.playerName(seat.playerId),
      avatarUrl: this.matchService.playerAvatar(seat.playerId),
      shirt: getPlayerColor(this.matchService.playerColor(seat.playerId)).body,
    })),
  );
  readonly nameTags = computed(() =>
    (this.state()?.sides || [])
      .filter((seat) => this.state()?.alive.includes(seat.playerId) || this.state()?.hits.includes(seat.playerId))
      .map((seat) => ({ playerId: seat.playerId, name: this.matchService.playerName(seat.playerId), mine: seat.playerId === this.currentPlayerId })),
  );

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state) {
      return 'Preparando la carretera…';
    }

    if (!this.alive() && !state.hits.includes(this.currentPlayerId)) {
      return 'Te han atropellado: miras cómo siguen los demás.';
    }

    switch (state.stage) {
      case 'choosing':
        return this.myLane() === null ? 'Elige un carril (pulsa en la carretera o en los botones).' : `Vas al carril ${(this.myLane() || 0) + 1}. Puedes cambiar hasta que acabe el tiempo.`;
      case 'waiting':
        return 'Silencio… algo se acerca.';
      case 'passing':
        return state.round <= 2 ? '¡Viene un coche!' : '¡Vienen dos coches!';
      case 'aftermath':
        return state.hits.includes(this.currentPlayerId) ? '¡Te han atropellado!' : state.hits.length ? '¡Uf! Te has salvado.' : '¡Nadie atropellado!';
      case 'returning':
        return 'Los supervivientes vuelven a la acera.';
      default:
        return 'Fin de la carretera.';
    }
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((entry) => ({
      ...entry,
      avatarUrl: this.matchService.playerAvatar(entry.playerId),
      colorId: this.matchService.playerColor(entry.playerId),
      mine: entry.playerId === this.currentPlayerId,
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

      if (!state) {
        return;
      }

      const key = `${state.round}:${state.stage}`;

      if (key !== this.lastStageKey) {
        this.lastStageKey = key;
        untracked(() => this.playStageSound(state.stage, state.passStartsAt, state.driveMs));
      }
    });

    effect(() => {
      this.canChoose();
      this.state()?.stage;
      untracked(() => queueMicrotask(() => this.updateInsets()));
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
      this.scene = new CarsScene(
        THREE,
        this.canvasRef().nativeElement,
        this.rootRef().nativeElement,
        this.labelsRef().nativeElement,
        this.players(),
        initial,
        environment.apiUrl,
      );
    } catch {
      this.unsupported.set(true);
      return;
    }

    this.scene.onLanePicked = (lane) => this.choose(lane);
    this.scene.onHit = () => this.audioService.playSfx('atropello');
    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.rootRef(), this.topBarRef(), this.dockRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.updateInsets();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.engineTimer);
    this.insetObserver?.disconnect();
    this.scene?.dispose();
    this.scene = undefined;
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const lane = Number(event.key) - 1;

    if (Number.isInteger(lane) && lane >= 0 && lane < 4) {
      this.choose(lane);
    }
  }

  choose(lane: number): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canChoose() || this.myLane() === lane) {
      return;
    }

    this.localPick.set({ round: state.round, lane });
    // Saltito al cambiar de carril (un poco distinto en cada carril).
    this.audioService.playSfx('salto-carril', { rate: 0.9 + lane * 0.07 });
    void this.matchService.chooseLane(lobbyId, state.round, lane);
  }

  /** Lo elegido por cada jugador, con la eleccion local aplicada ya aunque el servidor aun no la haya devuelto. */
  private choicesWithLocal(): Array<{ playerId: string; lane: number }> {
    const state = this.state();
    const choices = (state?.choices || []).filter((choice) => choice.playerId !== this.currentPlayerId || state?.stage !== 'choosing');
    const mine = this.myLane();

    if (state?.stage === 'choosing' && mine !== null && this.alive()) {
      const serverIndex = (state.choices || []).findIndex((choice) => choice.playerId === this.currentPlayerId);
      const entry = { playerId: this.currentPlayerId, lane: mine };
      choices.splice(serverIndex >= 0 ? serverIndex : choices.length, 0, entry);
    }

    return choices;
  }

  private playStageSound(stage: string, passStartsAt: number | null, driveMs: number): void {
    clearTimeout(this.engineTimer);

    if (stage === 'choosing') {
      this.audioService.playEffect('turn');
    } else if (stage === 'passing') {
      // Claxon y, cuando arranca el coche, el motor (sube y baja con el paso del coche).
      this.audioService.playEffect('horn');
      const delay = passStartsAt ? Math.max(0, passStartsAt - this.matchService.serverNow()) : 600;
      this.engineTimer = setTimeout(() => this.audioService.playEngine(driveMs), delay);
    } else if (stage === 'aftermath') {
      // Superar la ronda suena a victoria; si te atropellan ya suena el golpe (sin sonido de derrota).
      const state = this.state();

      if (state && !state.hits.includes(this.currentPlayerId) && state.alive.includes(this.currentPlayerId)) {
        this.audioService.playFileEffect('win');
      }
    } else if (stage === 'finished') {
      this.audioService.playEffect('points');
    }
  }

  private sceneState(): CarsSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    return {
      round: state.round,
      stage: state.stage,
      sides: state.sides,
      alive: state.alive,
      choices: this.choicesWithLocal(),
      carLanes: state.carLanes,
      // Hora del servidor en la que arranca el coche, en el reloj local de animacion.
      passStartsAt: state.passStartsAt ? performance.now() + (state.passStartsAt - this.matchService.serverNow()) : null,
      driveMs: state.driveMs,
    };
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
