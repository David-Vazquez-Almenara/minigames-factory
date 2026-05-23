import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MatchService } from '../../../core/services/match.service';
import { CharacterSelectionComponent } from '../character-selection/character-selection.component';
import { CountdownComponent } from '../countdown/countdown.component';
import { QuestionRoundComponent } from '../question-round/question-round.component';
import { ScoreboardComponent } from '../scoreboard/scoreboard.component';

@Component({
  selector: 'app-game-screen',
  imports: [CharacterSelectionComponent, CountdownComponent, QuestionRoundComponent, ScoreboardComponent],
  templateUrl: './game-screen.component.html',
  styleUrl: './game-screen.component.scss',
})
export class GameScreenComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private hostWaitTimer?: ReturnType<typeof setInterval>;

  readonly match = this.matchService.match;
  readonly hostPaused = this.matchService.hostPaused;
  readonly hostPauseDeadline = this.matchService.hostPauseDeadline;
  readonly countdownDone = signal(false);
  readonly hostWaitSeconds = signal(60);

  readonly showCharacterSelection = computed(() => {
    const match = this.match();

    if (!match) {
      return false;
    }

    return this.countdownDone() || match.phase !== 'countdown' || Date.now() >= match.countdownEndsAt;
  });

  readonly showQuestionRound = computed(() => {
    const phase = this.match()?.phase;
    return phase === 'question-selection' || phase === 'answer-phase';
  });

  readonly showScoreboard = computed(() => this.match()?.phase === 'scoreboard');

  constructor() {
    effect(() => {
      const deadline = this.hostPauseDeadline();

      if (!deadline) {
        this.clearHostWaitTimer();
        this.hostWaitSeconds.set(60);
        return;
      }

      this.updateHostWaitSeconds(deadline);
      this.hostWaitTimer = setInterval(() => this.updateHostWaitSeconds(deadline), 1000);
    });
  }

  ngOnDestroy(): void {
    this.clearHostWaitTimer();
  }

  finishCountdown(): void {
    this.countdownDone.set(true);
  }

  private updateHostWaitSeconds(deadline: number): void {
    this.hostWaitSeconds.set(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
  }

  private clearHostWaitTimer(): void {
    if (!this.hostWaitTimer) {
      return;
    }

    clearInterval(this.hostWaitTimer);
    this.hostWaitTimer = undefined;
  }
}
