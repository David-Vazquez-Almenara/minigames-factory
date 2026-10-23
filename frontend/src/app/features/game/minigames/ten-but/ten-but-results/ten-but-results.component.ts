import { Component, DestroyRef, OnInit, computed, inject, input } from '@angular/core';
import { AudioService } from '../../../../../core/services/audio.service';
import { MatchService } from '../../../../../core/services/match.service';
import { TenButOutcome } from '../../../../../core/services/socket.service';
import { PlayerAvatarComponent } from '../../../../../shared/components/player-avatar/player-avatar.component';

@Component({
  selector: 'app-ten-but-results',
  imports: [PlayerAvatarComponent],
  templateUrl: './ten-but-results.component.html',
  styleUrl: './ten-but-results.component.scss',
})
export class TenButResultsComponent implements OnInit {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly destroyRef = inject(DestroyRef);

  readonly outcome = input.required<TenButOutcome>();
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly slots = computed(() => {
    const outcome = this.outcome();

    return Array.from({ length: 10 }, (_unused, index) => {
      const value = index + 1;
      const diff = Math.abs(value - outcome.secretNumber);

      return {
        value,
        zone: diff === 0 ? 'exact' : diff === 1 ? 'near' : 'far',
        players: outcome.answers
          .filter((answer) => answer.number === value)
          .map((answer) => ({ id: answer.playerId, color: this.matchService.playerColor(answer.playerId), avatarUrl: this.matchService.playerAvatar(answer.playerId), name: answer.playerName })),
      };
    });
  });
  readonly unanswered = computed(() => this.outcome().answers.filter((answer) => answer.number === null));
  readonly myPoints = computed(() => {
    const outcome = this.outcome();

    if (outcome.speakerId === this.currentPlayerId) {
      return outcome.speakerTotal;
    }

    return outcome.answers.find((answer) => answer.playerId === this.currentPlayerId)?.points ?? null;
  });

  ngOnInit(): void {
    this.audioService.playEffect('reveal');
    const points = this.myPoints();

    if (points !== null) {
      const timer = setTimeout(() => this.audioService.playEffect(points > 0 ? 'victory' : 'defeat'), 1400);
      this.destroyRef.onDestroy(() => clearTimeout(timer));
    }
  }

  playerAvatar(playerId: string): string {
    return this.matchService.playerAvatar(playerId);
  }

  playerColor(playerId: string): string {
    return this.matchService.playerColor(playerId);
  }

  rowClass(diff: number | null): string {
    if (diff === null) {
      return 'missing';
    }

    return diff === 0 ? 'exact' : diff === 1 ? 'near' : 'far';
  }
}
