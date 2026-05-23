import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MatchService } from '../../../core/services/match.service';

type SpecialStage = 'intro' | 'explanation' | 'game';

@Component({
  selector: 'app-special-round',
  templateUrl: './special-round.component.html',
  styleUrl: './special-round.component.scss',
})
export class SpecialRoundComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private stageTimers: ReturnType<typeof setTimeout>[] = [];
  private progressTimer?: ReturnType<typeof setInterval>;
  private loadedRoundKey = '';

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly stage = signal<SpecialStage>('intro');
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly timerProgress = signal(0);
  readonly specialRound = computed(() => this.match()?.specialRound || null);

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
    this.clearTimers();
  }

  async skipMinigame(): Promise<void> {
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
    this.clearTimers();
    this.stage.set('intro');
    this.timerProgress.set(0);

    this.stageTimers.push(
      setTimeout(() => this.stage.set('explanation'), 1750),
      setTimeout(() => this.startExplanationTimer(), 2500),
    );
  }

  private startExplanationTimer(): void {
    const startedAt = Date.now();
    const durationMs = 5000;

    this.progressTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      this.timerProgress.set(progress);

      if (progress >= 1) {
        this.stage.set('game');
        this.clearProgressTimer();
      }
    }, 50);
  }

  private clearTimers(): void {
    for (const timer of this.stageTimers) {
      clearTimeout(timer);
    }

    this.stageTimers = [];
    this.clearProgressTimer();
  }

  private clearProgressTimer(): void {
    if (!this.progressTimer) {
      return;
    }

    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
  }
}
