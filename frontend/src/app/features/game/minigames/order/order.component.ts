import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';

/** Ingredientes (mismo orden que los indices del servidor). */
export const ORDER_INGREDIENTS = [
  { id: 'carne', name: 'Carne' },
  { id: 'queso', name: 'Queso' },
  { id: 'lechuga', name: 'Lechuga' },
  { id: 'tomate', name: 'Tomate' },
  { id: 'cebolla', name: 'Cebolla' },
  { id: 'bacon', name: 'Bacon' },
  { id: 'pepinillo', name: 'Pepinillo' },
  { id: 'huevo', name: 'Huevo' },
];

type Phase = 'ready' | 'showing' | 'building' | 'waiting' | 'reveal' | 'final';

@Component({
  selector: 'app-order',
  imports: [PlayerAvatarComponent],
  templateUrl: './order.component.html',
  styleUrl: './order.component.scss',
})
export class OrderComponent {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private localRound = 0;
  private buildStartedAt = 0;
  private announcedFinal = false;

  readonly ingredients = ORDER_INGREDIENTS;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.order || null);
  /** Capas que lleva montadas este jugador en la ronda (se comprueban aqui, al instante). */
  readonly stack = signal<number[]>([]);
  readonly result = signal<'success' | 'fail' | null>(null);
  readonly wrongLayer = signal<number | null>(null);

  readonly readyTimer = this.timerService.countdown(() => this.state()?.showStartsAt);
  readonly showTimer = this.timerService.countdown(() => this.state()?.buildStartsAt);
  readonly buildTimer = this.timerService.countdown(() => (this.state()?.stage === 'showing' ? this.state()?.buildEndsAt : null), {
    paused: () => this.matchService.hostPaused(),
    totalMs: 20000,
    onExpire: () => this.finishRound(false),
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly phase = computed<Phase>(() => {
    const state = this.state();

    if (!state || state.stage === 'finished') {
      return 'final';
    }

    if (state.stage === 'reveal') {
      return 'reveal';
    }

    if (this.readyTimer.remainingMs() > 0) {
      return 'ready';
    }

    if (this.showTimer.remainingMs() > 0) {
      return 'showing';
    }

    return this.result() || !this.isPlayer() ? 'waiting' : 'building';
  });
  readonly recipe = computed(() => this.state()?.recipe || []);
  readonly showProgress = computed(() => {
    const state = this.state();
    const total = state?.buildStartsAt && state.showStartsAt ? state.buildStartsAt - state.showStartsAt : 1;
    return Math.max(0, Math.min(1, this.showTimer.remainingMs() / total));
  });
  readonly roundResults = computed(() => {
    const state = this.state();
    return (state?.history.find((entry) => entry.round === state.round)?.results || [])
      .map((entry) => ({
        ...entry,
        name: this.matchService.playerName(entry.playerId),
        avatarUrl: this.matchService.playerAvatar(entry.playerId),
        colorId: this.matchService.playerColor(entry.playerId),
        mine: entry.playerId === this.currentPlayerId,
        text: entry.success ? `${(entry.ms / 1000).toFixed(1).replace('.', ',')} s` : '✖',
      }))
      .sort((first, second) => Number(second.success) - Number(first.success) || first.ms - second.ms);
  });

  readonly statusText = computed(() => {
    const state = this.state();

    switch (this.phase()) {
      case 'ready':
        return `Ronda ${state?.round}: ¡llega un cliente!`;
      case 'showing':
        return 'Memoriza el pedido: de abajo arriba.';
      case 'building':
        return 'Monta la hamburguesa en el mismo orden (botones o teclas 1-8).';
      case 'waiting':
        return this.result() === 'success' ? '¡Pedido servido! Esperando al resto…' : this.result() === 'fail' ? '¡Pedido equivocado! Esperando al resto…' : 'Los cocineros están montando…';
      case 'reveal':
        return 'Así han quedado los pedidos.';
      default:
        return 'Cocina cerrada.';
    }
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
      timeText: `${(row.totalMs / 1000).toFixed(1).replace('.', ',')} s`,
    })),
  );

  constructor() {
    effect(() => {
      const round = this.state()?.round || 0;

      if (round !== this.localRound) {
        this.localRound = round;
        untracked(() => {
          this.stack.set([]);
          this.result.set(null);
          this.wrongLayer.set(null);
        });
      }
    });

    effect(() => {
      // El cronometro de montaje empieza en cuanto se tapa el pedido.
      if (this.phase() === 'building' && !this.buildStartedAt) {
        this.buildStartedAt = performance.now();
        untracked(() => this.audioService.playEffect('turn'));
      } else if (this.phase() !== 'building') {
        this.buildStartedAt = this.phase() === 'waiting' ? this.buildStartedAt : 0;
      }
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1 && mine.completed > 0) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const index = Number(event.key) - 1;

    if (Number.isInteger(index) && index >= 0 && index < ORDER_INGREDIENTS.length) {
      this.add(index);
    }
  }

  /** Poner una capa: se comprueba al momento contra el pedido (sin esperar al servidor). */
  add(ingredient: number): void {
    if (this.phase() !== 'building') {
      return;
    }

    const position = this.stack().length;
    this.stack.update((stack) => [...stack, ingredient]);

    if (this.recipe()[position] !== ingredient) {
      this.wrongLayer.set(position);
      this.audioService.playEffect('spin-stop');
      this.finishRound(false);
      return;
    }

    this.audioService.playEffect('pop');

    if (position + 1 >= this.recipe().length) {
      this.audioService.playSfx('acierto');
      this.finishRound(true);
    }
  }

  layerClass(ingredient: number): string {
    return `layer ${ORDER_INGREDIENTS[ingredient]?.id || ''}`;
  }

  private finishRound(success: boolean): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || this.result() || !this.isPlayer()) {
      return;
    }

    const ms = success ? Math.round(performance.now() - this.buildStartedAt) : 20000;
    this.result.set(success ? 'success' : 'fail');
    void this.matchService.reportOrder(lobbyId, state.round, success, ms);
  }
}
