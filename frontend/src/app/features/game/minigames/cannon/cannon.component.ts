import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { CannonPlayerView, CannonScene, CannonSceneState, ZONE_COLORS } from './cannon-scene';

@Component({
  selector: 'app-cannon',
  imports: [PlayerAvatarComponent],
  templateUrl: './cannon.component.html',
  styleUrl: './cannon.component.scss',
})
export class CannonComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('nameTags');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private scene?: CannonScene;
  private insetObserver?: ResizeObserver;
  private destroyed = false;
  private announcedFinal = false;
  private lastAimSound = 0;
  private lastRevealSound = 0;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.cannon || null);
  readonly unsupported = signal(false);
  readonly errorMessage = signal('');
  /** Zona propia elegida (al momento, sin esperar al servidor). */
  readonly myPick = signal<{ round: number; zone: number } | null>(null);
  /** Disparo ya enviado en esta ronda (canonero). */
  readonly sentAim = signal<{ round: number; zone: number } | null>(null);
  readonly zoneColors = ZONE_COLORS;

  readonly chooseTimer = this.timerService.countdown(() => (this.state()?.stage === 'choosing' ? this.state()?.chooseEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });
  readonly aimTimer = this.timerService.countdown(() => (this.state()?.stage === 'aiming' ? this.state()?.aimEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly isCannoneer = computed(() => this.state()?.cannoneerId === this.currentPlayerId);
  readonly isVictim = computed(() => Boolean(this.state()?.victims.includes(this.currentPlayerId)));
  readonly amAlive = computed(() => Boolean(this.state()?.alive.includes(this.currentPlayerId)));
  readonly cannoneerName = computed(() => this.matchService.playerName(this.state()?.cannoneerId));
  readonly revealed = computed(() => ['firing', 'result', 'finished'].includes(this.state()?.stage || ''));

  readonly canPick = computed(() => this.isVictim() && this.amAlive() && this.state()?.stage === 'choosing' && this.chooseTimer.remainingMs() > 0);
  readonly canFire = computed(() => this.isCannoneer() && this.state()?.stage === 'aiming' && this.sentAim()?.round !== this.state()?.round);
  /** Zona propia: la del servidor (estado privado) o la recien pulsada. */
  readonly myZone = computed(() => {
    const state = this.state();
    const pick = this.myPick();

    if (!state) {
      return null;
    }

    if (pick?.round === state.round) {
      return pick.zone;
    }

    return this.matchService.privateState()?.cannon?.picks.find((entry) => entry.playerId === this.currentPlayerId)?.zone ?? null;
  });

  /** Botones de las zonas en el mismo orden en que se ven (al canonero el patio le sale al reves). */
  readonly zoneButtons = computed(() => {
    const order = this.isCannoneer() ? [3, 2, 1, 0] : [0, 1, 2, 3];
    const selected = this.isCannoneer() ? (this.sentAim()?.round === this.state()?.round ? this.sentAim()?.zone : null) : this.myZone();
    return order.map((zone) => ({ zone, label: zone + 1, color: ZONE_COLORS[zone], selected: selected === zone }));
  });

  readonly players = computed<CannonPlayerView[]>(() => {
    const state = this.state();
    return (state ? [state.cannoneerId, ...state.victims] : []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
    }));
  });

  readonly tags = computed(() =>
    this.players().map((player) => ({
      playerId: player.playerId,
      name: player.name,
      mine: player.playerId === this.currentPlayerId,
      cannoneer: player.playerId === this.state()?.cannoneerId,
    })),
  );

  /** Alcanzados en el disparo de esta ronda (o en el ultimo, al final). */
  readonly hitIds = computed(() => {
    const state = this.state();

    if (!state || !this.revealed()) {
      return [];
    }

    const entry = state.stage === 'finished' ? state.history.at(-1) : state.history.find((item) => item.round === state.round);
    return entry?.hit || [];
  });

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state) {
      return 'Preparando la muralla…';
    }

    const zone = (value: number | null | undefined) => `zona ${(value ?? 0) + 1}`;

    switch (state.stage) {
      case 'finished':
        return 'Fin del Cañón.';
      case 'choosing':
        if (this.isCannoneer()) {
          return 'Los de abajo se están escondiendo… ¡no puedes verlos!';
        }

        if (this.isVictim() && !this.amAlive()) {
          return 'Te han derribado: mira cómo sigue.';
        }

        if (!this.isVictim()) {
          return 'Los de abajo eligen zona…';
        }

        return this.myZone() === null ? 'Elige una zona: toca un cuadrado o un botón.' : `Estás en la ${zone(this.myZone())}. Puedes cambiar mientras quede tiempo.`;
      case 'aiming':
        if (this.isCannoneer()) {
          return this.canFire() ? '¡Elige a qué zona disparas!' : `Apuntando a la ${zone(this.sentAim()?.zone)}…`;
        }

        return `${this.cannoneerName()} está apuntando…`;
      case 'firing':
        return `¡${this.isCannoneer() ? 'Disparas' : this.cannoneerName() + ' dispara'} a la ${zone(state.target)}!`;
      default: {
        const hit = this.hitIds();

        if (!hit.length) {
          return `¡Fallo! No había nadie en la ${zone(state.target)}.`;
        }

        if (hit.includes(this.currentPlayerId)) {
          return '¡BUM! Has salido volando…';
        }

        const names = hit.map((id) => this.matchService.playerName(id)).join(', ');
        return `¡BUM! ${names} ${hit.length === 1 ? 'sale' : 'salen'} volando.`;
      }
    }
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      text:
        row.role === 'cannoneer'
          ? `Cañonero · ${row.kills} ${row.kills === 1 ? 'derribado' : 'derribados'}`
          : `${row.rounds} ${row.rounds === 1 ? 'ronda' : 'rondas'}${row.survived ? ' · ¡en pie!' : ' · 💥'}`,
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
      const picking = this.canPick() || this.canFire();

      untracked(() => {
        if (this.scene) {
          this.scene.picking = picking;
        }
      });
    });

    effect(() => {
      // Aviso al canonero cuando le toca apuntar; "tachan" al desvelar donde esta cada uno.
      const state = this.state();

      if (state?.stage === 'aiming' && this.isCannoneer() && this.lastAimSound !== state.round) {
        this.lastAimSound = state.round;
        untracked(() => this.audioService.playEffect('turn'));
      }

      if (state?.stage === 'firing' && this.lastRevealSound !== state.round) {
        this.lastRevealSound = state.round;
        untracked(() => this.audioService.playSfx('carta-voltear'));
      }
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && mine.points > 0) {
          untracked(() => this.audioService.playFileEffect('win'));
        }

        untracked(() => setTimeout(() => this.updateInsets(), 1500));
      }
    });

    effect(() => {
      this.state()?.stage;
      this.canPick();
      this.canFire();
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
      this.scene = new CannonScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, this.players(), initial, environment.apiUrl);
      this.scene.onSound = (sound) => this.playSound(sound);
      this.scene.onZonePicked = (zone) => this.chooseZone(zone);
      this.scene.picking = this.canPick() || this.canFire();
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
    this.insetObserver?.disconnect();
    this.scene?.dispose();
    this.scene = undefined;
  }

  /** Boton o clic en el patio: los de abajo eligen zona (y pueden cambiarla); el canonero dispara. */
  async chooseZone(zone: number): Promise<void> {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId) {
      return;
    }

    if (this.canFire()) {
      this.sentAim.set({ round: state.round, zone });
      const response = await this.matchService.cannonPick(lobbyId, state.round, zone);

      if (!response.ok && !this.destroyed && this.state()?.stage === 'aiming') {
        this.sentAim.set(null);
        this.errorMessage.set(response.reason || 'No se pudo disparar.');
      }

      return;
    }

    if (!this.canPick() || this.myZone() === zone) {
      return;
    }

    this.myPick.set({ round: state.round, zone });
    this.audioService.playSfx('pasos', { gain: 0.5 });
    const response = await this.matchService.cannonPick(lobbyId, state.round, zone);

    if (!response.ok && !this.destroyed) {
      this.errorMessage.set(response.reason || 'No se pudo elegir la zona.');
    }
  }

  private playSound(sound: Parameters<NonNullable<CannonScene['onSound']>>[0]): void {
    switch (sound) {
      case 'fire':
        this.audioService.playSfx('canonazo');
        break;
      case 'whistle':
        this.audioService.playSfx('silbido');
        break;
      case 'boom':
        this.audioService.playSfx('explosion');
        break;
      case 'thud':
        this.audioService.playSfx('aplastar', { gain: 0.7, rate: 1.1 });
        break;
      case 'reveal':
        this.audioService.playEffect('pop');
        break;
      case 'walls':
        this.audioService.playSfx('aplastar', { gain: 0.6, rate: 0.75 });
        break;
    }
  }

  private sceneState(): CannonSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    const toLocal = (serverTime: number | null) => performance.now() + ((serverTime || 0) - this.matchService.serverNow());
    const view = this.isCannoneer() ? 'cannoneer' : 'victim';
    const zones: Record<string, number | null> = {};
    const revealed = this.revealed();

    if (revealed) {
      // Desde el disparo todos ven donde estaba cada uno (al final, la ultima ronda).
      const positions = state.stage === 'finished' ? state.history.at(-1)?.positions || [] : state.positions;

      for (const entry of positions) {
        zones[entry.playerId] = entry.zone;
      }
    } else if (view === 'victim') {
      const secret = this.matchService.privateState()?.cannon;

      for (const entry of secret?.round === state.round ? secret.picks : []) {
        zones[entry.playerId] = entry.zone;
      }

      const mine = this.myPick();

      if (mine?.round === state.round && this.amAlive()) {
        zones[this.currentPlayerId] = mine.zone;
      }
    }

    const aim = this.sentAim();
    return {
      view,
      cannoneerId: state.cannoneerId,
      victims: state.victims,
      alive: state.alive,
      round: state.round,
      stage: state.stage,
      zones,
      victimsVisible: view === 'victim' || revealed,
      aimZone: view === 'cannoneer' && aim?.round === state.round ? aim.zone : null,
      target: state.target,
      fireAt: toLocal(state.fireAt),
      impactAt: toLocal(state.impactAt),
      hit: this.hitIds(),
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
