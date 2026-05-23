import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MatchService } from '../../../core/services/match.service';

@Component({
  selector: 'app-question-round',
  templateUrl: './question-round.component.html',
  styleUrl: './question-round.component.scss',
})
export class QuestionRoundComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private timer?: ReturnType<typeof setInterval>;
  private lastAnswerKey = '';

  readonly match = this.matchService.match;
  readonly hostPaused = this.matchService.hostPaused;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly waitingQuestionBatchMessage = this.matchService.waitingQuestionBatchMessage;
  readonly selectedQuestionId = signal('');
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly submittedAnswer = signal(false);
  readonly remainingSeconds = signal(0);

  readonly currentPlayerQuestion = computed(
    () => this.match()?.selectedQuestions.find((selection) => selection.playerId === this.currentPlayerId)?.question || '',
  );
  readonly currentPlayerQuestionId = computed(
    () =>
      this.match()?.selectedQuestions.find((selection) => selection.playerId === this.currentPlayerId)?.questionId || '',
  );

  readonly currentQuestionOptions = computed(
    () =>
      this.match()?.questionOptionsByPlayer.find((entry) => entry.playerId === this.currentPlayerId)?.options || [],
  );

  readonly currentPlayerHistory = computed(() =>
    (this.match()?.questionHistory || [])
      .filter((entry) => entry.ownerPlayerId === this.currentPlayerId)
      .sort((firstEntry, secondEntry) => firstEntry.roundNumber - secondEntry.roundNumber),
  );

  readonly questionSubmitted = computed(() => Boolean(this.currentPlayerQuestion()));
  readonly currentAnswer = computed(() => this.match()?.currentAnswer || null);
  readonly isQuestionOwner = computed(() => this.currentAnswer()?.ownerPlayerId === this.currentPlayerId);
  readonly currentAnswerResult = computed(() => {
    const answer = this.currentAnswer();

    if (!answer) {
      return null;
    }

    return (
      this.match()?.answerResults.find((result) => result.ownerPlayerId === answer.ownerPlayerId) || null
    );
  });

  readonly selectedCountLabel = computed(() => {
    const match = this.match();

    if (!match) {
      return '0 / 0';
    }

    const waitingPlayers = new Set(match.waitingQuestionBatchPlayerIds);
    const activeTotal = Math.max(0, match.totalPlayers - waitingPlayers.size);
    return `${match.selectedQuestions.length} / ${activeTotal}`;
  });

  readonly answerResultLabel = computed(() => {
    const result = this.currentAnswerResult()?.finalAnswer;

    if (result === 'yes') {
      return 'Si';
    }

    if (result === 'no') {
      return 'No';
    }

    if (result === 'maybe') {
      return 'Tal vez';
    }

    return '';
  });

  constructor() {
    effect(() => {
      const match = this.match();
      const selectedQuestion = this.currentPlayerQuestion();

      if (selectedQuestion) {
        this.selectedQuestionId.set(this.currentPlayerQuestionId());
      }

      const answer = match?.currentAnswer;
      const nextAnswerKey = answer ? `${match?.lobbyId}:${match?.questionRoundNumber}:${answer.ownerPlayerId}` : '';

      if (nextAnswerKey !== this.lastAnswerKey) {
        this.lastAnswerKey = nextAnswerKey;
        this.submittedAnswer.set(false);
        this.errorMessage.set('');
      }

      this.syncTimer();
    });

    effect(() => {
      if (this.hostPaused()) {
        this.clearTimer();
        return;
      }

      if (!this.timer) {
        this.startTimer();
      }
    });
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  chooseQuestion(questionId: string): void {
    if (this.questionSubmitted()) {
      return;
    }

    this.selectedQuestionId.set(questionId);
    this.errorMessage.set('');
  }

  async submitQuestion(): Promise<void> {
    const match = this.match();
    const questionId = this.selectedQuestionId();

    if (!match || !questionId || this.questionSubmitted()) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.selectQuestion(match.lobbyId, questionId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo guardar la pregunta.');
    }
  }

  answerLabel(answer: 'yes' | 'no' | 'maybe'): string {
    if (answer === 'yes') {
      return 'Si';
    }

    if (answer === 'no') {
      return 'No';
    }

    return 'Tal vez';
  }

  async submitAnswer(answer: 'yes' | 'no'): Promise<void> {
    const match = this.match();

    if (!match || this.isQuestionOwner() || this.submittedAnswer() || this.currentAnswerResult()) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.submitAnswer(match.lobbyId, answer);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo guardar tu respuesta.');
      return;
    }

    this.submittedAnswer.set(true);
  }

  private syncTimer(): void {
    const match = this.match();
    const deadline =
      match?.phase === 'question-selection'
        ? match.questionSelectionEndsAt
        : match?.phase === 'answer-phase'
          ? match.answerEndsAt
          : null;

    if (!deadline || this.hostPaused()) {
      return;
    }

    this.updateRemainingSeconds(deadline);
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      const match = this.match();
      const deadline =
        match?.phase === 'question-selection'
          ? match.questionSelectionEndsAt
          : match?.phase === 'answer-phase'
            ? match.answerEndsAt
            : null;

      if (!deadline || this.hostPaused()) {
        return;
      }

      this.updateRemainingSeconds(deadline);
    }, 1000);
  }

  private updateRemainingSeconds(deadline: number): void {
    this.remainingSeconds.set(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }
}
