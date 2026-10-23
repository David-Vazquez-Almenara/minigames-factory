import { Component, computed, effect, inject } from '@angular/core';
import { AudioService } from '../../../core/services/audio.service';
import { GameTimerService } from '../../../core/services/game-timer.service';
import { MatchService } from '../../../core/services/match.service';

@Component({
  selector: 'app-countdown',
  templateUrl: './countdown.component.html',
  styleUrl: './countdown.component.scss',
})
export class CountdownComponent {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly countdown = inject(GameTimerService).countdown(() => this.matchService.match()?.countdownEndsAt, {
    paused: () => this.matchService.hostPaused(),
  });

  readonly currentNumber = computed(() => Math.min(3, Math.max(1, this.countdown.seconds())));

  constructor() {
    effect(() => {
      this.currentNumber();
      this.audioService.playEffect('pop');
    });
  }
}
