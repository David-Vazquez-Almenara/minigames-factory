import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MathOperation, MinigameService } from '../shared/minigame.service';

@Component({
  selector: 'app-math-operations',
  imports: [FormsModule],
  templateUrl: './math-operations.component.html',
  styleUrl: './math-operations.component.scss',
})
export class MathOperationsComponent {
  private readonly minigameService = inject(MinigameService);
  private activeRoundKey = '';
  private answeredOperations = new Set<string>();

  readonly match = this.minigameService.match;
  readonly currentPlayerId = this.minigameService.currentPlayerId;
  readonly gameInfo = computed(() => this.minigameService.receiveGameData());
  readonly operations = computed(() => (this.gameInfo()?.payload as MathOperation[] | undefined) || []);
  readonly localAnsweredCount = signal(0);
  readonly localCorrectCount = signal(0);
  readonly myProgress = computed(() => {
    const serverProgress = this.match()?.specialRound?.progress?.find((progress) => progress.playerId === this.currentPlayerId);

    return {
      correctCount: Math.max(this.localCorrectCount(), serverProgress?.correctCount || 0),
      answeredCount: Math.max(this.localAnsweredCount(), serverProgress?.answeredCount || 0),
      completed: this.submitted() || Boolean(serverProgress?.completed),
    };
  });
  readonly currentIndex = computed(() => Math.min(this.localAnsweredCount(), Math.max(0, this.operations().length - 1)));
  readonly currentOperation = computed(() => this.operations()[this.currentIndex()] || null);
  readonly completedCount = computed(() => this.match()?.specialRound?.progress?.filter((progress) => progress.completed).length || 0);
  readonly totalPlayers = computed(() => this.match()?.totalPlayers || 0);
  readonly currentAnswer = signal('');
  readonly submitted = signal(false);
  readonly loading = signal(false);
  readonly errorMessage = signal('');

  readonly canSubmit = computed(() => {
    return Boolean(this.currentOperation() && this.currentAnswer().trim() && !this.submitted() && !this.loading());
  });

  constructor() {
    effect(() => {
      if (this.myProgress()?.completed) {
        this.submitted.set(true);
      }
    });

    effect(() => {
      const match = this.match();
      const specialRound = match?.specialRound;

      if (!match || !specialRound) {
        return;
      }

      const roundKey = `${match.lobbyId}:${specialRound.roundNumber}:${specialRound.minigameId}`;

      if (this.activeRoundKey === roundKey) {
        return;
      }

      this.activeRoundKey = roundKey;
      this.localAnsweredCount.set(0);
      this.localCorrectCount.set(0);
      this.currentAnswer.set('');
      this.submitted.set(false);
      this.answeredOperations.clear();
    });
  }

  updateAnswer(value: string): void {
    this.currentAnswer.set(value);
  }

  submitAnswer(): void {
    const lobbyId = this.match()?.lobbyId;
    const operation = this.currentOperation() as MathOperation | null;
    const numericAnswer = Number(this.currentAnswer());

    if (!lobbyId || !operation || !this.canSubmit() || !Number.isFinite(numericAnswer)) {
      this.errorMessage.set('Escribe una respuesta numerica.');
      return;
    }

    this.errorMessage.set('');
    const isCorrect = Number(operation.answer) === numericAnswer;
    this.answeredOperations.add(operation.id);
    this.localAnsweredCount.set(this.answeredOperations.size);
    this.localCorrectCount.update((currentCount) => currentCount + (isCorrect ? 1 : 0));

    this.currentAnswer.set('');

    const completed = this.localAnsweredCount() >= this.operations().length;
    const finishedAt = completed ? Date.now() : null;

    if (completed) {
      this.submitted.set(true);
    }

    void this.minigameService.submitProgress({
      answeredCount: this.localAnsweredCount(),
      correctCount: this.localCorrectCount(),
      completed,
      finishedAt,
    });
  }
}
