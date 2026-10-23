import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { GameTimerService } from '../../../core/services/game-timer.service';
import { MatchService } from '../../../core/services/match.service';
import { ImpostorComponent } from '../minigames/impostor/impostor.component';
import { MathOperationsComponent } from '../minigames/math-operations/math-operations.component';
import { PaintComponent } from '../minigames/paint/paint.component';
import { PinturilloComponent } from '../minigames/pinturillo/pinturillo.component';
import { PogoComponent } from '../minigames/pogo/pogo.component';
import { TenButComponent } from '../minigames/ten-but/ten-but.component';

type SpecialStage = 'intro' | 'explanation' | 'game';

const INTRO_MS = 1750;
const EXPLANATION_MS = 5000;

@Component({
  selector: 'app-special-round',
  imports: [ImpostorComponent, MathOperationsComponent, PaintComponent, PinturilloComponent, PogoComponent, TenButComponent],
  templateUrl: './special-round.component.html',
  styleUrl: './special-round.component.scss',
})
export class SpecialRoundComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private introTimer?: ReturnType<typeof setTimeout>;
  private loadedRoundKey = '';
  private readonly explanationEndsAt = signal<number | null>(null);

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly stage = signal<SpecialStage>('intro');
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly specialRound = computed(() => this.match()?.specialRound || null);
  readonly explanationTimer = inject(GameTimerService).countdown(() => this.explanationEndsAt(), {
    clock: 'local',
    totalMs: EXPLANATION_MS,
    onExpire: () => this.stage.set('game'),
  });
  readonly continueLabel = computed(() => (this.specialRound()?.hasResults ? 'Ver marcador' : 'Saltar minijuego'));

  constructor() {
    effect(() => {
      const round = this.specialRound();
      const lobbyId = this.match()?.lobbyId || '';

      if (!round || !lobbyId) {
        return;
      }

      const nextKey = `${lobbyId}:${round.roundNumber}:${round.minigameId}`;

      if (nextKey === this.loadedRoundKey) {
        return;
      }

      this.loadedRoundKey = nextKey;
      this.startIntroSequence();
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.introTimer);
  }

  async continueMinigame(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || !this.isHost() || this.loading()) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.continueFromSpecialRound(lobbyId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo continuar despues del minijuego.');
    }
  }

  private startIntroSequence(): void {
    clearTimeout(this.introTimer);
    this.explanationEndsAt.set(null);
    this.stage.set('intro');

    this.introTimer = setTimeout(() => {
      this.stage.set('explanation');
      this.explanationEndsAt.set(Date.now() + EXPLANATION_MS);
    }, INTRO_MS);
  }
}
