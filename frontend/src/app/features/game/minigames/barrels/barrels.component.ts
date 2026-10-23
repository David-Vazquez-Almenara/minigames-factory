import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { BarrelsPublicState } from '../../../../core/services/socket.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { BarrelColumnState, BarrelColumnView, BarrelsScene } from './barrels-scene';

// Los rivales se dibujan con un pequeno retraso: asi su parada (que llega por red) casi nunca obliga
// a subir un barril que ya se veia mas abajo.
const REMOTE_DELAY_MS = 120;
const MAX_VISIBLE_RIVALS = 4;

/** Altura del barril (m) a los `elapsed` ms de caida: identica en cliente y servidor. */
function heightAt(state: Pick<BarrelsPublicState, 'startHeight' | 'fallMs' | 'exponent'>, elapsed: number): number {
  const progress = Math.min(1, Math.max(0, elapsed / state.fallMs));
  return Math.max(0, state.startHeight * (1 - Math.pow(progress, state.exponent)));
}

@Component({
  selector: 'app-barrels',
  imports: [PlayerAvatarComponent],
  templateUrl: './barrels.component.html',
  styleUrl: './barrels.component.scss',
})
export class BarrelsComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private scene?: BarrelsScene;
  private insetObserver?: ResizeObserver;
  private destroyed = false;
  private roundId = '';
  private lastCountdownSecond = -1;
  private resultsAnnounced = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.barrels || null);
  readonly unsupported = signal(false);
  /** Estado local del barril propio: lo decide este cliente al instante y ningun mensaje remoto lo cambia. */
  readonly localStop = signal<{ elapsedMs: number; height: number } | null>(null);
  readonly localCrushed = signal(false);

  readonly countdown = this.timerService.countdown(() => this.state()?.startsAt, { paused: () => this.matchService.hostPaused() });
  readonly goTimer = this.timerService.countdown(() => (this.state() ? this.state()!.startsAt + 900 : null), {
    paused: () => this.matchService.hostPaused(),
  });
  readonly started = computed(() => Boolean(this.state()) && this.countdown.remainingMs() <= 0);
  readonly showGo = computed(() => this.started() && this.goTimer.remainingMs() > 0);

  readonly isRacer = computed(() => Boolean(this.state()?.racers.some((racer) => racer.playerId === this.currentPlayerId)));
  readonly finished = computed(() => Boolean(this.localStop()) || this.localCrushed());
  readonly canStop = computed(() => this.isRacer() && this.started() && !this.finished() && this.state()?.stage === 'falling');

  /** Jugadores que se dibujan: el local y hasta cuatro rivales. El resto solo aparece en la lista. */
  readonly columns = computed<BarrelColumnView[]>(() => {
    const state = this.state();

    if (!state) {
      return [];
    }

    const local = state.racers.filter((racer) => racer.playerId === this.currentPlayerId);
    const rivals = state.racers.filter((racer) => racer.playerId !== this.currentPlayerId).slice(0, MAX_VISIBLE_RIVALS);
    return [...local, ...rivals].map((racer) => ({
      playerId: racer.playerId,
      name: this.matchService.playerName(racer.playerId),
      avatarUrl: this.matchService.playerAvatar(racer.playerId),
      shirt: getPlayerColor(this.matchService.playerColor(racer.playerId)).body,
      isLocal: racer.playerId === this.currentPlayerId,
    }));
  });

  readonly racers = computed(() => {
    const state = this.state();

    return (state?.racers || []).map((racer) => {
      const mine = racer.playerId === this.currentPlayerId;
      // Para el propio jugador manda lo que ha decidido su cliente.
      const stop = mine ? this.localStop() : null;
      const crushed = mine ? this.localCrushed() : racer.status === 'crushed';
      const height = stop ? stop.height : racer.status === 'stopped' ? racer.height : null;

      return {
        playerId: racer.playerId,
        mine,
        name: this.matchService.playerName(racer.playerId),
        avatarUrl: this.matchService.playerAvatar(racer.playerId),
        colorId: this.matchService.playerColor(racer.playerId),
        crushed,
        height,
        // Mientras cae no se muestra nada: solo los metros cuando ya ha parado.
        label: crushed ? '¡Aplastado!' : height !== null ? `${height.toFixed(2)} m` : '',
      };
    });
  });

  readonly ranking = computed(() =>
    (this.state()?.ranking || []).map((entry) => ({
      ...entry,
      mine: entry.playerId === this.currentPlayerId,
      avatarUrl: this.matchService.playerAvatar(entry.playerId),
      colorId: this.matchService.playerColor(entry.playerId),
      heightText: entry.status === 'crushed' ? 'Aplastado' : `${(entry.height ?? 0).toFixed(2)} m`,
    })),
  );

  readonly statusText = computed(() => {
    const stop = this.localStop();

    if (!this.isRacer()) {
      return 'Estás mirando la ronda.';
    }

    if (stop) {
      return `¡Parado a ${stop.height.toFixed(2)} m! Esperando al resto…`;
    }

    if (this.localCrushed()) {
      return '¡Plaf! El barril te ha aplastado.';
    }

    return this.started() ? 'Para el barril lo más abajo posible sin que te aplaste.' : 'Prepárate: el barril empieza a caer en cuanto acabe la cuenta.';
  });

  constructor() {
    effect(() => {
      // Ronda nueva (o recarga a mitad de ronda): se parte del estado del servidor una sola vez.
      const state = this.state();

      if (!state || state.roundId === this.roundId) {
        return;
      }

      this.roundId = state.roundId;
      const mine = state.racers.find((racer) => racer.playerId === this.currentPlayerId);
      untracked(() => {
        this.localStop.set(mine?.status === 'stopped' && mine.height !== null ? { elapsedMs: mine.elapsedMs || 0, height: mine.height } : null);
        this.localCrushed.set(mine?.status === 'crushed');
      });
    });

    effect(() => {
      // Pitidos de la cuenta atras y salida (sin repetirla si se entra con la caida ya empezada).
      const seconds = this.countdown.seconds();

      if (seconds === this.lastCountdownSecond || this.state()?.stage !== 'falling') {
        return;
      }

      const first = this.lastCountdownSecond < 0;
      this.lastCountdownSecond = seconds;
      untracked(() => {
        if (seconds > 0) {
          this.audioService.playEffect('tick');
        } else if (!first || this.goTimer.remainingMs() > 0) {
          this.audioService.playEffect('spin-start');
        }
      });
    });

    effect(() => {
      const ranking = this.state()?.ranking;

      if (ranking && !this.resultsAnnounced) {
        this.resultsAnnounced = true;
        const mine = ranking.find((entry) => entry.playerId === this.currentPlayerId);
        untracked(() => this.audioService.playEffect(mine?.position === 1 && mine.status === 'stopped' ? 'victory' : 'points'));
      }
    });

    effect(() => {
      this.canStop();
      this.finished();
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

    const state = this.state();

    if (this.destroyed || !state) {
      return;
    }

    try {
      // Si se entra con la caida ya en marcha no se repite el zoom de la intro.
      const skipIntro = this.matchService.serverNow() > state.startsAt - 1500;
      this.scene = new BarrelsScene(
        THREE,
        this.canvasRef().nativeElement,
        this.rootRef().nativeElement,
        this.labelsRef().nativeElement,
        this.columns(),
        state.startHeight,
        environment.apiUrl,
        (playerId) => this.columnState(playerId),
        skipIntro,
      );
    } catch {
      this.unsupported.set(true);
      return;
    }

    this.scene.onFrame = () => this.onFrame();
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

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || event.repeat) {
      return;
    }

    event.preventDefault();
    this.stop();
  }

  /** Para el barril propio al instante (sin esperar al servidor) y despues comunica el tiempo de caida. */
  stop(): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canStop()) {
      return;
    }

    const elapsedMs = this.matchService.serverNow() - state.startsAt;

    if (elapsedMs < 0) {
      return;
    }

    if (elapsedMs >= state.fallMs) {
      this.crushLocally(state, lobbyId);
      return;
    }

    this.localStop.set({ elapsedMs, height: heightAt(state, elapsedMs) });
    this.audioService.playEffect('confirm');
    // La respuesta no cambia lo que ve el jugador: el servidor solo la valida para la clasificacion.
    void this.matchService.stopBarrel(lobbyId, state.roundId, Math.round(elapsedMs));
  }

  private crushLocally(state: BarrelsPublicState, lobbyId: string): void {
    if (this.finished()) {
      return;
    }

    this.localCrushed.set(true);
    this.audioService.playEffect('defeat');
    // Avisar acelera la clasificacion: el servidor no tiene que esperar al margen de cortesia.
    void this.matchService.stopBarrel(lobbyId, state.roundId, state.fallMs);
  }

  /** Cada fotograma: si el barril propio llega a la cabeza sin haberlo parado, aplasta al instante. */
  private onFrame(): void {
    const state = this.state();

    if (!state) {
      return;
    }

    const elapsed = this.matchService.serverNow() - state.startsAt;

    if (this.isRacer() && !this.localStop() && !this.localCrushed() && state.stage === 'falling' && elapsed >= state.fallMs) {
      const lobbyId = this.matchService.match()?.lobbyId;

      if (lobbyId) {
        this.crushLocally(state, lobbyId);
      }
    }
  }

  /** Que se dibuja de cada jugador. El local usa solo su estado local; los rivales, lo que dice el servidor. */
  private columnState(playerId: string): BarrelColumnState {
    const state = this.state();

    if (!state) {
      return { height: 50, crushed: false, mood: 'look-up' };
    }

    const elapsed = this.matchService.serverNow() - state.startsAt;
    const winner = state.ranking?.[0];
    const celebrating = Boolean(winner && winner.playerId === playerId && winner.status === 'stopped');

    if (playerId === this.currentPlayerId) {
      const stop = this.localStop();

      if (stop) {
        return { height: stop.height, crushed: false, mood: celebrating ? 'dance-small' : 'relief' };
      }

      return this.localCrushed() ? { height: 0, crushed: true, mood: 'dizzy' } : { height: heightAt(state, elapsed), crushed: false, mood: 'look-up' };
    }

    const racer = state.racers.find((item) => item.playerId === playerId);
    let height = heightAt(state, elapsed - REMOTE_DELAY_MS);

    if (racer?.status === 'stopped' && racer.height !== null) {
      // Cae al mismo ritmo hasta su altura de parada y ahi se queda.
      height = Math.max(height, racer.height);
      return { height, crushed: false, mood: height <= racer.height + 0.001 ? (celebrating ? 'dance-small' : 'relief') : 'look-up' };
    }

    if (racer?.status === 'crushed' && (height <= 0 || state.stage === 'results')) {
      return { height: 0, crushed: true, mood: 'dizzy' };
    }

    // Sin noticias aun: nunca se le aplasta por adelantado; espera en 0 m a que el servidor lo confirme.
    return { height, crushed: false, mood: 'look-up' };
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
