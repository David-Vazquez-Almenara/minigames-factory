import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { RussianPlayerView, RussianScene, RussianSceneState } from './russian-scene';

@Component({
  selector: 'app-russian',
  imports: [PlayerAvatarComponent],
  templateUrl: './russian.component.html',
  styleUrl: './russian.component.scss',
})
export class RussianComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('nameTags');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private scene?: RussianScene;
  private insetObserver?: ResizeObserver;
  private destroyed = false;
  private lastTurnSound = 0;
  private announcedFinal = false;
  private clockHandle = 0;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.russian || null);
  readonly unsupported = signal(false);
  /** Decision ya enviada en este turno (los botones se apagan al momento). */
  readonly sentTurn = signal(0);
  readonly errorMessage = signal('');
  /** Destello rojo de la pantalla con el disparo (mas fuerte para el que cae). */
  readonly bloodFlash = signal<'none' | 'soft' | 'strong'>('none');
  private readonly now = signal(performance.now());

  readonly decideTimer = this.timerService.countdown(() => (this.state()?.stage === 'deciding' ? this.state()?.decideEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly isMyTurn = computed(() => this.state()?.currentPlayerId === this.currentPlayerId && !this.state()?.outcome);
  readonly canDecide = computed(() => this.isMyTurn() && this.state()?.stage === 'deciding' && this.sentTurn() !== this.state()?.turnNumber);
  readonly currentName = computed(() => this.matchService.playerName(this.state()?.currentPlayerId));
  /**
   * Animacion de recarga cuando hay una bala mas: el tambor sale de su esquina al centro en grande, entra la bala
   * nueva y vuelve a su sitio. `x`/`y` es donde esta el icono y `dx`/`dy` lo que hay hasta el centro.
   */
  readonly reloadAnim = signal<{ key: number; from: number; to: number; filled: boolean; x: number; y: number; dx: number; dy: number } | null>(null);
  private lastLoad = 0;
  private lastBullets = 0;
  private reloadTimers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly cylinderIconRef = viewChild<ElementRef<HTMLElement>>('cylinderIcon');

  /** Balas que muestra el icono (durante la animacion, las de antes hasta que entra la nueva). */
  readonly shownBullets = computed(() => {
    const anim = this.reloadAnim();
    return anim ? (anim.filled ? anim.to : anim.from) : this.state()?.bullets || 0;
  });

  /** Indicador del tambor: 6 huecos, los primeros (en el sentido de las agujas del reloj) con bala. */
  readonly chambers = computed(() => {
    const total = this.state()?.chambers || 6;
    const loaded = this.shownBullets();
    const anim = this.reloadAnim();
    return Array.from({ length: total }, (_unused, index) => {
      const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
      return {
        loaded: index < loaded,
        fresh: Boolean(anim?.filled && index >= anim.from && index < anim.to),
        x: 50 + Math.cos(angle) * 30,
        y: 50 + Math.sin(angle) * 30,
      };
    });
  });

  readonly players = computed<RussianPlayerView[]>(() =>
    (this.state()?.order || []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
    })),
  );

  /** Fila de los vivos a partir del que esta en la mesa. */
  readonly queue = computed(() => {
    const state = this.state();

    if (!state) {
      return [];
    }

    const alive = state.order.filter((playerId) => state.alive.includes(playerId));
    const start = Math.max(0, alive.indexOf(state.currentPlayerId || ''));
    return alive.map((_unused, offset) => {
      const playerId = alive[(start + offset) % alive.length];
      return {
        playerId,
        name: this.matchService.playerName(playerId),
        avatarUrl: this.matchService.playerAvatar(playerId),
        colorId: this.matchService.playerColor(playerId),
        current: offset === 0,
        mine: playerId === this.currentPlayerId,
      };
    });
  });

  readonly tags = computed(() =>
    (this.state()?.order || []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      mine: playerId === this.currentPlayerId,
      current: playerId === this.state()?.currentPlayerId,
    })),
  );

  readonly statusText = computed(() => {
    const state = this.state();
    this.now();

    if (!state) {
      return 'Preparando la taberna…';
    }

    if (state.stage === 'finished') {
      return 'Fin de la ruleta rusa.';
    }

    const shot = state.lastShot?.turnNumber === state.turnNumber ? state.lastShot : null;
    const resolved = shot && this.matchService.serverNow() >= shot.firesAt;

    if (state.stage === 'reload') {
      return `¡Recarga! Ahora hay ${state.bullets} ${state.bullets === 1 ? 'bala' : 'balas'} en el tambor.`;
    }

    if (shot && resolved) {
      if (shot.bang) {
        return shot.playerId === this.currentPlayerId ? '¡PUM! Te ha tocado la bala…' : `¡PUM! ${this.currentName()} ha caído.`;
      }

      return shot.playerId === this.currentPlayerId ? '¡Clic! Te has salvado.' : `¡Clic! ${this.currentName()} se salva.`;
    }

    if (shot) {
      return shot.skipped ? 'Salta una bala… y aprieta el gatillo…' : 'Aprieta el gatillo…';
    }

    if (this.isMyTurn()) {
      return state.stage === 'walking' ? '¡Te toca! Vas hacia la mesa…' : 'Elige: dispara o salta una bala.';
    }

    return state.stage === 'walking' ? `${this.currentName()} va hacia la mesa…` : `${this.currentName()} se lo está pensando…`;
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
      const sceneState = this.sceneState();

      if (sceneState) {
        untracked(() => this.scene?.sync(sceneState));
      }
    });

    effect(() => {
      // Recarga con una bala mas (no al llegar ya al maximo, que no cambia): animacion del tambor.
      const state = this.state();

      if (!state || state.load === this.lastLoad) {
        return;
      }

      const from = this.lastBullets;
      const first = this.lastLoad === 0;
      this.lastLoad = state.load;
      this.lastBullets = state.bullets;

      if (!first && state.bullets > from) {
        untracked(() => this.playReloadAnimation(from, state.bullets));
      }
    });

    effect(() => {
      // Aviso cuando le toca a este jugador.
      const state = this.state();

      if (state?.currentPlayerId === this.currentPlayerId && state.turnNumber !== this.lastTurnSound && !state.outcome) {
        this.lastTurnSound = state.turnNumber;
        untracked(() => this.audioService.playEffect('turn'));
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

        untracked(() => setTimeout(() => this.updateInsets(), 1500));
      }
    });

    effect(() => {
      this.isMyTurn();
      this.state()?.stage;
      untracked(() => queueMicrotask(() => this.updateInsets()));
    });
  }

  async ngAfterViewInit(): Promise<void> {
    const tick = () => {
      this.now.set(performance.now());
      this.clockHandle = window.setTimeout(tick, 150);
    };
    tick();
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
      this.scene = new RussianScene(
        THREE,
        this.canvasRef().nativeElement,
        this.rootRef().nativeElement,
        this.labelsRef().nativeElement,
        this.players(),
        initial,
        environment.apiUrl,
      );
      this.scene.onSound = (sound) => this.playSound(sound);
    } catch {
      this.unsupported.set(true);
      return;
    }

    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.rootRef(), this.topBarRef(), this.dockRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.updateInsets();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.clockHandle);
    this.reloadTimers.forEach(clearTimeout);
    this.insetObserver?.disconnect();
    this.scene?.dispose();
    this.scene = undefined;
  }

  /** Disparar ('shoot') o saltar una bala y disparar la siguiente ('skip'). */
  async decide(action: 'shoot' | 'skip'): Promise<void> {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canDecide()) {
      return;
    }

    this.sentTurn.set(state.turnNumber);
    const response = await this.matchService.russianAction(lobbyId, state.turnNumber, action);

    if (!response.ok && !this.destroyed) {
      this.sentTurn.set(0);
      this.errorMessage.set(response.reason || 'No se pudo disparar.');
    }
  }

  /** El icono del tambor vuela al centro, entra la bala nueva (con sonido) y vuelve encogiendose a su esquina. */
  private playReloadAnimation(from: number, to: number): void {
    const icon = this.cylinderIconRef()?.nativeElement.getBoundingClientRect();
    const root = this.rootRef().nativeElement.getBoundingClientRect();

    if (!icon || !icon.width) {
      return;
    }

    this.reloadTimers.forEach(clearTimeout);
    const x = icon.left - root.left;
    const y = icon.top - root.top;
    this.reloadAnim.set({
      key: Date.now(),
      from,
      to,
      filled: false,
      x,
      y,
      dx: root.width / 2 - (x + icon.width / 2),
      dy: root.height * 0.42 - (y + icon.height / 2),
    });
    this.reloadTimers = [
      setTimeout(() => {
        this.reloadAnim.update((anim) => (anim ? { ...anim, filled: true } : anim));
        this.audioService.playSfx('bala');
      }, 1050),
      setTimeout(() => this.reloadAnim.set(null), 2500),
    ];
  }

  private playSound(sound: Parameters<NonNullable<RussianScene['onSound']>>[0]): void {
    switch (sound) {
      case 'steps':
        this.audioService.playSfx('pasos', { gain: 0.6 });
        break;
      case 'pickup':
        this.audioService.playSfx('palanca', { rate: 1.4, gain: 0.6 });
        break;
      case 'spin':
        this.audioService.playSfx('tambor');
        break;
      case 'cock':
        this.audioService.playSfx('martillo');
        break;
      case 'click':
        this.audioService.playSfx('clic');
        break;
      case 'putdown':
        this.audioService.playSfx('corte', { rate: 0.7, gain: 0.6 });
        break;
      case 'bang': {
        this.audioService.playSfx('disparo', { gain: 1.4 });
        const victim = this.state()?.lastShot?.playerId === this.currentPlayerId;
        this.bloodFlash.set(victim ? 'strong' : 'soft');
        setTimeout(() => !this.destroyed && this.bloodFlash.set('none'), victim ? 1400 : 700);
        break;
      }
      case 'thud':
        this.audioService.playSfx('aplastar', { gain: 0.8, rate: 1.1 });
        break;
      case 'reload':
        this.audioService.playSfx('recarga');
        break;
    }
  }

  private sceneState(): RussianSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    const toLocal = (serverTime: number | null) => performance.now() + ((serverTime || 0) - this.matchService.serverNow());
    const shot = state.lastShot;

    return {
      order: state.order,
      alive: state.alive,
      turnIndex: state.turnIndex,
      turnNumber: state.turnNumber,
      currentPlayerId: state.currentPlayerId,
      arriveAt: toLocal(state.arriveAt),
      shot: shot ? { ...shot, at: toLocal(shot.at), firesAt: toLocal(shot.firesAt) } : null,
      load: state.load,
      finished: state.stage === 'finished',
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
    const results = this.rootRef().nativeElement.querySelector('.results-card')?.getBoundingClientRect();
    const bottomEdge = Math.min(dock.height ? dock.top : root.bottom, results ? results.top : root.bottom);
    scene.setInsets({
      top: Math.max(0, top.bottom - root.top + 6),
      bottom: Math.max(0, root.bottom - bottomEdge + 6),
      left: 0,
      right: 0,
    });
  }
}
