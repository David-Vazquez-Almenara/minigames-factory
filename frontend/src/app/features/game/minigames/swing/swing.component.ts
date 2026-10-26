import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { swingAngleAt, swingLaunch } from './swing-physics';
import { SwingPlayerView, SwingScene, SwingSceneState } from './swing-scene';

/** "31,51" con coma decimal. */
function meters(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

@Component({
  selector: 'app-swing',
  imports: [PlayerAvatarComponent],
  templateUrl: './swing.component.html',
  styleUrl: './swing.component.scss',
})
export class SwingComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private scene?: SwingScene;
  private destroyed = false;
  /** Instante local en que se solto cada jugador (el propio, al pulsar; el resto, al llegar su salto). */
  private readonly flightStarts = new Map<string, number>();
  private announcedTurn = -1;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.swing || null);
  readonly unsupported = signal(false);
  /** Salto propio calculado aqui al soltarse (antes de que lo confirme el servidor). */
  readonly myJump = signal<{ turnIndex: number; angle: number; dir: 1 | -1; distance: number } | null>(null);

  readonly turnTimer = this.timerService.countdown(() => (this.state()?.stage === 'swinging' ? this.state()?.swingEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 10000,
    onExpire: () => this.release(),
  });

  readonly isMyTurn = computed(() => this.state()?.currentPlayerId === this.currentPlayerId && this.state()?.stage !== 'finished');
  readonly canRelease = computed(() => this.isMyTurn() && this.state()?.stage === 'swinging' && this.myJump()?.turnIndex !== this.state()?.turnIndex);
  readonly currentName = computed(() => this.matchService.playerName(this.state()?.currentPlayerId));

  readonly views = computed<SwingPlayerView[]>(() =>
    (this.state()?.order || []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
      isLocal: playerId === this.currentPlayerId,
    })),
  );

  /** Distancias conocidas (incluida la propia en cuanto se suelta). */
  readonly distances = computed(() => {
    const map = new Map((this.state()?.jumps || []).map((jump) => [jump.playerId, jump.distance]));
    const mine = this.myJump();

    if (mine && !map.has(this.currentPlayerId)) {
      map.set(this.currentPlayerId, mine.distance);
    }

    return map;
  });

  readonly tags = computed(() =>
    this.views().map((view) => {
      const distance = this.distances().get(view.playerId);
      return { ...view, detail: distance === undefined ? '' : `${meters(distance)} m`, negative: (distance ?? 0) < 0 };
    }),
  );

  /** Barra superior de distancias (como la de la carrera en pogo): el arbol en 0 y cada jugador donde ha caido. */
  readonly track = computed(() => {
    const values = [...this.distances().values()];
    const min = Math.min(-10, ...values) - 2;
    const max = Math.max(35, ...values) + 2;
    const at = (value: number) => ((value - min) / (max - min)) * 100;
    return {
      zero: at(0),
      marks: [...this.distances().entries()].map(([playerId, distance]) => ({
        playerId,
        left: at(distance),
        negative: distance < 0,
        mine: playerId === this.currentPlayerId,
        name: this.matchService.playerName(playerId),
        avatarUrl: this.matchService.playerAvatar(playerId),
        colorId: this.matchService.playerColor(playerId),
      })),
    };
  });

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state) {
      return 'Preparando el árbol…';
    }

    if (state.stage === 'finished') {
      return 'Fin de los saltos.';
    }

    const turn = `${state.turnIndex + 1}/${state.order.length}`;

    if (this.isMyTurn()) {
      if (state.stage === 'walking') {
        return `¡Te toca! (${turn}) Agárrate a la cuerda…`;
      }

      if (state.stage === 'swinging' && this.canRelease()) {
        return `¡Suéltate en el momento justo! (${turn})`;
      }

      return '¡Allá vas!';
    }

    return state.stage === 'flying' ? `¡${this.currentName()} ha saltado!` : `Turno de ${this.currentName()} (${turn}).`;
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
      distanceText: `${meters(row.distance)} m`,
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

      if (state && state.stage !== 'finished' && state.turnIndex !== this.announcedTurn && state.currentPlayerId === this.currentPlayerId) {
        this.announcedTurn = state.turnIndex;
        untracked(() => this.audioService.playEffect('turn'));
      }

      if (state?.outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = state.outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && !mine.backwards) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
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

    const sceneState = this.sceneState();

    if (this.destroyed || !sceneState) {
      return;
    }

    try {
      this.scene = new SwingScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, this.views(), sceneState, environment.apiUrl);
      this.scene.onRelease = () => this.audioService.playSfx('yuju', { rate: 0.9 + Math.random() * 0.25 });
      this.scene.onLand = () => this.audioService.playSfx('aplastar', { gain: 0.5 });
    } catch {
      this.unsupported.set(true);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.scene?.dispose();
    this.scene = undefined;
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || event.repeat) {
      return;
    }

    event.preventDefault();
    this.release(event.timeStamp);
  }

  /** Soltarse: el angulo es el de la cuerda en el instante del gesto, en esta pantalla. El salto se anima ya. */
  release(timeStamp = performance.now()): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state?.swingStartsAt || !lobbyId || !this.canRelease()) {
      return;
    }

    const elapsed = this.matchService.serverNow() - (performance.now() - timeStamp) - state.swingStartsAt;
    const { angle, dir } = swingAngleAt(Math.max(0, elapsed), state.periodMs);
    const { distance } = swingLaunch(angle, dir);
    this.myJump.set({ turnIndex: state.turnIndex, angle, dir, distance });
    this.flightStarts.set(this.currentPlayerId, performance.now());
    this.scene?.launchLocal(this.currentPlayerId, angle, dir);
    void this.matchService.releaseSwing(lobbyId, state.turnIndex, angle, dir);
  }

  private sceneState(): SwingSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    const toLocal = (serverTime: number | null) => (serverTime === null ? null : performance.now() + (serverTime - this.matchService.serverNow()));
    const latest = state.jumps[state.jumps.length - 1];

    return {
      order: state.order,
      turnIndex: state.turnIndex,
      stage: state.stage,
      swingStartsAt: toLocal(state.swingStartsAt),
      periodMs: state.periodMs,
      jumps: state.jumps.map((jump) => {
        if (!this.flightStarts.has(jump.playerId)) {
          // El ultimo salto vuela ahora; los anteriores (al entrar tarde) ya estan en el suelo.
          this.flightStarts.set(jump.playerId, jump === latest && state.stage === 'flying' ? (toLocal(state.flightStartsAt) ?? performance.now()) : -Infinity);
        }

        return { ...jump, startedAt: this.flightStarts.get(jump.playerId)! };
      }),
    };
  }
}
