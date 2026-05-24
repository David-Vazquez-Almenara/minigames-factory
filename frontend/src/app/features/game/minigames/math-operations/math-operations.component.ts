import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatchService } from '../../../../core/services/match.service';
import { MathOperationPayload } from '../../../../core/services/socket.service';

interface MathOperation extends MathOperationPayload {
  answer: number;
}

@Component({
  selector: 'app-math-operations',
  imports: [FormsModule],
  templateUrl: './math-operations.component.html',
  styleUrl: './math-operations.component.scss',
})
export class MathOperationsComponent {
  private readonly matchService = inject(MatchService);
  private preparedRoundKey = '';
  private activeRoundKey = '';
  private answeredOperations = new Set<string>();

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly operations = computed(() => this.match()?.specialRound?.operations || []);
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
      const match = this.match();
      const specialRound = match?.specialRound;

      if (!match || !specialRound || !this.isHost()) {
        return;
      }

      const roundKey = `${match.lobbyId}:${specialRound.roundNumber}:${specialRound.minigameId}`;

      if (this.preparedRoundKey === roundKey || specialRound.preparedByHost || specialRound.operations?.length) {
        return;
      }

      this.preparedRoundKey = roundKey;
      void this.prepareMathOperations(match.lobbyId);
    });

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

    void this.matchService.submitMinigameProgress(lobbyId, {
      answeredCount: this.localAnsweredCount(),
      correctCount: this.localCorrectCount(),
      completed,
      finishedAt,
    });
  }

  private async prepareMathOperations(lobbyId: string): Promise<void> {
    const response = await this.matchService.prepareMinigame(lobbyId, this.generateMathOperations());

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo preparar el minijuego.');
    }
  }

  private generateMathOperations(): MathOperation[] {
    const operationCount = this.randomInt(5, 7);
    const generators = [
      () => this.generateAddition(),
      () => this.generateSubtraction(),
      () => this.generateSmallMultiplication(),
      () => this.generateSimpleDivision(),
      () => this.generateParenthesisOperation(),
    ];

    return Array.from({ length: operationCount }, (_unused, index) => {
      const operation = generators[index % generators.length]();
      return {
        ...operation,
        id: `math-${index + 1}-${crypto.randomUUID().slice(0, 8)}`,
      };
    }).sort(() => Math.random() - 0.5);
  }

  private generateAddition(): Omit<MathOperation, 'id'> {
    const firstValue = this.randomInt(8, 40);
    const secondValue = this.randomInt(5, 35);

    return {
      prompt: `${firstValue} + ${secondValue}`,
      answer: firstValue + secondValue,
    };
  }

  private generateSubtraction(): Omit<MathOperation, 'id'> {
    const firstValue = this.randomInt(20, 70);
    const secondValue = this.randomInt(5, firstValue - 2);

    return {
      prompt: `${firstValue} - ${secondValue}`,
      answer: firstValue - secondValue,
    };
  }

  private generateSmallMultiplication(): Omit<MathOperation, 'id'> {
    const firstValue = this.randomInt(4, 24);
    const secondValue = Math.random() > 0.5 ? 2 : 3;

    return {
      prompt: `${firstValue} x ${secondValue}`,
      answer: firstValue * secondValue,
    };
  }

  private generateSimpleDivision(): Omit<MathOperation, 'id'> {
    const divisor = Math.random() > 0.5 ? 2 : 3;
    const answer = this.randomInt(3, 18);

    return {
      prompt: `${answer * divisor} / ${divisor}`,
      answer,
    };
  }

  private generateParenthesisOperation(): Omit<MathOperation, 'id'> {
    const firstValue = this.randomInt(2, 8);
    const secondValue = this.randomInt(3, 12);
    const multiplier = Math.random() > 0.5 ? 2 : 3;

    return {
      prompt: `(${firstValue} + ${secondValue}) x ${multiplier}`,
      answer: (firstValue + secondValue) * multiplier,
    };
  }

  private randomInt(minValue: number, maxValue: number): number {
    return Math.floor(Math.random() * (maxValue - minValue + 1)) + minValue;
  }
}
