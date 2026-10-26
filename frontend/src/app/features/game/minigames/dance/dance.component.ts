import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { DANCE_MAX_VISIBLE, DancePlayerView, DanceScene, DanceSceneState, DancerMood } from './dance-scene';

type DanceMode = 'keys' | 'colors';
type LocalResult = 'done' | 'fail';

// Paleta del modo por colores: solidos y bien distintos (mismo orden que los indices que envia el servidor).
export const DANCE_PALETTE: Array<{ name: string; hex: string }> = [
  { name: 'Rojo', hex: '#e8262b' },
  { name: 'Azul', hex: '#1d5bff' },
  { name: 'Verde', hex: '#1fae45' },
  { name: 'Amarillo', hex: '#ffd60a' },
  { name: 'Naranja', hex: '#ff8a00' },
  { name: 'Morado', hex: '#8a2be2' },
  { name: 'Rosa', hex: '#ff4fb0' },
  { name: 'Cian', hex: '#00c8e6' },
  { name: 'Marrón', hex: '#7a4a24' },
  { name: 'Negro', hex: '#111111' },
  { name: 'Blanco', hex: '#ffffff' },
  { name: 'Gris', hex: '#8f8f8f' },
];

const MODE_STORAGE_KEY = 'minigames-dance-mode';
// Ancho (px) de cada paso de la tira, separador incluido; debe coincidir con el SCSS.
const STEP_PX = 92;
const TILE_PX = 64;

function storedMode(): DanceMode {
  try {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);

    if (saved === 'keys' || saved === 'colors') {
      return saved;
    }
  } catch {
    // Sin almacenamiento: se decide por el tipo de pantalla.
  }

  // En pantallas tactiles (movil) no hay teclado fisico: por defecto, colores.
  return window.matchMedia?.('(pointer: coarse)').matches ? 'colors' : 'keys';
}

