import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MatchService } from '../../../core/services/match.service';
import { ScoreboardEntry } from '../../../core/services/socket.service';
import { MinigameService } from '../minigames/shared/minigame.service';
import { MinigameWinner } from '../minigames/shared/minigame.models';

interface AnimatedScoreboardEntry extends ScoreboardEntry {
  displayScore: number;
  scoreDelta: number;
  previousPosition: number;
  scoreIncreased: boolean;
  moving: boolean;
}

@Component({
  selector: 'app-scoreboard',
  templateUrl: './scoreboard.component.html',
  styleUrl: './scoreboard.component.scss',
})
export class ScoreboardComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly minigameService = inject(MinigameService);
  private animationTimers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  private loadedScoreboardKey = '';

  readonly match = this.matchService.match;
  readonly scoreboard = this.matchService.scoreboard;
  readonly isHost = this.matchService.isHost;
  readonly rows = signal<AnimatedScoreboardEntry[]>([]);
  readonly positionsSettled = signal(false);
  readonly scoreAnimationStarted = signal(false);
  readonly showWinner = signal(false);
  readonly winnerLeaving = signal(false);
  readonly winners = signal<MinigameWinner[]>([]);
  readonly noWinnerMessage = signal('');
  readonly loading = signal(false);
  readonly errorMessage = signal('');

  readonly canContinue = computed(() =>
    Boolean(this.isHost() && this.scoreboard() && this.positionsSettled() && !this.showWinner() && !this.loading()),
  );
  readonly winnerTitle = computed(() => (this.noWinnerMessage() ? 'Sin ganador' : this.winners().length > 1 ? 'Ganadores' : 'Ganador'));
  readonly winnerNames = computed(() => this.noWinnerMessage() || this.winners().map((winner) => winner.playerName).join(', '));
  readonly winnerHasImages = computed(() => this.winners().some((winner) => Boolean(winner.imageDataUrl)));

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
    this.scoreAnimationStarted.set(false);
    this.showWinner.set(false);
    this.winnerLeaving.set(false);
    this.winners.set([]);
    this.noWinnerMessage.set('');
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
          scoreDelta: Math.max(0, row.score - (previous?.score || 0)),
          scoreIncreased: row.score > (previous?.score || 0),
          moving: false,
        };
      })
      .sort((firstRow, secondRow) => firstRow.previousPosition - secondRow.previousPosition);

    this.rows.set(initialRows);

    if (!nextRows.length) {
      return;
    }

    const { noWinnerMessage, winners } = this.minigameService.getScoreboardPresentation();

    if (noWinnerMessage || winners.length) {
      this.winners.set(winners);
      this.noWinnerMessage.set(noWinnerMessage);
      this.showWinner.set(true);

      const exitTimer = setTimeout(() => this.winnerLeaving.set(true), 3200);
      const scoreboardTimer = setTimeout(() => {
        this.showWinner.set(false);
        this.winnerLeaving.set(false);
        this.startScoreDelay(nextRows, 250);
      }, 3900);

      this.animationTimers.push(exitTimer, scoreboardTimer);
      return;
    }

    this.startScoreDelay(nextRows, 1500);
  }

  private startScoreDelay(nextRows: ScoreboardEntry[], delayMs: number): void {
    const scoreDelayTimer = setTimeout(() => {
      this.scoreAnimationStarted.set(true);
      this.animateScores(nextRows);
    }, delayMs);
    this.animationTimers.push(scoreDelayTimer);
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
    const currentRows = this.rows();
    const hasPositionChanges = nextRows.some((row) =>
      currentRows.some((currentRow) => currentRow.playerId === row.playerId && currentRow.previousPosition !== row.position),
    );

    if (!hasPositionChanges) {
      this.rows.set(
        nextRows.map((row) => {
          const currentRow = currentRows.find((entry) => entry.playerId === row.playerId);

          return {
            ...row,
            previousPosition: row.position,
            displayScore: row.score,
            scoreDelta: currentRow?.scoreDelta || 0,
            scoreIncreased: false,
            moving: false,
          };
        }),
      );
      this.positionsSettled.set(true);
      this.saveCurrentScoreboardCopy();
      return;
    }

    const positionTimer = setTimeout(() => {
      const currentRows = this.rows();
      this.rows.set(
        nextRows.map((row) => ({
          ...row,
          previousPosition: currentRows.find((currentRow) => currentRow.playerId === row.playerId)?.previousPosition || row.position,
          displayScore: row.score,
          scoreDelta: currentRows.find((currentRow) => currentRow.playerId === row.playerId)?.scoreDelta || 0,
          scoreIncreased: false,
          moving: currentRows.some(
            (currentRow) => currentRow.playerId === row.playerId && currentRow.previousPosition !== row.position,
          ),
        })),
      );

      const settleTimer = setTimeout(() => {
        this.positionsSettled.set(true);
        this.rows.update((currentRows) => currentRows.map((row) => ({ ...row, previousPosition: row.position, moving: false })));
      }, 40);
      this.animationTimers.push(settleTimer);

      this.saveCurrentScoreboardCopy();
    }, 420);

    this.animationTimers.push(positionTimer);
  }

  rowOffset(row: AnimatedScoreboardEntry): string {
    if (this.positionsSettled() || row.previousPosition === row.position) {
      return 'translateY(0)';
    }

    return `translateY(${(row.previousPosition - row.position) * 80}px)`;
  }

  rowOpacity(row: AnimatedScoreboardEntry): string {
    return !this.positionsSettled() && row.moving ? '0.35' : '1';
  }

  private clearAnimationTimers(): void {
    for (const timer of this.animationTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }

    this.animationTimers = [];
  }

  private saveCurrentScoreboardCopy(): void {
    const scoreboard = this.scoreboard();

    if (scoreboard) {
      this.matchService.saveLocalScoreboardCopy(scoreboard);
    }
  }

}
