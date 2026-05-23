import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MatchService } from '../../../core/services/match.service';
import { ScoreboardEntry } from '../../../core/services/socket.service';

interface AnimatedScoreboardEntry extends ScoreboardEntry {
  displayScore: number;
  previousPosition: number;
  scoreIncreased: boolean;
}

@Component({
  selector: 'app-scoreboard',
  templateUrl: './scoreboard.component.html',
  styleUrl: './scoreboard.component.scss',
})
export class ScoreboardComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private animationTimers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  private loadedScoreboardKey = '';

  readonly match = this.matchService.match;
  readonly scoreboard = this.matchService.scoreboard;
  readonly isHost = this.matchService.isHost;
  readonly rows = signal<AnimatedScoreboardEntry[]>([]);
  readonly positionsSettled = signal(false);
  readonly loading = signal(false);
  readonly errorMessage = signal('');

  readonly canContinue = computed(() => Boolean(this.isHost() && this.scoreboard() && !this.loading()));

  constructor() {
    effect(() => {
      const scoreboard = this.scoreboard();

      if (!scoreboard) {
        return;
      }

      const scoreboardKey = `${scoreboard.lobbyId}:${scoreboard.roundNumber}:${scoreboard.scores
        .map((score) => `${score.playerId}-${score.score}-${score.position}`)
        .join('|')}`;

      if (scoreboardKey === this.loadedScoreboardKey) {
        return;
      }

      this.loadedScoreboardKey = scoreboardKey;
      this.playScoreboardAnimation(scoreboard.scores);
    });
  }

  ngOnDestroy(): void {
    this.clearAnimationTimers();
  }

  async continueToNextBatch(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || !this.canContinue()) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.continueFromScoreboard(lobbyId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo continuar a la siguiente tanda.');
    }
  }

  private playScoreboardAnimation(nextRows: ScoreboardEntry[]): void {
    const scoreboard = this.scoreboard();

    if (!scoreboard) {
      return;
    }

    this.clearAnimationTimers();
    this.positionsSettled.set(false);
    this.errorMessage.set('');

    const previousScoreboard = this.matchService.getLocalScoreboardCopy(scoreboard.lobbyId);
    const previousScores = new Map((previousScoreboard?.scores || []).map((score) => [score.playerId, score]));
    const initialRows = nextRows
      .map((row) => {
        const previous = previousScores.get(row.playerId);

        return {
          ...row,
          position: previous?.position || row.position,
          previousPosition: previous?.position || row.position,
          displayScore: previous?.score || 0,
          scoreIncreased: row.score > (previous?.score || 0),
        };
      })
      .sort((firstRow, secondRow) => firstRow.previousPosition - secondRow.previousPosition);

    this.rows.set(initialRows);
    this.animateScores(nextRows);
  }

  private animateScores(nextRows: ScoreboardEntry[]): void {
    const start = Date.now();
    const durationMs = 850;
    const targetScores = new Map(nextRows.map((row) => [row.playerId, row.score]));

    const scoreTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - start) / durationMs);

      this.rows.update((currentRows) =>
        currentRows.map((row) => {
          const targetScore = targetScores.get(row.playerId) || 0;
          const scoreDelta = targetScore - row.displayScore;

          return {
            ...row,
            displayScore: progress >= 1 ? targetScore : Math.round(row.displayScore + scoreDelta * progress),
          };
        }),
      );

      if (progress >= 1) {
        clearInterval(scoreTimer);
        this.animationTimers = this.animationTimers.filter((timer) => timer !== scoreTimer);
        this.finishPositionAnimation(nextRows);
      }
    }, 30);

    this.animationTimers.push(scoreTimer);
  }

  private finishPositionAnimation(nextRows: ScoreboardEntry[]): void {
    const positionTimer = setTimeout(() => {
      this.rows.set(
        nextRows.map((row) => ({
          ...row,
          previousPosition: row.position,
          displayScore: row.score,
          scoreIncreased: false,
        })),
      );
      this.positionsSettled.set(true);

      const scoreboard = this.scoreboard();

      if (scoreboard) {
        this.matchService.saveLocalScoreboardCopy(scoreboard);
      }
    }, 420);

    this.animationTimers.push(positionTimer);
  }

  private clearAnimationTimers(): void {
    for (const timer of this.animationTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }

    this.animationTimers = [];
  }
}
