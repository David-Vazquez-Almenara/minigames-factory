import { AfterViewInit, Component, ElementRef, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { BlackjackOutcome, BlackjackPublicState, BlackjackSeat } from '../../../../core/services/socket.service';
import { MiiMood } from '../../../../shared/components/mii-stage/mii-rig';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { BlackjackFocus, BlackjackScene, BlackjackSceneState, chipTier } from './blackjack-scene';

type DockMode = 'loading' | 'bet' | 'bet-confirmed' | 'turn' | 'watch' | 'summary' | 'final' | 'spectator';
type SummaryResult = NonNullable<BlackjackPublicState['lastSummary']>['results'][number];

// Vista general al entrar en la mesa antes de ir al asiento propio.
const INTRO_OVERVIEW_MS = 2400;
const WIDE_LAYOUT_PX = 960;

@Component({
  selector: 'app-blackjack',
  imports: [PlayerAvatarComponent],
  templateUrl: './blackjack.component.html',
  styleUrl: './blackjack.component.scss',
})
export class BlackjackComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private readonly panelRef = viewChild.required<ElementRef<HTMLElement>>('panel');
  private scene?: BlackjackScene;
  private insetObserver?: ResizeObserver;
  private introTimer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  private lastBetHand = 0;
  private lastSoundKey = '';

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.blackjack || null);
  readonly sceneReady = signal(false);
  readonly unsupported = signal(false);
  readonly introDone = signal(false);
  readonly betAmount = signal(50);
  readonly pending = signal(false);
  readonly errorMessage = signal('');
  readonly panelOpen = signal(window.innerWidth >= WIDE_LAYOUT_PX);
  readonly quickAmounts = [10, 25, 50, 100];

  readonly betTimer = this.timerService.countdown(() => (this.state()?.stage === 'betting' ? this.state()?.betEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 30000,
  });
  readonly turnTimer = this.timerService.countdown(() => (this.state()?.stage === 'player-turns' ? this.state()?.turnEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 30000,
  });
  readonly summaryTimer = this.timerService.countdown(() => (this.state()?.stage === 'hand-summary' ? this.state()?.summaryEndsAt : null), {
    paused: () => this.matchService.hostPaused(),
  });

  // Cambio de grupo: a mitad de la transicion se levanta un grupo y se sienta el siguiente.
  readonly groupSwapTimer = this.timerService.countdown(() => {
    const state = this.state();
    return state?.stage === 'group-change' && state.groupChangeEndsAt ? state.groupChangeEndsAt - state.groupChangeMs / 2 : null;
  });

  readonly me = computed(() => this.state()?.players.find((player) => player.playerId === this.currentPlayerId) || null);
  readonly myGroup = computed(() => this.state()?.groups.findIndex((group) => group.includes(this.currentPlayerId)) ?? -1);
  readonly groupCount = computed(() => this.state()?.groups.length || 1);
  /**
   * Grupo sentado a la mesa en pantalla: mientras se apuesta (todos a la vez) y cuando juega el crupier y se ven
   * los resultados, el grupo de este jugador; mientras se juega, el grupo al que le toca.
   */
  readonly displayedGroup = computed(() => {
    const state = this.state();

    if (!state) {
      return 0;
    }

    const own = this.myGroup() >= 0 ? this.myGroup() : state.groupIndex;

    switch (state.stage) {
      case 'group-change':
        // Sin grupo anterior es el primer cambio tras las apuestas: cada uno se levanta de su propia mesa.
        return this.groupSwapTimer.remainingMs() > 0 ? (state.previousGroupIndex ?? own) : state.groupIndex;
      case 'betting':
        return own;
      case 'dealer-turn':
      case 'hand-summary':
      case 'final':
        return this.myGroup() >= 0 ? this.myGroup() : state.groupIndex;
      default:
        return state.groupIndex;
    }
  });
  readonly canBet = computed(() => this.state()?.stage === 'betting' && this.me()?.status === 'betting' && !this.me()?.confirmed);
  readonly isMyTurn = computed(
    () =>
      this.state()?.stage === 'player-turns' &&
      !this.state()?.turnLocked &&
      this.state()?.currentPlayerId === this.currentPlayerId &&
      this.me()?.status === 'playing',
  );
  readonly minBet = computed(() => this.state()?.minBet || 10);
  readonly maxBet = computed(() => this.me()?.chips || 0);
  readonly chipsIfLose = computed(() => Math.max(0, this.maxBet() - this.betAmount()));
  readonly betFill = computed(() => {
    const range = this.maxBet() - this.minBet();
    return `${range > 0 ? ((this.betAmount() - this.minBet()) / range) * 100 : 100}%`;
  });

  /** Resumen de la mano en curso (solo mientras se muestra el resultado o la clasificacion). */
  readonly summary = computed(() => {
    const state = this.state();
    return state?.lastSummary && state.lastSummary.hand === state.handNumber && (state.stage === 'hand-summary' || state.stage === 'final')
      ? state.lastSummary
      : null;
  });
  readonly mySummary = computed(() => this.summary()?.results.find((result) => result.playerId === this.currentPlayerId) || null);

  readonly seats = computed(() => {
    const state = this.state();

    if (!state) {
      return [];
    }

    return state.players.map((player) => {
      const result = this.summary()?.results.find((entry) => entry.playerId === player.playerId) || null;
      const isActive = state.stage === 'player-turns' && state.currentPlayerId === player.playerId;
      const colorId = this.matchService.playerColor(player.playerId);
      const tier = chipTier(player.chips, state.startChips);

      return {
        ...player,
        name: this.matchService.playerName(player.playerId),
        avatarUrl: this.matchService.playerAvatar(player.playerId),
        colorId,
        shirt: getPlayerColor(colorId).body,
        isLocal: player.playerId === this.currentPlayerId,
        isActive,
        connected: this.matchService.isPlayerActive(player.playerId),
        tierColor: tier.color,
        tierLabel: tier.label,
        result: result?.outcome || null,
        delta: result?.delta || 0,
        statusLabel: this.statusLabel(player, state, result),
        // En la mesa 3D no se anuncia el blackjack: solo se ve el 21 (el panel de jugadores si lo dice).
        boardLabel: this.statusLabel(player, state, result, true),
        sumLabel: this.sumLabel(player),
        mood: this.moodFor(player, state, result, isActive),
      };
    });
  });

  /** Grupo que se sienta durante el cambio de mesa (para el cartel). */
  readonly incomingGroup = computed(() => {
    const group = this.state()?.groups[this.state()?.groupIndex || 0] || [];
    return this.seats().filter((seat) => group.includes(seat.playerId));
  });

  /** Jugadores sentados ahora en la mesa en pantalla (el resto aparece en el panel lateral). */
  readonly tableSeats = computed(() => {
    const group = this.state()?.groups[this.displayedGroup()] || [];
    return this.seats().filter((seat) => group.includes(seat.playerId));
  });

  readonly dealerSum = computed(() => {
    const dealer = this.state()?.dealer;

    if (!dealer?.cards.length) {
      return '';
    }

    if (!dealer.revealed) {
      return `${dealer.value.total} + ?`;
    }

    return dealer.value.total > 21 ? `${dealer.value.total} · Se pasa` : `${dealer.value.total}`;
  });

  readonly currentName = computed(() => this.matchService.playerName(this.state()?.currentPlayerId));

  readonly stageLabel = computed(() => {
    const state = this.state();

    switch (state?.stage) {
      case 'betting':
        return 'Apuestas';
      case 'dealing':
        return 'Repartiendo';
      case 'player-turns':
        return state.currentPlayerId === this.currentPlayerId ? 'Tu turno' : `Turno de ${this.currentName()}`;
      case 'group-change':
        return `Cambio de mesa: grupo ${state.groupIndex + 1}`;
      case 'dealer-turn':
        return 'Juega el crupier';
      case 'hand-summary':
        return 'Resultado de la mano';
      case 'final':
        return 'Clasificación final';
      default:
        return 'Preparando la mesa';
    }
  });

  readonly timerSeconds = computed(() => {
    switch (this.state()?.stage) {
      case 'betting':
        return this.betTimer.seconds();
      case 'player-turns':
        return this.turnTimer.seconds();
      default:
        return null;
    }
  });

  readonly dockMode = computed<DockMode>(() => {
    const state = this.state();

    if (!state) {
      return 'loading';
    }

    if (state.stage === 'final') {
      return 'final';
    }

    if (state.stage === 'hand-summary') {
      return 'summary';
    }

    if (!this.me()) {
      return 'spectator';
    }

    if (state.stage === 'betting') {
      return this.canBet() ? 'bet' : 'bet-confirmed';
    }

    return this.isMyTurn() ? 'turn' : 'watch';
  });

  readonly watchText = computed(() => {
    const state = this.state();
    const me = this.me();

    if (!state || !me) {
      return 'Estás viendo la mesa.';
    }

    const myTable = this.myGroup() + 1;

    if (state.stage === 'group-change') {
      return `Cambio de mesa: se sienta el grupo ${state.groupIndex + 1}.${myTable === state.groupIndex + 1 ? ' ¡Es tu grupo!' : ''}`;
    }

    // Su grupo aun no ha jugado esta mano: espera fuera de la mesa (con la apuesta ya hecha).
    if (me.status === 'queued') {
      return `Ahora juega el grupo ${state.groupIndex + 1}. Tú juegas con el grupo ${myTable} (apuesta: ${me.bet} fichas).`;
    }

    if (state.stage === 'betting') {
      if (me.status === 'broke') {
        return 'Te has quedado sin fichas: miras la partida desde tu asiento.';
      }

      return me.status === 'sitting-out'
        ? 'No juegas esta mano. Esperando a que apuesten todos los grupos…'
        : `Apuesta confirmada: ${me.bet} fichas. Esperando a que apuesten todos los grupos…`;
    }

    if (state.stage === 'dealing') {
      return 'Repartiendo: una carta a cada jugador, la segunda y después las del crupier.';
    }

    if (state.stage === 'dealer-turn') {
      return `El crupier tiene ${this.dealerSum()}. Se planta con 17 o en cuanto ya os gana a todos.`;
    }

    switch (me.status) {
      case 'blackjack':
        return '¡Blackjack! Se paga 3 a 2 si el crupier no iguala.';
      case 'bust':
        return `Te has pasado con ${me.value.total}. Esperando al resto…`;
      case 'stood':
        return `Te plantas con ${me.value.total}. Esperando al resto…`;
      case 'sitting-out':
        return 'No juegas esta mano: mira la partida.';
      case 'broke':
        return 'Sin fichas: miras la partida desde tu asiento.';
      default:
        return `Turno de ${this.currentName()}. Tu mano: ${me.value.total}.`;
    }
  });

  readonly summaryText = computed(() => {
    const summary = this.summary();
    const mine = this.mySummary();
    const dealer = summary ? (summary.dealerBust ? `El crupier se pasa con ${summary.dealerTotal}.` : `El crupier tiene ${summary.dealerTotal}.`) : '';

    if (!mine) {
      return { title: 'Mano terminada', detail: dealer, tone: 'neutral' };
    }

    switch (mine.outcome) {
      case 'blackjack':
        return { title: `¡Blackjack! +${mine.delta}`, detail: `Tu blackjack se paga 3 a 2. ${dealer}`, tone: 'win' };
      case 'win':
        return { title: `¡Ganas! +${mine.delta}`, detail: `Tienes ${mine.total}. ${dealer}`, tone: 'win' };
      case 'push':
        return { title: 'Empate', detail: `Recuperas tus ${mine.bet} fichas. ${dealer}`, tone: 'neutral' };
      case 'lose':
        return { title: `Pierdes −${mine.bet}`, detail: mine.total > 21 ? `Te pasaste con ${mine.total}.` : `Tienes ${mine.total}. ${dealer}`, tone: 'lose' };
      default:
        return { title: 'No jugabas esta mano', detail: dealer, tone: 'neutral' };
    }
  });

  readonly mySeat = computed(() => this.seats().find((seat) => seat.isLocal) || null);

  readonly ranking = computed(() =>
    (this.state()?.finalRanking || []).map((entry) => ({
      ...entry,
      avatarUrl: this.matchService.playerAvatar(entry.playerId),
      colorId: this.matchService.playerColor(entry.playerId),
      mine: entry.playerId === this.currentPlayerId,
      netText: entry.net > 0 ? `+${entry.net}` : entry.net < 0 ? `−${Math.abs(entry.net)}` : '0',
      pointsText: entry.points > 0 ? `+${entry.points}` : entry.points < 0 ? `−${Math.abs(entry.points)}` : '0',
      cells: Array.from({ length: this.state()?.totalHands || 3 }, (_unused, index) => this.handCell(entry.hands.find((item) => item.hand === index + 1))),
    })),
  );

  /** Que encuadra la camara en cada fase; la escena se encarga de la transicion. */
  readonly focus = computed<BlackjackFocus>(() => {
    const state = this.state();
    const me = this.me();

    if (!state || !this.introDone()) {
      return { kind: 'overview' };
    }

    switch (state.stage) {
      case 'betting':
        // Su asiento solo si es su grupo el que apuesta; si no, la mesa entera.
        return me && (me.status === 'betting' || me.status === 'ready') ? { kind: 'seat', playerId: me.playerId } : { kind: 'overview' };
      case 'player-turns':
        // Durante la pausa tras plantarse o pasarse la camara sigue en ese mismo jugador.
        return state.currentPlayerId ? { kind: 'cards', playerId: state.currentPlayerId } : { kind: 'overview' };
      case 'group-change':
        return { kind: 'swap', group: state.groupIndex };
      case 'dealer-turn':
        return { kind: 'dealer' };
      default:
        return { kind: 'overview' };
    }
  });

  constructor() {
    effect(() => {
      const sceneState = this.sceneState();

      if (this.sceneReady() && sceneState) {
        untracked(() => this.scene?.sync(sceneState));
      }
    });

    effect(() => {
      const focus = this.focus();

      if (this.sceneReady()) {
        untracked(() => this.scene?.setFocus(focus));
      }
    });

    effect(() => {
      // Cada mano nueva parte de la apuesta anterior, ajustada al saldo que queda.
      const state = this.state();

      if (state?.stage === 'betting' && state.handNumber !== this.lastBetHand && this.me()) {
        this.lastBetHand = state.handNumber;
        untracked(() => this.betAmount.set(this.clampBet(this.betAmount())));
      }
    });

    effect(() => {
      const state = this.state();

      if (!state) {
        return;
      }

      const key = `${state.handNumber}:${state.stage}:${state.currentPlayerId || ''}`;

      if (key !== this.lastSoundKey) {
        this.lastSoundKey = key;
        untracked(() => this.playStageSound(state));
      }
    });

    effect(() => {
      this.panelOpen();
      this.dockMode();

      if (this.sceneReady()) {
        untracked(() => queueMicrotask(() => this.updateInsets()));
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

    const initial = this.sceneState();

    if (this.destroyed || !initial) {
      return;
    }

    try {
      this.scene = new BlackjackScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, initial, environment.apiUrl, this.dealerSeed());
    } catch {
      // Sin WebGL los controles siguen funcionando con el panel de jugadores.
      this.unsupported.set(true);
      this.panelOpen.set(true);
      return;
    }

    this.scene.onCardDealt = () => this.audioService.playSfx('carta-repartir', { rate: 0.94 + Math.random() * 0.12 });
    this.scene.onCardFlipped = () => this.audioService.playSfx('carta-voltear');
    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.rootRef(), this.topBarRef(), this.dockRef(), this.panelRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.introTimer = setTimeout(() => this.introDone.set(true), INTRO_OVERVIEW_MS);
    this.sceneReady.set(true);
    this.updateInsets();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.introTimer);
    this.insetObserver?.disconnect();
    this.scene?.dispose();
    this.scene = undefined;
  }

  togglePanel(): void {
    this.panelOpen.update((open) => !open);
  }

  addBet(amount: number): void {
    this.betAmount.set(this.clampBet(this.betAmount() + amount));
    this.audioService.playSfx('fichas', { gain: 0.7, rate: 1.1 });
  }

  setBetFromSlider(event: Event): void {
    this.betAmount.set(this.clampBet(Number((event.target as HTMLInputElement).value)));
  }

  allIn(): void {
    this.betAmount.set(this.maxBet());
    this.audioService.playSfx('fichas', { rate: 0.9 });
  }

  resetBet(): void {
    this.betAmount.set(this.clampBet(this.minBet()));
  }

  confirmBet(): void {
    void this.placeBet(this.clampBet(this.betAmount()));
  }

  sitOut(): void {
    void this.placeBet(0);
  }

  async act(action: 'hit' | 'stand'): Promise<void> {
    const lobbyId = this.matchService.match()?.lobbyId;
    const token = this.state()?.turnToken;

    if (!lobbyId || !token || !this.isMyTurn() || this.pending()) {
      return;
    }

    this.pending.set(true);
    this.errorMessage.set('');
    // El token de turno hace que un doble clic o un reintento solo cuente una vez en el servidor.
    const response = await this.matchService.blackjackAction(lobbyId, action, token);
    this.pending.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo hacer la jugada.');
    }
  }

  private async placeBet(amount: number): Promise<void> {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canBet() || this.pending()) {
      return;
    }

    this.pending.set(true);
    this.errorMessage.set('');
    const response = await this.matchService.betBlackjack(lobbyId, state.handNumber, amount);
    this.pending.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo apostar.');
      return;
    }

    if (amount > 0) {
      this.audioService.playSfx('fichas');
    } else {
      this.audioService.playEffect('select');
    }
  }

  /** Semilla de la cara del crupier: la misma para todos los jugadores de esta ronda. */
  private dealerSeed(): string {
    const match = this.matchService.match();
    return `${match?.lobbyId || ''}:${match?.roundNumber || 0}`;
  }

  private clampBet(value: number): number {
    return Math.min(this.maxBet(), Math.max(this.minBet(), Math.round(value) || this.minBet()));
  }

  private sceneState(): BlackjackSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    return {
      handNumber: state.handNumber,
      layoutSeats: Math.min(state.tableSize || 4, state.players.length),
      seats: this.tableSeats().map((seat) => ({
        playerId: seat.playerId,
        name: seat.name,
        avatarUrl: seat.avatarUrl,
        shirt: seat.shirt,
        chips: seat.chips,
        startChips: state.startChips,
        bet: seat.bet,
        cards: seat.cards,
        mood: seat.mood,
        isLocal: seat.isLocal,
        isActive: seat.isActive,
        result: seat.result,
        payout: Math.max(0, seat.delta),
      })),
      dealerCards: state.dealer.cards,
      dealOrder: state.dealOrder,
      // El servidor marca el inicio del reparto en su reloj; se pasa al reloj local de animacion.
      dealStartsAt: state.dealStartedAt ? performance.now() + (state.dealStartedAt - this.matchService.serverNow()) : null,
      dealInterval: state.dealInterval,
    };
  }

  /** Las zonas tapadas por el HUD se descuentan del encuadre de la camara. */
  private updateInsets(): void {
    const scene = this.scene;

    if (!scene || this.destroyed) {
      return;
    }

    const root = this.rootRef().nativeElement.getBoundingClientRect();
    const top = this.topBarRef().nativeElement.getBoundingClientRect();
    const dock = this.dockRef().nativeElement.getBoundingClientRect();
    const panel = this.panelRef().nativeElement.getBoundingClientRect();
    const wide = root.width >= WIDE_LAYOUT_PX;
    // El panel lateral se descuenta por los dos lados por igual: asi la mesa queda centrada en la pantalla.
    const side = wide && this.panelOpen() && panel.width ? Math.max(0, root.right - panel.left + 6) : 0;

    scene.setInsets({
      top: Math.max(0, top.bottom - root.top + 6),
      bottom: dock.height ? Math.max(0, root.bottom - dock.top + 6) : 0,
      right: side,
      left: side,
    });
  }

  private playStageSound(state: BlackjackPublicState): void {
    if (state.stage === 'player-turns' && state.currentPlayerId === this.currentPlayerId) {
      this.audioService.playEffect('turn');
    } else if (state.stage === 'hand-summary') {
      const mine = state.lastSummary?.results.find((result) => result.playerId === this.currentPlayerId);

      // Solo suena al ganar la mano: al perder no hay sonido de derrota.
      if (mine?.outcome === 'blackjack' || mine?.outcome === 'win') {
        this.audioService.playFileEffect('win');
      }
    } else if (state.stage === 'final') {
      this.audioService.playEffect('points');
    }
  }

  private statusLabel(player: BlackjackSeat, state: BlackjackPublicState, result: SummaryResult | null, board = false): string {
    if (result) {
      switch (result.outcome) {
        case 'win':
          return `Gana +${result.delta}`;
        case 'blackjack':
          return board ? `Gana +${result.delta}` : `Blackjack +${result.delta}`;
        case 'push':
          return 'Empate';
        case 'lose':
          return `Pierde −${result.bet}`;
        default:
          return player.status === 'broke' ? 'Sin fichas' : 'No juega';
      }
    }

    switch (player.status) {
      case 'queued':
        return 'Espera su mesa';
      case 'betting':
        return 'Apostando…';
      case 'ready':
        return 'Apuesta lista';
      case 'sitting-out':
        return 'No juega';
      case 'broke':
        return 'Sin fichas';
      case 'playing':
        return state.currentPlayerId === player.playerId ? 'Su turno' : 'Esperando';
      case 'blackjack':
        return board ? 'Se planta' : '¡Blackjack!';
      case 'stood':
        return 'Se planta';
      case 'bust':
        return 'Se pasa';
      default:
        return 'Esperando';
    }
  }

  private sumLabel(player: BlackjackSeat): string {
    if (!player.cards.length) {
      return '';
    }

    const { total, soft } = player.value;

    if (total > 21) {
      return `${total} · Se pasa`;
    }

    // Con un as que aun puede valer 1 u 11 se muestran los dos valores mientras se juega.
    return soft && total < 21 && player.status === 'playing' ? `${total - 10} / ${total}` : `${total}`;
  }

  private moodFor(player: BlackjackSeat, state: BlackjackPublicState, result: SummaryResult | null, isActive: boolean): MiiMood {
    if (state.stage === 'final') {
      const net = player.chips - state.startChips;
      return net > 0 ? 'seated-happy' : net < 0 ? 'seated-sad' : 'seated';
    }

    if (result) {
      return result.outcome === 'win' || result.outcome === 'blackjack' ? 'seated-happy' : result.outcome === 'lose' ? 'seated-sad' : 'seated';
    }

    if (isActive) {
      return 'seated-active';
    }

    if (player.status === 'blackjack') {
      return 'seated-happy';
    }

    return player.status === 'bust' || player.status === 'broke' ? 'seated-sad' : 'seated';
  }

  private handCell(hand: { outcome: BlackjackOutcome; delta: number } | undefined): { text: string; tone: string } {
    if (!hand || hand.outcome === 'sat-out') {
      return { text: '—', tone: 'neutral' };
    }

    if (hand.outcome === 'push') {
      return { text: '=', tone: 'neutral' };
    }

    if (hand.delta > 0) {
      return { text: `${hand.outcome === 'blackjack' ? 'BJ ' : ''}+${hand.delta}`, tone: 'win' };
    }

    return { text: `−${Math.abs(hand.delta)}`, tone: 'lose' };
  }
}
