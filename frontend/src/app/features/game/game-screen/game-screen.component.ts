import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MatchService } from '../../../core/services/match.service';
import { CharacterSelectionComponent } from '../character-selection/character-selection.component';
import { CountdownComponent } from '../countdown/countdown.component';
import { QuestionRoundComponent } from '../question-round/question-round.component';
import { ScoreboardComponent } from '../scoreboard/scoreboard.component';
import { SpecialRoundComponent } from '../special-round/special-round.component';

@Component({
  selector: 'app-game-screen',
  imports: [CharacterSelectionComponent, CountdownComponent, QuestionRoundComponent, ScoreboardComponent, SpecialRoundComponent],
  templateUrl: './game-screen.component.html',
  styleUrl: './game-screen.component.scss',
})
export class GameScreenComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private hostWaitTimer?: ReturnType<typeof setInterval>;
  private viewTransitionTimer?: ReturnType<typeof setTimeout>;

  readonly match = this.matchService.match;
  readonly hostPaused = this.matchService.hostPaused;
  readonly hostPauseDeadline = this.matchService.hostPauseDeadline;
  readonly countdownDone = signal(false);
  readonly hostWaitSeconds = signal(60);
  readonly activeView = signal<'countdown' | 'character' | 'question' | 'scoreboard' | 'special' | 'questionsComplete'>('countdown');
  readonly viewTransition = signal<'entering' | 'leaving' | 'idle'>('entering');

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
      const match = this.match();

      if (!match) {
        return;
      }

      const nextView = this.getViewForMatch();

      if (nextView === this.activeView()) {
        return;
      }

      this.clearViewTransitionTimer();
      this.viewTransition.set('leaving');
      this.viewTransitionTimer = setTimeout(() => {
        this.activeView.set(nextView);
        this.viewTransition.set('entering');
        this.viewTransitionTimer = setTimeout(() => this.viewTransition.set('idle'), 520);
      }, 520);
    });

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
    this.clearViewTransitionTimer();
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

  private getViewForMatch(): 'countdown' | 'character' | 'question' | 'scoreboard' | 'special' | 'questionsComplete' {
    if (this.match()?.phase === 'questions-complete') {
      return 'questionsComplete';
    }

    if (this.match()?.phase === 'special-round') {
      return 'special';
    }

    if (this.showScoreboard()) {
      return 'scoreboard';
    }

    if (this.showQuestionRound()) {
      return 'question';
    }

    if (!this.showCharacterSelection()) {
      return 'countdown';
    }

    return 'character';
  }

  private clearViewTransitionTimer(): void {
    if (!this.viewTransitionTimer) {
      return;
    }

    clearTimeout(this.viewTransitionTimer);
    this.viewTransitionTimer = undefined;
  }
}
