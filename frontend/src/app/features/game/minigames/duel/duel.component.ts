import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { neighbourWindow } from '../../../../shared/neighbour-window';
import { getPlayerColor } from '../../../../shared/player-colors';
import { DuelPlayerView, DuelScene, DuelSceneState } from './duel-scene';

/** Momento de la ronda en la pantalla de este jugador (lo decide su propio reloj, fotograma a fotograma). */
type DuelPhase = 'ready' | 'steady' | 'fire' | 'time' | 'fallen' | 'final';
type MyShot = { reactionMs: number } | { foul: true };

// Tras el "¡TIEMPO!", los que no han llegado caen un segundo y medio despues.
const FALL_DELAY_MS = 1500;

@Component({
  selector: 'app-duel',
  imports: [PlayerAvatarComponent],
  templateUrl: './duel.component.html',
  styleUrl: './duel.component.scss',
})
export class DuelComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private scene?: DuelScene;
  private destroyed = false;
  private frameHandle = 0;
  private localRound = 0;
  /** Instante (performance.now) del fotograma en que aparecio "¡YA!" en esta pantalla. */
  private signalShownAt: number | null = null;
  private announcedFall = 0;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.duel || null);
  readonly unsupported = signal(false);
  readonly phase = signal<DuelPhase>('ready');
  readonly myShot = signal<MyShot | null>(null);

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly visibleIds = computed(() => neighbourWindow(this.matchService.match()?.specialRound?.participantIds || [], this.currentPlayerId));
  readonly views = computed<DuelPlayerView[]>(() =>
    this.visibleIds().map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
      isLocal: playerId === this.currentPlayerId,
    })),
  );
  readonly canShoot = computed(() => this.isPlayer() && this.myShot() === null && ['steady', 'fire', 'time'].includes(this.phase()) && this.state()?.stage === 'waiting');
  readonly myHit = computed(() => {
    const shot = this.myShot();
    return Boolean(shot && 'reactionMs' in shot && shot.reactionMs <= (this.state()?.dealerMs || 0));
  });

  /** Resultado de cada jugador visible en la ronda: el propio, al momento; el de los demas, al conocerse. */
  readonly roundResults = computed(() => {
    const state = this.state();
    const results = new Map((state?.stage === 'result' ? state.results : []).map((result) => [result.playerId, result]));
    const shot = this.myShot();

    if (shot) {
      results.set(this.currentPlayerId, {
        playerId: this.currentPlayerId,
        foul: 'foul' in shot,
        reactionMs: 'reactionMs' in shot ? shot.reactionMs : null,
        hit: this.myHit(),
      });
    }

    return results;
  });

  readonly tags = computed(() =>
    this.views().map((view) => {
      const result = this.roundResults().get(view.playerId);
      const shown = this.phase() === 'fallen' || (view.isLocal && result);
      let detail = '';

      if (shown && result) {
        detail = result.foul ? 'Falta' : result.reactionMs !== null ? `${result.reactionMs} ms` : 'Sin disparar';
      } else if (shown && view.isLocal) {
        detail = 'Sin disparar';
      }

      return { ...view, detail, hit: Boolean(result?.hit), lost: shown && !result?.hit };
    }),
  );

  readonly statusText = computed(() => {
    const shot = this.myShot();

    switch (this.phase()) {
      case 'ready':
        return 'Espera a que salga «¡YA!».';
      case 'steady':
        return shot && 'foul' in shot ? '¡Te has adelantado! Te has disparado en el pie.' : 'Mano en el revólver… espera la señal.';
      case 'fire':
      case 'time':
        return shot ? (shot && 'foul' in shot ? '¡Falta!' : `¡Disparo en ${(shot as { reactionMs: number }).reactionMs} ms!`) : '¡DISPARA!';
      case 'fallen':
        return this.myHit() ? '¡Has ganado el duelo!' : 'El crupier ha sido más rápido…';
      default:
        return 'Fin del duelo.';
    }
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
      // Ronda nueva: se olvida el disparo anterior.
      const round = this.state()?.round || 0;

      if (round !== this.localRound) {
        this.localRound = round;
        this.signalShownAt = null;
        untracked(() => this.myShot.set(null));
      }
    });

    effect(() => {
      // Caen los que no han llegado: si has ganado, suena la victoria (perder no tiene sonido).
      if (this.phase() === 'fallen' && this.announcedFall !== this.localRound) {
        this.announcedFall = this.localRound;

        if (untracked(this.myHit)) {
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
      this.watchClock();
      return;
    }

    if (this.destroyed) {
      return;
    }

    try {
      const match = this.matchService.match();
      this.scene = new DuelScene(
        THREE,
        this.canvasRef().nativeElement,
        this.rootRef().nativeElement,
        this.labelsRef().nativeElement,
        this.views(),
        environment.apiUrl,
        `${match?.lobbyId || ''}:${match?.roundNumber || 0}`,
      );
      const sceneState = this.sceneState();

      if (sceneState) {
        this.scene.sync(sceneState);
      }
    } catch {
      this.unsupported.set(true);
    }

    this.watchClock();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frameHandle);
    this.scene?.dispose();
    this.scene = undefined;
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || event.repeat) {
      return;
    }

    event.preventDefault();
    this.shoot(event.timeStamp);
  }

  /** Disparo: se decide aqui mismo con la marca de tiempo exacta del gesto (tecla o dedo), sin esperar a nadie. */
  shoot(timeStamp = performance.now()): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canShoot()) {
      return;
    }

    this.audioService.playSfx('disparo');

    if (this.phase() === 'steady' || this.signalShownAt === null) {
      this.myShot.set({ foul: true });
      void this.matchService.duelShot(lobbyId, state.round, { foul: true });
      return;
    }

    const reactionMs = Math.max(1, Math.round(timeStamp - this.signalShownAt));
    this.myShot.set({ reactionMs });
    this.scene?.fire(this.currentPlayerId);
    void this.matchService.duelShot(lobbyId, state.round, { reactionMs });
  }

  /**
   * Reloj de la ronda en esta pantalla, fotograma a fotograma: asi "¡YA!" aparece en el instante justo y el tiempo
   * de reaccion se mide desde que el jugador lo ve. Solo cambia las senales cuando cambia la fase.
   */
  private watchClock(): void {
    const step = () => {
      if (this.destroyed) {
        return;
      }

      this.frameHandle = requestAnimationFrame(step);
      const state = this.state();
      const now = this.matchService.serverNow();
      let next: DuelPhase = 'ready';

      if (!state || state.stage === 'finished') {
        next = 'final';
      } else if (state.deadline && now >= state.deadline + FALL_DELAY_MS && (state.stage === 'result' || now >= state.deadline + FALL_DELAY_MS + 1500)) {
        next = 'fallen';
      } else if (state.deadline && now >= state.deadline) {
        next = 'time';
      } else if (state.signalAt && now >= state.signalAt) {
        next = 'fire';
      } else if (state.roundStartsAt && now >= state.roundStartsAt) {
        next = 'steady';
      }

      if (next === 'fire' && this.signalShownAt === null) {
        this.signalShownAt = performance.now();
      }

      if (next !== this.phase()) {
        const previous = this.phase();
        this.phase.set(next);

        if (next === 'time' && previous !== 'time') {
          // Dispara el crupier.
          this.audioService.playSfx('disparo', { rate: 0.85 });
        } else if (next === 'steady') {
          this.audioService.playEffect('tick');
        }
      }
    };

    step();
  }

  private sceneState(): DuelSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    const phase = this.phase();
    const fallen = phase === 'fallen';
    const results = this.roundResults();
    const deadlineLocal = state.deadline ? performance.now() + (state.deadline - this.matchService.serverNow()) : null;

    return {
      players: this.visibleIds().map((playerId) => {
        const result = results.get(playerId);
        const mine = playerId === this.currentPlayerId;
        // Desenfunda en cuanto dispara (el propio al instante; los demas al conocerse su resultado).
        const aiming = Boolean(result && !result.foul && result.reactionMs !== null && (mine || phase === 'time' || fallen));
        return { playerId, aiming, dead: fallen && !result?.hit };
      }),
      dealerShootsAt: state.stage !== 'finished' && (phase === 'time' || fallen) ? deadlineLocal : null,
      dealerDead: fallen && [...results.values()].some((result) => result.hit),
    };
  }
}
