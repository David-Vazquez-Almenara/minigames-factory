import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { GameTimerService } from '../../../core/services/game-timer.service';
import { MatchService } from '../../../core/services/match.service';
import { CountdownComponent } from '../countdown/countdown.component';
import { MatchFinishedComponent } from '../match-finished/match-finished.component';
import { MinigameRouletteComponent } from '../roulette/minigame-roulette.component';
import { ScoreboardComponent } from '../scoreboard/scoreboard.component';
import { SpecialRoundComponent } from '../special-round/special-round.component';

type GameView = 'countdown' | 'roulette' | 'special' | 'scoreboard' | 'finished';

@Component({
  selector: 'app-game-screen',
  imports: [CountdownComponent, MatchFinishedComponent, MinigameRouletteComponent, ScoreboardComponent, SpecialRoundComponent],
  templateUrl: './game-screen.component.html',
  styleUrl: './game-screen.component.scss',
})
export class GameScreenComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private viewTransitionTimer?: ReturnType<typeof setTimeout>;

  readonly match = this.matchService.match;
  readonly hostPaused = this.matchService.hostPaused;
  readonly hostWait = inject(GameTimerService).countdown(() => this.matchService.hostPauseDeadline(), { clock: 'local' });
  readonly targetView = computed<GameView>(() => {
    switch (this.match()?.phase) {
      case 'roulette':
        return 'roulette';
      case 'special-round':
        return 'special';
      case 'scoreboard':
        return 'scoreboard';
      case 'finished':
        return 'finished';
      default:
        return 'countdown';
    }
  });
  readonly activeView = signal<GameView>(this.targetView());
  readonly viewTransition = signal<'entering' | 'leaving' | 'idle'>('entering');

  constructor() {
    effect(() => {
      const nextView = this.targetView();

      if (nextView === this.activeView()) {
        return;
      }

      // Un unico temporizador de transicion: si llega otra fase durante la salida, se reemplaza.
      this.clearViewTransitionTimer();
      this.viewTransition.set('leaving');
      this.viewTransitionTimer = setTimeout(() => {
        this.activeView.set(this.targetView());
        document.querySelector('.game-view-shell')?.scrollTo({ top: 0 });
        this.viewTransition.set('entering');
        this.viewTransitionTimer = setTimeout(() => this.viewTransition.set('idle'), 520);
      }, 520);
    });
  }

  ngOnDestroy(): void {
    this.clearViewTransitionTimer();
  }

  private clearViewTransitionTimer(): void {
    if (!this.viewTransitionTimer) {
      return;
    }

    clearTimeout(this.viewTransitionTimer);
    this.viewTransitionTimer = undefined;
  }
}
