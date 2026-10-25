import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { neighbourWindow } from '../../../../shared/neighbour-window';
import { getPlayerColor } from '../../../../shared/player-colors';
import { PODIUM_COUNT, StopwatchPlayerView, StopwatchScene, StopwatchSceneState } from './stopwatch-scene';

type ClockPhase = 'countdown' | 'visible' | 'hidden' | 'over';

/** "08,0" (objetivo, una decima) o "08,24" (tiempos de los jugadores, centesimas). */
function formatSeconds(ms: number, decimals: 1 | 2): string {
  const value = (Math.max(0, ms) / 1000).toFixed(decimals).replace('.', ',');
  return value.padStart(decimals === 1 ? 4 : 5, '0');
}

@Component({
  selector: 'app-stopwatch',
  imports: [PlayerAvatarComponent],
  templateUrl: './stopwatch.component.html',
  styleUrl: './stopwatch.component.scss',
})
export class StopwatchComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private scene?: StopwatchScene;
  private destroyed = false;
  private frameHandle = 0;
  private localRound = 0;
  private lastSecond = -1;
  private pressedSeen = new Set<string>();
  private announcedReveal = 0;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.stopwatch || null);
  readonly unsupported = signal(false);
  /** Lo que marca el marcador grande en esta pantalla (se actualiza cada fotograma solo mientras se ve). */
  readonly clockText = signal('00,0');
  readonly clockPhase = signal<ClockPhase>('countdown');
  readonly countdownSecond = signal(0);
  /** Tiempo con el que ha parado este jugador en la ronda (medido aqui, al instante). */
  readonly myStop = signal<number | null>(null);

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly seatIds = computed(() => {
    const ids = neighbourWindow(this.matchService.match()?.specialRound?.participantIds || [], this.currentPlayerId, PODIUM_COUNT);
    return Array.from({ length: PODIUM_COUNT }, (_unused, slot) => ids[slot] ?? null);
  });
  readonly targetText = computed(() => formatSeconds(this.state()?.targetMs || 0, 1));
  readonly lastRound = computed(() => {
    const state = this.state();
    return state?.stage !== 'running' ? state?.history.find((entry) => entry.round === state.round) || null : null;
  });
  readonly canStop = computed(() => this.isPlayer() && this.myStop() === null && this.state()?.stage === 'running' && (this.clockPhase() === 'visible' || this.clockPhase() === 'hidden'));

  /** Pantalla de cada atril: vacio, esperando, parado (sin decir el tiempo) o el tiempo con su error al revelar. */
  readonly screens = computed(() => {
    const state = this.state();
    const round = this.lastRound();

    return this.seatIds().map((playerId, slot) => {
      if (!playerId || !state) {
        return { slot, playerId, name: '', text: '', tone: 'empty', mine: false };
      }

      const mine = playerId === this.currentPlayerId;
      const result = round?.results.find((entry) => entry.playerId === playerId);
      let text = '--,--';
      let tone = 'idle';

      if (result) {
        text = result.elapsedMs === null ? 'No paró' : formatSeconds(result.elapsedMs, 2);
        tone = result.errorMs <= 200 ? 'great' : result.errorMs <= 800 ? 'ok' : 'bad';
      } else if (state.stoppedPlayerIds.includes(playerId) || (mine && this.myStop() !== null)) {
        // Ha parado, pero ningun tiempo (ni el propio) se ve hasta que paran todos: asi no hay pistas.
        text = '??,??';
        tone = 'stopped';
      }

      return { slot, playerId, name: mine ? 'Tú' : this.matchService.playerName(playerId), text, tone, mine };
    });
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
      errorText: formatSeconds(row.totalErrorMs, 2),
    })),
  );

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state || state.stage === 'finished') {
      return 'Fin del cronómetro.';
    }

    if (state.stage === 'reveal') {
      const mine = this.lastRound()?.results.find((entry) => entry.playerId === this.currentPlayerId);
      return mine ? `Te has quedado a ${formatSeconds(mine.errorMs, 2)} s del objetivo.` : 'Así han quedado.';
    }

    if (this.clockPhase() === 'countdown') {
      return `Para el cronómetro en ${this.targetText()} segundos.`;
    }

    if (this.myStop() !== null) {
      return 'Parado. Los tiempos se verán cuando paren todos…';
    }

    return this.clockPhase() === 'hidden' ? '¡Cuenta mentalmente y para a tiempo!' : 'El cronómetro está corriendo…';
  });

  constructor() {
    effect(() => {
      const sceneState = this.sceneState();

      if (sceneState) {
        untracked(() => this.scene?.sync(sceneState));
      }
    });

    effect(() => {
      const state = this.state();
      const round = state?.round || 0;

      if (round !== this.localRound) {
        this.localRound = round;
        this.pressedSeen.clear();
        untracked(() => this.myStop.set(null));
      }

      // Los demas pulsan su boton cuando se sabe que han parado.
      for (const playerId of state?.stoppedPlayerIds || []) {
        if (!this.pressedSeen.has(playerId)) {
          this.pressedSeen.add(playerId);

          if (playerId !== this.currentPlayerId) {
            untracked(() => this.scene?.press(playerId));
          }
        }
      }

      if (state?.stage === 'reveal' && this.announcedReveal !== round) {
        this.announcedReveal = round;
        untracked(() => this.audioService.playEffect('reveal'));
      }

      if (state?.outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = state.outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    this.watchClock();
    let THREE: typeof import('three');

    try {
      THREE = await import('three');
    } catch {
      this.unsupported.set(true);
      return;
    }

    if (this.destroyed) {
      return;
    }

    const seats = this.seatIds().map<StopwatchPlayerView | null>((playerId) =>
      playerId
        ? {
            playerId,
            name: this.matchService.playerName(playerId),
            avatarUrl: this.matchService.playerAvatar(playerId),
            shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
            isLocal: playerId === this.currentPlayerId,
          }
        : null,
    );

    try {
      this.scene = new StopwatchScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, seats, environment.apiUrl);
      const sceneState = this.sceneState();

      if (sceneState) {
        this.scene.sync(sceneState);
      }
    } catch {
      this.unsupported.set(true);
    }
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
    this.stop(event.timeStamp);
  }

  /** Parar: el tiempo se calcula aqui con la marca exacta del gesto, sin esperar al servidor. */
  stop(timeStamp = performance.now()): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state?.startsAt || !lobbyId || !this.canStop()) {
      return;
    }

    // Reloj del servidor en el instante del gesto (descontando lo que ha tardado en llegar aqui).
    const elapsedMs = Math.round(this.matchService.serverNow() - (performance.now() - timeStamp) - state.startsAt);
    this.commitStop(Math.max(0, elapsedMs));
  }

  private commitStop(elapsedMs: number): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId) {
      return;
    }

    this.myStop.set(elapsedMs);
    this.scene?.press(this.currentPlayerId);
    this.audioService.playSfx('palanca');
    void this.matchService.stopStopwatch(lobbyId, state.round, elapsedMs);
  }

  /** Marcador grande: cuenta atras, cronometro visible los primeros segundos y despues oculto. */
  private watchClock(): void {
    const step = () => {
      if (this.destroyed) {
        return;
      }

      this.frameHandle = requestAnimationFrame(step);
      const state = this.state();

      if (!state?.startsAt || state.stage !== 'running') {
        this.setPhase('over');
        this.clockText.set(state ? this.targetText() : '00,0');
        return;
      }

      const elapsed = this.matchService.serverNow() - state.startsAt;

      if (elapsed < 0) {
        this.setPhase('countdown');
        this.clockText.set(this.targetText());
        const second = Math.ceil(-elapsed / 1000);

        if (second !== this.countdownSecond()) {
          this.countdownSecond.set(second);

          if (second <= 3) {
            this.audioService.playEffect('tick');
          }
        }

        return;
      }

      if (elapsed < state.visibleMs) {
        this.setPhase('visible');
        this.clockText.set(formatSeconds(elapsed, 1));
        const second = Math.floor(elapsed / 1000);

        if (second !== this.lastSecond) {
          this.lastSecond = second;
          this.audioService.playEffect('tick');
        }
      } else {
        this.setPhase('hidden');
        this.clockText.set('??,?');
      }

      // Si se pasa del todo, el cliente para solo con el error maximo.
      if (this.isPlayer() && this.myStop() === null && elapsed >= state.targetMs + state.maxErrorMs) {
        this.commitStop(state.targetMs + state.maxErrorMs);
      }
    };

    step();
  }

  private setPhase(phase: ClockPhase): void {
    if (phase !== this.clockPhase()) {
      this.clockPhase.set(phase);
      this.lastSecond = -1;
    }
  }

  private sceneState(): StopwatchSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    const round = this.lastRound();
    const best = state.outcome?.ranking[0]?.playerId;

    return {
      seats: this.seatIds().map((playerId) => {
        if (!playerId) {
          return null;
        }

        if (state.outcome) {
          return { playerId, mood: playerId === best ? 'happy' : 'idle' };
        }

        const result = round?.results.find((entry) => entry.playerId === playerId);
        return { playerId, mood: !result ? 'idle' : result.errorMs <= 300 ? 'happy' : result.errorMs >= 1500 ? 'sad' : 'idle' };
      }),
    };
  }
}