@Component({
  selector: 'app-dance',
  imports: [PlayerAvatarComponent],
  templateUrl: './dance.component.html',
  styleUrl: './dance.component.scss',
})
export class DanceComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private scene?: DanceScene;
  private insetObserver?: ResizeObserver;
  private destroyed = false;
  private localRound = 0;
  private lastCountdownSecond = -1;
  private announcedBreak = 0;

  readonly palette = DANCE_PALETTE;
  readonly stepPx = STEP_PX;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.dance || null);
  readonly unsupported = signal(false);
  readonly mode = signal<DanceMode>(storedMode());
  readonly popupDismissed = signal(false);
  /** Avance local en la secuencia de la ronda: lo decide este cliente al instante, sin esperar a nadie. */
  readonly progress = signal(0);
  readonly localResult = signal<LocalResult | null>(null);
  /** Por que ha caido este jugador en la ronda: tecla equivocada o fin del tiempo. */
  readonly failReason = signal<'wrong' | 'time' | null>(null);
  readonly shakeSeq = signal(0);

  readonly startTimer = this.timerService.countdown(() => this.state()?.roundStartsAt, { paused: () => this.matchService.hostPaused() });
  readonly roundTimer = this.timerService.countdown(() => (this.state()?.stage === 'playing' ? this.state()?.roundEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: () => this.state()?.timesMs[(this.state()?.round || 1) - 1] || 15000,
    onExpire: () => this.timeUp(),
  });

  readonly started = computed(() => this.state()?.stage === 'playing' && this.startTimer.remainingMs() <= 0);
  readonly eliminatedRound = computed(() => this.state()?.eliminated.find((entry) => entry.playerId === this.currentPlayerId)?.round ?? null);
  readonly isDancer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly alive = computed(() => Boolean(this.state()?.alive.includes(this.currentPlayerId)) && this.localResult() !== 'fail');
  readonly canPlay = computed(() => this.started() && this.alive() && this.localResult() === null);
  readonly sequence = computed(() => {
    const state = this.state();
    const round = state?.sequences[(state?.round || 1) - 1];
    return round ? (this.mode() === 'colors' ? round.colors.map(String) : round.letters) : [];
  });
  /** Pasos de la tira: los ya pulsados se van a la izquierda; solo se ven el actual y, oscurecido, el siguiente. */
  readonly steps = computed(() =>
    this.sequence().map((value, index) => ({
      index,
      value,
      color: this.mode() === 'colors' ? DANCE_PALETTE[Number(value)] : null,
      state: index < this.progress() ? (index === this.progress() - 1 ? 'prev' : 'gone') : index === this.progress() ? 'current' : index === this.progress() + 1 ? 'next' : 'hidden',
    })),
  );
  // Desplaza la tira para que la ficha actual quede centrada (centro de ficha = inicio del paso + media ficha).
  readonly stripOffset = computed(() => `translateX(${-(Math.min(this.progress(), this.sequence().length - 1) * STEP_PX + TILE_PX / 2)}px)`);
  readonly showPopup = computed(
    () => !this.popupDismissed() && this.isDancer() && this.state()?.round === 1 && this.state()?.stage === 'playing' && this.startTimer.remainingMs() > 3000,
  );
  readonly roundMs = computed(() => this.state()?.timesMs[(this.state()?.round || 1) - 1] || 15000);
  readonly roundSeconds = computed(() => Math.round(this.roundMs() / 1000));
  /** "¡A bailar!" durante el primer segundo de la ronda. */
  readonly showGo = computed(() => this.started() && this.alive() && this.roundTimer.remainingMs() > this.roundMs() - 900);
  readonly showCountdown = computed(() => this.state()?.stage === 'playing' && !this.showPopup() && this.startTimer.remainingMs() > 0 && this.startTimer.remainingMs() <= 3000);

  readonly visiblePlayers = computed<DancePlayerView[]>(() => {
    const ids = this.matchService.match()?.specialRound?.participantIds || [];
    // El jugador local siempre el primero (fila delantera, centro); el resto, hasta llenar el escenario.
    const ordered = [...ids.filter((id) => id === this.currentPlayerId), ...ids.filter((id) => id !== this.currentPlayerId)].slice(0, DANCE_MAX_VISIBLE);
    return ordered.map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
      isLocal: playerId === this.currentPlayerId,
    }));
  });

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state) {
      return 'Preparando la pista…';
    }

    if (state.stage === 'finished') {
      return 'Se acabó la música.';
    }

    if (!this.isDancer()) {
      return 'Estás mirando cómo bailan los demás.';
    }

    if (!this.alive()) {
      return this.eliminatedRound() !== null && this.eliminatedRound()! < state.round ? 'Estás fuera: mira cómo bailan los demás.'
        : this.failReason() === 'wrong'
          ? '¡Te has equivocado! Esperas cabizbajo a que acabe la ronda.'
          : '¡Se acabó el tiempo! Esperas cabizbajo a que acabe la ronda.';
    }

    if (state.stage === 'break') {
      return '¡Ronda superada! Todos a aplaudir.';
    }

    if (!this.started()) {
      return `Ronda ${state.round}: ${state.lengths[state.round - 1]} ${this.mode() === 'colors' ? 'colores' : 'letras'} en ${Math.round(state.timesMs[state.round - 1] / 1000)} s.`;
    }

    if (this.localResult() === 'done') {
      return 'Sigue bailando mientras terminan los demás.';
    }

    return this.mode() === 'colors' ? 'Pulsa los colores del panel de arriba en orden.' : 'Pulsa las letras en orden con el teclado.';
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((entry) => ({
      ...entry,
      avatarUrl: this.matchService.playerAvatar(entry.playerId),
      colorId: this.matchService.playerColor(entry.playerId),
      mine: entry.playerId === this.currentPlayerId,
      pointsText: entry.points < 0 ? `−${-entry.points}` : `+${entry.points}`,
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
      // Ronda nueva: la secuencia empieza de cero.
      const round = this.state()?.round || 0;

      if (round !== this.localRound) {
        this.localRound = round;
        untracked(() => {
          this.progress.set(0);
          this.localResult.set(null);
          this.failReason.set(null);
        });
      }
    });

    effect(() => {
      // Cuenta atras 3, 2, 1 y salida.
      const state = this.state();
      const seconds = this.startTimer.seconds();

      if (!state || state.stage !== 'playing' || seconds === this.lastCountdownSecond || this.showPopup()) {
        return;
      }

      this.lastCountdownSecond = seconds;
      untracked(() => {
        if (seconds > 0 && seconds <= 3) {
          this.audioService.playEffect('tick');
        } else if (seconds === 0) {
          this.audioService.playEffect('reveal');
        }
      });
    });

    effect(() => {
      // Ronda superada: aplausos y sonido de victoria (solo si sigues en pie).
      const state = this.state();

      if (state?.stage === 'break' && state.round !== this.announcedBreak) {
        this.announcedBreak = state.round;

        if (untracked(this.alive)) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });

    effect(() => {
      this.mode();
      this.canPlay();
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

    if (this.destroyed || !this.state()) {
      return;
    }

    try {
      this.scene = new DanceScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, this.visiblePlayers(), environment.apiUrl);
    } catch {
      this.unsupported.set(true);
      return;
    }

    // Quien ya cayo en rondas anteriores (al entrar tarde o recargar) no aparece en el escenario.
    const state = this.state();

    for (const entry of state?.eliminated || []) {
      if (entry.round < (state?.round || 0) || state?.stage === 'finished') {
        this.scene.removeNow(entry.playerId);
      }
    }

    const sceneState = this.sceneState();

    if (sceneState) {
      this.scene.sync(sceneState);
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
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || this.mode() !== 'keys' || this.showPopup()) {
      return;
    }

    const key = event.key.toUpperCase();

    if (key.length === 1 && key >= 'A' && key <= 'Z') {
      event.preventDefault();
      this.press(key);
    }
  }

  pressColor(index: number): void {
    if (this.mode() === 'colors') {
      this.press(String(index));
    }
  }

  setMode(mode: DanceMode): void {
    this.mode.set(mode);

    try {
      localStorage.setItem(MODE_STORAGE_KEY, mode);
    } catch {
      // Solo es una preferencia: si no se puede guardar, se usa en esta partida.
    }
  }

  toggleMode(): void {
    this.setMode(this.mode() === 'keys' ? 'colors' : 'keys');
  }

  /** Ha perdido (incluido el propio jugador en cuanto se le acaba el tiempo, sin esperar al servidor). */
  isOut(playerId: string): boolean {
    if (playerId === this.currentPlayerId && this.localResult() === 'fail') {
      return true;
    }

    return Boolean(this.state()?.eliminated.some((entry) => entry.playerId === playerId));
  }

  dismissPopup(): void {
    this.popupDismissed.set(true);
  }

  /** Pulsacion (tecla o color): se comprueba aqui mismo, sin esperar al servidor. */
  private press(value: string): void {
    const state = this.state();

    if (!state || !this.canPlay()) {
      return;
    }

    // Comprobacion exacta del plazo con el reloj del servidor (el temporizador visual va a saltos).
    if (state.roundEndsAt && this.matchService.serverNow() >= state.roundEndsAt) {
      this.timeUp();
      return;
    }

    const sequence = this.sequence();
    const index = this.progress();

    if (sequence[index] !== value) {
      // Sin segundas oportunidades: una pulsacion equivocada te elimina al momento (cabizbajo hasta que acabe la
      // ronda; entonces se baja del escenario con el resto de eliminados).
      this.shakeSeq.update((seq) => seq + 1);
      this.audioService.playEffect('spin-stop');
      this.failReason.set('wrong');
      this.localResult.set('fail');
      void this.matchService.reportDance(this.lobbyId(), state.round, 'fail');
      return;
    }

    const next = index + 1;
    this.progress.set(next);
    this.scene?.pulse();

    if (next >= sequence.length) {
      this.localResult.set('done');
      this.audioService.playSfx('acierto');
      void this.matchService.reportDance(this.lobbyId(), state.round, 'done');
      return;
    }

    // Cada acierto suena un poco mas agudo que el anterior.
    this.audioService.playSfx('boton', { rate: 1 + Math.min(0.8, next * 0.04), gain: 1.4 });
  }

  /** Se acabo el tiempo sin completar la secuencia: el propio cliente se da por eliminado y lo avisa. */
  private timeUp(): void {
    const state = this.state();

    if (!state || state.stage !== 'playing' || !this.alive() || this.localResult() !== null || !this.isDancer()) {
      return;
    }

    this.localResult.set('fail');
    void this.matchService.reportDance(this.lobbyId(), state.round, 'fail');
  }

  private lobbyId(): string {
    return this.matchService.match()?.lobbyId || '';
  }

  private sceneState(): DanceSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    const eliminated = new Map(state.eliminated.map((entry) => [entry.playerId, entry.round]));
    const dancers = this.visiblePlayers().map((view) => {
      const mine = view.playerId === this.currentPlayerId;
      const outRound = mine && this.localResult() === 'fail' ? state.round : eliminated.get(view.playerId);
      let mood: DancerMood = 'idle';
      let out = false;

      if (outRound !== undefined) {
        // Cabizbajo al caer; al terminar la ronda (o si cayo antes) se va del escenario.
        mood = 'sad';
        out = outRound < state.round || state.stage !== 'playing';
      } else if (state.stage === 'finished') {
        mood = 'happy';
      } else if (state.stage === 'break') {
        mood = 'clap';
      } else if (this.started()) {
        mood = 'dance';
      }

      return { playerId: view.playerId, mood, out };
    });

    return { dancers };
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
