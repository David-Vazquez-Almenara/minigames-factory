import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { GolfBall, GolfBoard } from './golf-board';
import { GOLF_MAPS, GolfSimulation, roundShot, simulateGolf } from './golf-course';

@Component({
  selector: 'app-golf',
  imports: [PlayerAvatarComponent],
  templateUrl: './golf.component.html',
  styleUrl: './golf.component.scss',
})
export class GolfComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly hostRef = viewChild.required<ElementRef<HTMLElement>>('playfield');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private board?: GolfBoard;
  private insetObserver?: ResizeObserver;
  private readonly images = new Map<string, HTMLImageElement>();
  /** Simulaciones ya calculadas de los demas (por ronda y jugador), con su instante de salida. */
  private readonly others = new Map<string, { simulation: GolfSimulation; startedAt: number }>();
  private localRound = 0;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.golf || null);
  readonly map = computed(() => GOLF_MAPS[this.state()?.map ?? 0]);
  /** Golpe propio: se simula y rueda al momento, sin esperar a nadie. */
  readonly myShot = signal<{ round: number; simulation: GolfSimulation; startedAt: number } | null>(null);

  readonly startTimer = this.timerService.countdown(() => this.state()?.aimStartsAt);
  readonly aimTimer = this.timerService.countdown(() => (this.state()?.stage === 'aiming' ? this.state()?.aimEndsAt : null), {
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly aimingOpen = computed(() => this.state()?.stage === 'aiming' && this.startTimer.remainingMs() <= 0 && this.aimTimer.remainingMs() > 0);
  readonly canShoot = computed(() => this.isPlayer() && this.aimingOpen() && this.myShot()?.round !== this.state()?.round);
  readonly showPreview = computed(() => this.state()?.stage === 'aiming' && this.startTimer.remainingMs() > 0);
  readonly roundShots = computed(() => {
    const state = this.state();
    return state?.history.find((entry) => entry.round === state.round)?.shots || null;
  });

  readonly results = computed(() =>
    (this.roundShots() || [])
      .map((shot) => ({
        ...shot,
        name: this.matchService.playerName(shot.playerId),
        avatarUrl: this.matchService.playerAvatar(shot.playerId),
        colorId: this.matchService.playerColor(shot.playerId),
        mine: shot.playerId === this.currentPlayerId,
        text: shot.missed ? 'No tiró' : shot.holed ? '¡Hoyo!' : shot.distance >= 1000 ? 'Al agua' : `a ${shot.distance} cm`,
      }))
      .sort((first, second) => first.distance - second.distance),
  );

  readonly statusText = computed(() => {
    const state = this.state();
    const mine = this.myShot();

    if (!state || state.stage === 'finished') {
      return 'Fin del mini golf.';
    }

    if (this.showPreview()) {
      return 'Estudia el hoyo…';
    }

    if (mine?.round === state.round) {
      if (mine.simulation.holed) {
        return '¡Hoyo en uno!';
      }

      return mine.simulation.water ? '¡Al agua!' : `Te has quedado a ${mine.simulation.distance} cm del hoyo.`;
    }

    if (state.stage === 'aiming' && this.isPlayer()) {
      return this.aimingOpen() ? 'Arrastra hacia atrás desde tu bola blanca y suelta para golpear.' : '¡Tiempo! Este hoyo cuenta como fallado.';
    }

    return 'Mira cómo golpean los demás.';
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
      // Ronda nueva: otro mapa y el golpe propio vuelve a estar disponible.
      const round = this.state()?.round || 0;

      if (round !== this.localRound) {
        this.localRound = round;
        untracked(() => this.board?.setMap(this.map()));
      }
    });

    effect(() => {
      const balls = this.balls();
      untracked(() => this.board?.setBalls(balls));
    });

    effect(() => {
      const aiming = this.canShoot();
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
    this.board = new GolfBoard(this.canvasRef().nativeElement, this.hostRef().nativeElement, this.map());
    this.board.onShoot = (angle, power) => this.shoot(angle, power);
    this.board.setBalls(this.balls());
    this.board.setAiming(this.canShoot());
    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.hostRef(), this.topBarRef(), this.dockRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.updateInsets();
  }

  ngOnDestroy(): void {
    this.insetObserver?.disconnect();
    this.board?.dispose();
    this.board = undefined;
  }

  /** Golpe propio: se simula aqui (fisica determinista) y la bola sale al instante; despues se envia el tiro. */
  private shoot(rawAngle: number, rawPower: number): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canShoot()) {
      return;
    }

    const angle = roundShot(rawAngle);
    const power = roundShot(rawPower);
    const simulation = simulateGolf(this.map(), angle, power);
    const startedAt = performance.now();
    this.myShot.set({ round: state.round, simulation, startedAt });
    this.audioService.playSfx('palanca', { rate: 1.3 });
    // Sonido al acabar: hoyo (campanita) o agua.
    setTimeout(() => {
      if (simulation.holed) {
        this.audioService.playSfx('acierto');
      } else if (simulation.water) {
        this.audioService.playEffect('pop');
      }
    }, simulation.path.length * simulation.stepMs);
    void this.matchService.golfShot(lobbyId, state.round, { angle, power, holed: simulation.holed, distance: simulation.distance });
  }

  /** Bolas que se ven: la propia (blanca) y las de los demas (en el tee hasta que se conocen sus golpes). */
  private balls(): GolfBall[] {
    const state = this.state();

    if (!state) {
      return [];
    }

    const shots = this.roundShots();
    const toLocal = (serverTime: number | null) => (serverTime === null ? performance.now() : performance.now() + (serverTime - this.matchService.serverNow()));
    const mine = this.myShot();

    return (this.matchService.match()?.specialRound?.participantIds || []).flatMap<GolfBall>((playerId) => {
      const isMine = playerId === this.currentPlayerId;
      const color = getPlayerColor(this.matchService.playerColor(playerId)).body;

      if (isMine) {
        const simulation = mine?.round === state.round ? mine.simulation : null;
        return [{ playerId, mine: true, color, image: null, simulation, startedAt: mine?.startedAt ?? 0 }];
      }

      const shot = shots?.find((entry) => entry.playerId === playerId);

      if (shot?.missed) {
        return [];
      }

      let other: { simulation: GolfSimulation; startedAt: number } | null = null;

      if (shot) {
        const key = `${state.round}:${playerId}`;
        other = this.others.get(key) || null;

        if (!other) {
          // Misma fisica que en su pantalla: con su tiro, su bola hace exactamente el mismo recorrido aqui.
          other = { simulation: simulateGolf(GOLF_MAPS[state.map], shot.angle, shot.power), startedAt: toLocal(state.rollStartsAt) };
          this.others.set(key, other);
        }
      }

      return [{ playerId, mine: false, color, image: this.imageFor(playerId), simulation: other?.simulation ?? null, startedAt: other?.startedAt ?? 0 }];
    });
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
