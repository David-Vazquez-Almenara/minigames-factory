import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { environment } from '../../../../../environments/environment';
import { AudioService } from '../../../../core/services/audio.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';
import { BombPlayerView, BombScene, BombSceneState } from './bomb-scene';
import { bombProblemText, bombWordProblem, normalizeBombWord } from './bomb-words';

// Cada cuanto suena la mecha mientras la bomba esta encendida.
const FUSE_SOUND_MS = 650;

@Component({
  selector: 'app-bomb',
  imports: [PlayerAvatarComponent],
  templateUrl: './bomb.component.html',
  styleUrl: './bomb.component.scss',
})
export class BombComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('nameTags');
  private readonly panelRef = viewChild.required<ElementRef<HTMLElement>>('panel');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private readonly inputRef = viewChild<ElementRef<HTMLInputElement>>('wordInput');
  private scene?: BombScene;
  private insetObserver?: ResizeObserver;
  private destroyed = false;
  private clockHandle = 0;
  private fuseHandle = 0;
  private lastFuseSound = 0;
  private boomSentTurn = 0;
  private focusedTurn = 0;
  private lastTurnSound = '';
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.bomb || null);
  /** Solo quien tiene la bomba recibe cuando explota. */
  private readonly secretFuse = computed(() => this.matchService.privateState()?.bomb || null);
  readonly unsupported = signal(false);
  readonly typed = signal('');
  readonly errorText = signal('');
  /** Cambia en cada fallo para repetir el pulso rojo del recuadro. */
  readonly errorPulse = signal(0);
  /** Turno en el que ya se ha enviado una palabra valida (la bomba deja de contar al momento). */
  readonly submittedTurn = signal(0);
  /** Destello rojo de la pantalla con la explosion (mas fuerte para quien vuela). */
  readonly bloodFlash = signal<'none' | 'soft' | 'strong'>('none');
  private readonly now = signal(performance.now());

  readonly isHolder = computed(() => {
    const state = this.state();
    return Boolean(state && !state.outcome && state.holderId === this.currentPlayerId && (state.stage === 'typing' || state.stage === 'passing'));
  });
  readonly canType = computed(() => {
    const state = this.state();
    return Boolean(
      state &&
        state.stage === 'typing' &&
        state.holderId === this.currentPlayerId &&
        this.secretFuse()?.turn === state.turn &&
        this.submittedTurn() !== state.turn &&
        !this.matchService.hostPaused(),
    );
  });
  readonly holderName = computed(() => this.matchService.playerName(this.state()?.holderId));

  /** Palabra de la que hay que encadenar: las tres ultimas letras (las que se pueden repetir) en verde. */
  readonly wordParts = computed(() => {
    const word = (this.state()?.lastWord || '').toUpperCase();
    const size = Math.min(3, word.length);
    return { head: word.slice(0, word.length - size), tail: word.slice(word.length - size), seed: !this.state()?.chain.length };
  });
  /** Ultimas palabras de la ronda (la cadena), con quien las dijo. */
  readonly recentWords = computed(() =>
    (this.state()?.chain || []).slice(-4).map((entry) => ({
      word: entry.word.toUpperCase(),
      name: entry.playerId === this.currentPlayerId ? 'Tú' : this.matchService.playerName(entry.playerId),
    })),
  );

  readonly players = computed<BombPlayerView[]>(() =>
    (this.state()?.order || []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      shirt: getPlayerColor(this.matchService.playerColor(playerId)).body,
    })),
  );

  /** Mientras la camara da la vuelta, un "foco" va saltando de jugador en jugador (como un sorteo). */
  readonly pickingId = computed(() => {
    const state = this.state();
    const now = this.now();

    if (!state || state.stage !== 'intro') {
      return null;
    }

    const left = state.orbitEndsAt - this.matchService.serverNow();

    if (left > 2600 || left <= 0) {
      return null;
    }

    return state.order[Math.floor(now / 140) % state.order.length];
  });

  readonly tags = computed(() =>
    (this.state()?.order || []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      mine: playerId === this.currentPlayerId,
      holder: playerId === this.state()?.holderId && this.state()?.stage !== 'boom',
      picking: playerId === this.pickingId(),
    })),
  );

  /** Circulo de jugadores (vivos y caidos) en su orden, desde quien tiene la bomba. */
  readonly circle = computed(() => {
    const state = this.state();
    return (state?.order || []).map((playerId) => ({
      playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      colorId: this.matchService.playerColor(playerId),
      holder: playerId === state?.holderId && state?.stage !== 'boom',
      dead: !state?.alive.includes(playerId),
      mine: playerId === this.currentPlayerId,
    }));
  });

  readonly statusText = computed(() => {
    const state = this.state();
    this.now();

    if (!state) {
      return 'Preparando el círculo…';
    }

    const me = this.currentPlayerId;

    switch (state.stage) {
      case 'finished':
        return 'Fin de Patata caliente.';
      case 'intro':
        return 'Todos en círculo… ¿quién empezará con la bomba?';
      case 'boom':
        return state.boom?.playerId === me ? '¡BUM! Te ha explotado en las manos…' : `¡BUM! ${this.matchService.playerName(state.boom?.playerId)} ha volado por los aires.`;
      case 'passing':
        if (!state.fromId) {
          return state.holderId === me ? '¡Empiezas tú con la bomba! Prepárate…' : `Ronda ${state.round}: la bomba empieza en ${this.holderName()}.`;
        }

        return state.holderId === me ? '¡Te la lanzan a ti! Prepárate…' : `${this.matchService.playerName(state.fromId)} se la lanza a ${this.holderName()}…`;
      default:
        if (state.holderId === me) {
          return this.submittedTurn() === state.turn ? '¡Bien! Allá va…' : 'Escribe una palabra y pulsa Intro. ¡Rápido!';
        }

        return `${this.holderName()} está pensando una palabra…`;
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
      // Al poder escribir, el cursor va directo al recuadro (con teclado se escribe sin hacer clic). El aviso de
      // la palabra anterior solo se borra en un turno nuevo (si el servidor la rechaza, el aviso se queda).
      if (this.canType()) {
        untracked(() => {
          const turn = this.state()?.turn ?? 0;

          if (turn !== this.focusedTurn) {
            this.focusedTurn = turn;
            this.errorText.set('');
          }

          setTimeout(() => this.inputRef()?.nativeElement.focus(), 30);
        });
      }
    });

    effect(() => {
      // Aviso cuando la bomba viene hacia este jugador.
      const state = this.state();
      const key = `${state?.round}:${state?.passStartsAt}`;

      if (state?.stage === 'passing' && state.holderId === this.currentPlayerId && key !== this.lastTurnSound) {
        this.lastTurnSound = key;
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
      this.canType();
      this.state()?.stage;
      untracked(() => queueMicrotask(() => this.updateInsets()));
    });
  }

  async ngAfterViewInit(): Promise<void> {
    const tick = () => {
      this.now.set(performance.now());
      this.clockHandle = window.setTimeout(tick, 120);
    };
    tick();
    // Reloj de la mecha (solo cuenta en la pantalla de quien tiene la bomba) y sonido de la mecha.
    this.fuseHandle = window.setInterval(() => this.checkFuse(), 50);
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
      this.scene = new BombScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, this.players(), initial, environment.apiUrl);
      this.scene.onSound = (sound) => this.playSound(sound);
    } catch {
      this.unsupported.set(true);
      return;
    }

    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.rootRef(), this.panelRef(), this.dockRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.updateInsets();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.clockHandle);
    clearInterval(this.fuseHandle);
    this.insetObserver?.disconnect();
    this.scene?.dispose();
    this.scene = undefined;
  }

  /** Con teclado: cualquier letra lleva el cursor al recuadro aunque no se haya hecho clic. */
  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const input = this.inputRef()?.nativeElement;

    if (input && this.canType() && document.activeElement !== input && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      input.focus();
    }
  }

  onInput(value: string): void {
    this.typed.set(value);

    if (this.errorText()) {
      this.errorText.set('');
    }
  }

  /** Intro (o "Ir" en el movil): se comprueba aqui mismo y, si vale, la bomba sale hacia el siguiente. */
  async submit(event?: Event): Promise<void> {
    event?.preventDefault();
    const state = this.state();
    const fuse = this.secretFuse();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canType() || !fuse) {
      return;
    }

    // Se le ha acabado la mecha justo ahora: ya no vale (la explosion la avisa el reloj).
    if (this.matchService.serverNow() >= fuse.explodeAt) {
      return;
    }

    const word = normalizeBombWord(this.typed());

    if (!word) {
      return;
    }

    const problem = bombWordProblem(word, state.lastWord, new Set(state.used), state.timings.minWord, state.timings.maxWord);

    if (problem) {
      this.reject(bombProblemText(problem, state.lastWord));
      return;
    }

    // Lo que ha tardado se mide aqui: la latencia hasta el servidor no le quita mecha.
    const usedMs = Math.max(0, this.matchService.serverNow() - (state.typingStartsAt ?? this.matchService.serverNow()));
    const turn = state.turn;
    this.submittedTurn.set(turn);
    this.typed.set('');
    this.inputRef()?.nativeElement.blur();
    const response = await this.matchService.bombWord(lobbyId, turn, word, usedMs);

    if (!response.ok && !this.destroyed && this.state()?.turn === turn && this.state()?.stage === 'typing') {
      this.submittedTurn.set(0);
      this.reject(response.reason || 'Esa palabra no vale.');
    }
  }

  private reject(message: string): void {
    this.typed.set('');
    this.errorText.set(message);
    this.errorPulse.update((value) => value + 1);
    this.audioService.playSfx('error');
    // El recuadro se vuelve a pintar (para repetir el pulso rojo): el foco, al nuevo.
    setTimeout(() => this.inputRef()?.nativeElement.focus(), 0);
  }

  /** Reloj interno de la mecha: si se acaba en la pantalla de quien la tiene, avisa de la explosion. */
  private checkFuse(): void {
    const state = this.state();
    const fuse = this.secretFuse();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || state.outcome) {
      return;
    }

    const now = performance.now();
    const lit = state.stage === 'typing' || state.stage === 'passing';

    if (lit && !this.matchService.hostPaused() && now - this.lastFuseSound >= FUSE_SOUND_MS) {
      this.lastFuseSound = now;
      this.audioService.playSfx('mecha', { gain: state.holderId === this.currentPlayerId ? 1 : 0.5, rate: 0.9 + Math.random() * 0.2 });
    }

    if (
      lobbyId &&
      fuse &&
      state.stage === 'typing' &&
      state.holderId === this.currentPlayerId &&
      fuse.turn === state.turn &&
      this.submittedTurn() !== state.turn &&
      this.boomSentTurn !== state.turn &&
      !this.matchService.hostPaused() &&
      this.matchService.serverNow() >= fuse.explodeAt
    ) {
      this.boomSentTurn = state.turn;
      void this.matchService.bombBoom(lobbyId, state.turn);
    }
  }

  private playSound(sound: Parameters<NonNullable<BombScene['onSound']>>[0]): void {
    switch (sound) {
      case 'spawn':
        this.audioService.playEffect('pop');
        break;
      case 'throw':
        this.audioService.playSfx('lanzar', { rate: 1.2 });
        break;
      case 'catch':
        this.audioService.playSfx('atrapar');
        break;
      case 'boom': {
        this.audioService.playSfx('explosion');
        const victim = this.state()?.boom?.playerId === this.currentPlayerId;
        this.bloodFlash.set(victim ? 'strong' : 'soft');
        setTimeout(() => !this.destroyed && this.bloodFlash.set('none'), victim ? 1500 : 700);
        break;
      }
      case 'thud':
        this.audioService.playSfx('aplastar', { gain: 0.8, rate: 1.1 });
        break;
    }
  }

  private sceneState(): BombSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    const toLocal = (serverTime: number | null) => performance.now() + ((serverTime || 0) - this.matchService.serverNow());
    return {
      order: state.order,
      alive: state.alive,
      stage: state.stage,
      round: state.round,
      holderId: state.holderId,
      fromId: state.fromId,
      passStartsAt: toLocal(state.passStartsAt),
      passEndsAt: toLocal(state.passEndsAt),
      orbitEndsAt: toLocal(state.orbitEndsAt),
      boom: state.boom ? { ...state.boom, at: toLocal(state.boom.at) } : null,
    };
  }

  private updateInsets(): void {
    const scene = this.scene;

    if (!scene || this.destroyed) {
      return;
    }

    const root = this.rootRef().nativeElement.getBoundingClientRect();
    const panel = this.panelRef().nativeElement.getBoundingClientRect();
    const dock = this.dockRef().nativeElement.getBoundingClientRect();
    const results = this.rootRef().nativeElement.querySelector('.results-card')?.getBoundingClientRect();
    const bottomEdge = Math.min(dock.height ? dock.top : root.bottom, results ? results.top : root.bottom);
    scene.setInsets({
      top: Math.max(0, (panel.height ? panel.bottom : root.top) - root.top + 6),
      bottom: Math.max(0, root.bottom - bottomEdge + 6),
      left: 0,
      right: 0,
    });
  }
}
