import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { CupsScene, CupsSceneState } from './cups-scene';

@Component({
  selector: 'app-cups',
  imports: [PlayerAvatarComponent],
  templateUrl: './cups.component.html',
  styleUrl: './cups.component.scss',
})
export class CupsComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly rootRef = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly labelsRef = viewChild.required<ElementRef<HTMLElement>>('labels');
  private readonly topBarRef = viewChild.required<ElementRef<HTMLElement>>('topBar');
  private readonly dockRef = viewChild.required<ElementRef<HTMLElement>>('dock');
  private scene?: CupsScene;
  private insetObserver?: ResizeObserver;
  private destroyed = false;
  private lastStageKey = '';
  private soundTimers: ReturnType<typeof setTimeout>[] = [];

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.cups || null);
  readonly unsupported = signal(false);
  /** Eleccion local: se marca al instante, sin esperar a que el servidor la confirme. */
  readonly localPick = signal<{ round: number; slot: number } | null>(null);

  readonly voteTimer = this.timerService.countdown(() => (this.state()?.stage === 'voting' ? this.state()?.voteEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly voterTotal = computed(() => this.matchService.match()?.specialRound?.participantIds.length || 0);
  readonly votedCount = computed(() => {
    const voted = new Set(this.state()?.votedPlayerIds || []);

    // El voto propio cuenta al instante, aunque el servidor aun no lo haya confirmado.
    if (this.selectedSlot() !== null && this.isPlayer()) {
      voted.add(this.currentPlayerId);
    }

    return voted.size;
  });
  readonly canVote = computed(() => this.state()?.stage === 'voting' && this.isPlayer());
  readonly selectedSlot = computed(() => {
    const state = this.state();
    const pick = this.localPick();

    if (!state) {
      return null;
    }

    if (pick && pick.round === state.round) {
      return pick.slot;
    }

    return state.votes.find((vote) => vote.playerId === this.currentPlayerId)?.slot ?? null;
  });
  readonly slots = computed(() => {
    const state = this.state();

    if (!state) {
      return [];
    }

    return Array.from({ length: state.cupCount }, (_unused, slot) => ({
      slot,
      mine: this.selectedSlot() === slot,
      ball: state.revealedSlot === slot,
      voters: state.votes
        .filter((vote) => (vote.playerId === this.currentPlayerId ? this.selectedSlot() === slot : vote.slot === slot))
        .map((vote) => ({
          playerId: vote.playerId,
          name: this.matchService.playerName(vote.playerId),
          avatarUrl: this.matchService.playerAvatar(vote.playerId),
          colorId: this.matchService.playerColor(vote.playerId),
        })),
    })).map((entry) => {
      // Si este jugador ha elegido pero el servidor aun no lo ha reflejado, su cara ya aparece.
      if (entry.mine && !entry.voters.some((voter) => voter.playerId === this.currentPlayerId) && this.isPlayer()) {
        entry.voters.push({
          playerId: this.currentPlayerId,
          name: this.matchService.playerName(this.currentPlayerId),
          avatarUrl: this.matchService.playerAvatar(this.currentPlayerId),
          colorId: this.matchService.playerColor(this.currentPlayerId),
        });
      }

      return entry;
    });
  });

  readonly scores = computed(() =>
    [...(this.state()?.scores || [])]
      .sort((first, second) => second.score - first.score)
      .map((entry) => ({
        ...entry,
        name: this.matchService.playerName(entry.playerId),
        avatarUrl: this.matchService.playerAvatar(entry.playerId),
        colorId: this.matchService.playerColor(entry.playerId),
        mine: entry.playerId === this.currentPlayerId,
      })),
  );

  readonly lastRound = computed(() => {
    const state = this.state();
    return state?.history.find((entry) => entry.round === state.round) || null;
  });

  readonly statusText = computed(() => {
    const state = this.state();

    switch (state?.stage) {
      case 'shuffling':
        return 'Atento: el crupier esconde la bola y mezcla los cubiletes…';
      case 'voting':
        return this.selectedSlot() === null ? '¿Dónde está la bola? Pulsa un cubilete.' : `Has elegido el cubilete ${(this.selectedSlot() || 0) + 1}. Puedes cambiarlo hasta que acabe el tiempo.`;
      case 'closing':
        return '¡Tiempo! Veamos dónde está la bola…';
      case 'reveal': {
        const round = this.lastRound();

        if (!this.isPlayer() || !round) {
          return 'Aquí estaba la bola.';
        }

        return round.winners.includes(this.currentPlayerId) ? '¡Acertaste! +5 puntos' : 'Esta vez no… la bola estaba ahí.';
      }
      case 'finished':
        return 'Fin de los cubiletes.';
      default:
        return 'Preparando la mesa…';
    }
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((entry) => ({
      ...entry,
      avatarUrl: this.matchService.playerAvatar(entry.playerId),
      colorId: this.matchService.playerColor(entry.playerId),
      mine: entry.playerId === this.currentPlayerId,
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
      const state = this.state();

      if (!state) {
        return;
      }

      const key = `${state.round}:${state.stage}`;

      if (key === this.lastStageKey) {
        return;
      }

      this.lastStageKey = key;
      untracked(() => this.playStageSound(state.stage));
    });

    effect(() => {
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
      this.scene = new CupsScene(THREE, this.canvasRef().nativeElement, this.rootRef().nativeElement, this.labelsRef().nativeElement, initial, this.dealerSeed());
    } catch {
      this.unsupported.set(true);
      return;
    }

    this.scene.onCupPicked = (slot) => this.pick(slot);
    this.insetObserver = new ResizeObserver(() => this.updateInsets());

    for (const element of [this.rootRef(), this.topBarRef(), this.dockRef()]) {
      this.insetObserver.observe(element.nativeElement);
    }

    this.updateInsets();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearSoundTimers();
    this.insetObserver?.disconnect();
    this.scene?.dispose();
    this.scene = undefined;
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const slot = Number(event.key) - 1;

    if (Number.isInteger(slot) && slot >= 0 && slot < (this.state()?.cupCount || 0)) {
      this.pick(slot);
    }
  }

  /** Elegir cubilete: sin confirmacion; se marca al momento y se puede cambiar mientras dura la votacion. */
  pick(slot: number): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canVote() || this.selectedSlot() === slot) {
      return;
    }

    this.localPick.set({ round: state.round, slot });
    this.audioService.playEffect('select');
    void this.matchService.voteCup(lobbyId, state.round, slot);
  }

  /** Semilla de la cara del crupier: la misma para todos los jugadores de esta ronda. */
  private dealerSeed(): string {
    const match = this.matchService.match();
    return `${match?.lobbyId || ''}:${match?.roundNumber || 0}`;
  }

  private playStageSound(stage: string): void {
    if (stage === 'shuffling') {
      this.scheduleShuffleSounds();
    } else if (stage === 'voting') {
      this.audioService.playEffect('turn');
    } else if (stage === 'reveal') {
      this.audioService.playSfx('cubilete-levantar');

      // Solo suena algo extra si aciertas; fallar no tiene sonido.
      if (this.lastRound()?.winners.includes(this.currentPlayerId)) {
        setTimeout(() => !this.destroyed && this.audioService.playFileEffect('win'), 350);
      }
    }
  }

  /** La bola entra rodando y cada movimiento del crupier arrastra los cubiletes por el tapete (reloj del servidor). */
  private scheduleShuffleSounds(): void {
    const state = this.state();
    this.clearSoundTimers();

    if (!state) {
      return;
    }

    const at = (serverTime: number, play: () => void) => {
      const delay = serverTime - this.matchService.serverNow();

      if (delay > -50) {
        this.soundTimers.push(setTimeout(play, Math.max(0, delay)));
      }
    };

    at(state.placeStartsAt, () => this.audioService.playSfx('bola-rodar'));
    // En las mezclas rapidas el arrastre se acorta y suena mas bajo para no saturar.
    const rate = Math.min(1.8, Math.max(1, 380 / state.moveMs));
    state.moves.forEach((_move, index) =>
      at(state.shuffleStartsAt + index * state.moveMs, () => this.audioService.playSfx('cubilete-deslizar', { rate, gain: state.moveMs < 250 ? 0.7 : 1 })),
    );
  }

  private clearSoundTimers(): void {
    this.soundTimers.forEach((timer) => clearTimeout(timer));
    this.soundTimers = [];
  }

  private sceneState(): CupsSceneState | null {
    const state = this.state();

    if (!state) {
      return null;
    }

    // Los tiempos del servidor se pasan al reloj local de animacion.
    const toLocal = (serverTime: number) => performance.now() + (serverTime - this.matchService.serverNow());

    return {
      round: state.round,
      cupCount: state.cupCount,
      initialSlot: state.initialSlot,
      moves: state.moves,
      moveMs: state.moveMs,
      placeMs: state.placeMs,
      placeStartsAt: toLocal(state.placeStartsAt),
      shuffleStartsAt: toLocal(state.shuffleStartsAt),
      revealedSlot: state.revealedSlot,
      selectedSlot: state.stage === 'shuffling' ? null : this.selectedSlot(),
      shuffling: state.stage === 'shuffling',
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
    scene.setInsets({
      top: Math.max(0, top.bottom - root.top + 6),
      bottom: dock.height ? Math.max(0, root.bottom - dock.top + 6) : 0,
      left: 0,
      right: 0,
    });
  }
}
