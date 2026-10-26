import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { BalloonPlayerView, BalloonScene, BalloonSceneState } from './balloon-scene';

// Aire con el que el "piu" del inflado llega a su tono mas agudo.
const PUMP_PITCH_FULL_AIR = 40;

@Component({
  selector: 'app-balloon',
  imports: [PlayerAvatarComponent],
  templateUrl: './balloon.component.html',
  styleUrl: './balloon.component.scss',
})
export class BalloonComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private scene?: BalloonScene;
  private insetObserver?: ResizeObserver;
  private destroyed = false;
  private localTurn = 0;
  private lastTurnSound = 0;
  private resultsAnnounced = false;
  private lastHeardPumpAt = 0;
  private lastWalkSound = 0;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.balloon || null);
  readonly unsupported = signal(false);
  /** Palancazos que este jugador ya ha dado en su turno (se cuentan al pulsar, sin esperar al servidor). */
  readonly localPumps = signal(0);
  readonly passing = signal(false);
  readonly errorMessage = signal('');

  readonly turnTimer = this.timerService.countdown(() => (this.state()?.stage === 'pumping' ? this.state()?.turnEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly isMyTurn = computed(() => this.state()?.currentPlayerId === this.currentPlayerId && !this.state()?.outcome);
  readonly pumpsDone = computed(() => Math.max(this.localPumps(), this.isMyTurn() ? this.state()?.pumpsThisTurn || 0 : 0));
  // Sin limite: cada uno le da a la palanca las veces que se atreva (como minimo una antes de pasar).
  readonly canPump = computed(() => this.isMyTurn() && this.state()?.stage === 'pumping');
  readonly canPass = computed(() => this.isMyTurn() && this.state()?.stage === 'pumping' && this.pumpsDone() > 0 && !this.passing());
  readonly currentName = computed(() => this.matchService.playerName(this.state()?.currentPlayerId));

  readonly players = computed<BalloonPlayerView[]>(() =>
    (this.state()?.order || []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
      isLocal: playerId === this.currentPlayerId,
    })),
  );

  readonly queue = computed(() => {
    const state = this.state();

    if (!state) {
      return [];
    }

    // Orden de la fila a partir del jugador en turno (el orden de la ronda 1 se mantiene en todas).
    const count = state.order.length;
    return state.order.map((_unused, offset) => {
      const playerId = state.order[(state.turnIndex + offset) % count];
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

  readonly results = computed(() =>
    (this.state()?.outcome?.results || [])
      .map((entry) => ({
        ...entry,
        avatarUrl: this.matchService.playerAvatar(entry.playerId),
        colorId: this.matchService.playerColor(entry.playerId),
        mine: entry.playerId === this.currentPlayerId,
        exploded: entry.playerId === this.state()?.outcome?.explodedBy,
      }))
      .sort((first, second) => Number(first.exploded) - Number(second.exploded)),
  );

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state) {
      return 'Preparando el escenario…';
    }

    if (state.outcome) {
      return state.outcome.explodedBy === this.currentPlayerId ? '¡Te ha explotado a ti!' : `¡Le ha explotado a ${state.outcome.explodedName}!`;
    }

    if (this.isMyTurn()) {
      return state.stage === 'walking' ? '¡Te toca! Vas hacia la palanca…' : 'Dale a la palanca las veces que quieras y pasa el turno.';
    }

    return state.stage === 'walking' ? `${this.currentName()} va hacia la palanca…` : `Turno de ${this.currentName()}: ${state.pumpsThisTurn} ${state.pumpsThisTurn === 1 ? 'palancazo' : 'palancazos'}.`;
  });

  constructor() {
    effect(() => {
      const sceneState = this.sceneState();

      if (sceneState) {
        untracked(() => this.scene?.sync(sceneState));
      }
    });

    effect(() => {
      // Turno nuevo: se reinicia el contador local y suena el aviso si le toca a este jugador.
      const state = this.state();

      if (!state || state.turnNumber === this.localTurn) {
        return;
      }

      this.localTurn = state.turnNumber;
      untracked(() => {
        this.localPumps.set(0);
        this.passing.set(false);
        this.errorMessage.set('');

        if (state.currentPlayerId === this.currentPlayerId && this.lastTurnSound !== state.turnNumber && !state.outcome) {
          this.lastTurnSound = state.turnNumber;
          this.audioService.playEffect('turn');
        }
      });
    });

    effect(() => {
      // Todos oyen los palancazos de los demas (los propios ya sonaron al pulsar) y los pasos al subir al escenario.
      const state = this.state();
      const pump = state?.lastPump;

      if (pump && pump.at !== this.lastHeardPumpAt) {
        this.lastHeardPumpAt = pump.at;

        if (pump.playerId !== this.currentPlayerId && !state.outcome) {
          untracked(() => this.playPumpSound(pump.air));
        }
      }

      if (state?.stage === 'walking' && !state.outcome && state.turnNumber !== this.lastWalkSound) {
        this.lastWalkSound = state.turnNumber;
        untracked(() => this.audioService.playSfx('pasos'));
      }
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.resultsAnnounced) {
        this.resultsAnnounced = true;
        untracked(() => {
          this.audioService.playSfx('globo-explotar');
          // A quien le explota no le suena nada mas; el resto oye que suma puntos.
          if (outcome.explodedBy !== this.currentPlayerId) {
            setTimeout(() => this.audioService.playEffect('points'), 650);
          }
          // Cuando aparece el resultado (abajo), la camara encuadra en el hueco que queda arriba.
          setTimeout(() => this.updateInsets(), 1500);
        });
      }
    });

    effect(() => {
      this.isMyTurn();
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
      this.scene = new BalloonScene(
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
    this.pump();
  }

  /**
   * Con raton o dedo el palancazo va por pointerdown (respuesta inmediata); el click que llega despues no debe
   * contar otra vez. Solo cuenta el click generado por teclado (Enter sobre el boton), que no trae pointerdown.
   */
  pumpFromKeyboard(event: MouseEvent): void {
    if (event.detail === 0) {
      this.pump();
    }
  }

  /** Palancazo: la palanca baja al instante y se envia con un token de turno (un reintento no cuenta doble). */
  pump(): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canPump()) {
      return;
    }

    const token = `${state.turnNumber}:${this.pumpsDone()}`;
    this.localPumps.set(this.pumpsDone() + 1);
    this.scene?.pullLeverNow();
    // Aire contando los palancazos propios que el servidor aun no ha confirmado.
    this.playPumpSound(state.air + Math.max(1, this.pumpsDone() - state.pumpsThisTurn));
    void this.matchService.pumpBalloon(lobbyId, token).then((response) => {
      if (!response.ok && !this.destroyed) {
        this.errorMessage.set(response.reason || 'No se pudo dar a la palanca.');
      }
    });
  }

  /** Palanca + "piu" de inflado, cada vez mas agudo segun se llena el globo (tension creciente). */
  private playPumpSound(air: number): void {
    const fill = Math.min(1, air / PUMP_PITCH_FULL_AIR);
    this.audioService.playSfx('palanca');
    this.audioService.playSfx('globo-inflar', { rate: 0.85 + fill * 1.05, gain: 0.85 + fill * 0.35 });
  }

  async passTurn(): Promise<void> {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canPass()) {
      return;
    }

    this.passing.set(true);
    const response = await this.matchService.passBalloon(lobbyId, state.turnNumber);

    if (!response.ok) {
      this.passing.set(false);
      this.errorMessage.set(response.reason || 'No se pudo pasar el turno.');
      return;
    }

    this.audioService.playEffect('select');
  }

  private sceneState(): BalloonSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    return {
      order: state.order,
      turnIndex: state.turnIndex,
      turnNumber: state.turnNumber,
      currentPlayerId: state.currentPlayerId,
      air: state.air,
      // Hora del servidor en la que empieza el turno, pasada al reloj local de animacion.
      turnStartsAt: performance.now() + ((state.turnStartsAt || 0) - this.matchService.serverNow()),
      lastPumpKey: state.lastPump ? `${state.lastPump.turnNumber}:${state.lastPump.pump}` : '',
      explodedBy: state.outcome?.explodedBy || null,
      exploded: Boolean(state.outcome),
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
