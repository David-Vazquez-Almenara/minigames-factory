import { FormsModule } from '@angular/forms';
import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MatchService } from '../../../core/services/match.service';

@Component({
  selector: 'app-question-round',
  imports: [FormsModule],
  templateUrl: './question-round.component.html',
  styleUrl: './question-round.component.scss',
})
export class QuestionRoundComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private timer?: ReturnType<typeof setInterval>;
  private answerSlideTimer?: ReturnType<typeof setTimeout>;
  private lastAnswerKey = '';
  private customExtraRequestedKey = '';

  readonly match = this.matchService.match;
  readonly hostPaused = this.matchService.hostPaused;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly waitingQuestionBatchMessage = this.matchService.waitingQuestionBatchMessage;
  readonly selectedQuestionId = signal('');
  readonly customQuestion = signal('');
  readonly customQuestionEditing = signal(false);
  readonly customQuestionModalOpen = signal(false);
  readonly historyModalOpen = signal(false);
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly submittedAnswer = signal(false);
  readonly answerSlideActive = signal(false);
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
  readonly selectedQuestionOption = computed(
    () => this.currentQuestionOptions().find((option) => option.id === this.selectedQuestionId()) || null,
  );
  readonly customQuestionDeadline = computed(
    () =>
      this.match()?.customQuestionDeadlineByPlayer.find((entry) => entry.playerId === this.currentPlayerId)?.deadline ||
      null,
  );
  readonly canSubmitQuestion = computed(() => {
    if (this.questionSubmitted() || this.loading() || this.hostPaused() || !this.selectedQuestionId()) {
      return false;
    }

    if (this.customQuestionEditing()) {
      return this.customQuestion().trim().length >= 8;
    }

    return true;
  });

  readonly currentPlayerHistory = computed(() =>
    (this.match()?.questionHistory || [])
      .filter((entry) => entry.ownerPlayerId === this.currentPlayerId)
      .sort((firstEntry, secondEntry) => secondEntry.roundNumber - firstEntry.roundNumber),
  );
  readonly compactHistory = computed(() => this.currentPlayerHistory().slice(0, 3));
  readonly hasHiddenHistory = computed(() => this.currentPlayerHistory().length > this.compactHistory().length);

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
        this.customQuestionEditing.set(false);
        this.customQuestionModalOpen.set(false);
      }

      const answer = match?.currentAnswer;
      const nextAnswerKey = answer ? `${match?.lobbyId}:${match?.questionRoundNumber}:${answer.ownerPlayerId}` : '';

      if (nextAnswerKey !== this.lastAnswerKey) {
        this.lastAnswerKey = nextAnswerKey;
        this.submittedAnswer.set(false);
        this.errorMessage.set('');
        this.answerSlideActive.set(false);
        if (this.answerSlideTimer) {
          clearTimeout(this.answerSlideTimer);
        }
        this.answerSlideTimer = setTimeout(() => this.answerSlideActive.set(true), 10);
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
    if (this.answerSlideTimer) {
      clearTimeout(this.answerSlideTimer);
    }
  }

  async chooseQuestion(questionId: string): Promise<void> {
    if (this.questionSubmitted()) {
      return;
    }

    this.selectedQuestionId.set(questionId);
    this.errorMessage.set('');

    const selectedOption = this.currentQuestionOptions().find((option) => option.id === questionId);

    if (!selectedOption?.special) {
      this.customQuestionEditing.set(false);
      this.customQuestionModalOpen.set(false);
      this.customQuestion.set('');
      return;
    }

    this.customQuestionEditing.set(true);
    this.customQuestionModalOpen.set(true);
    const match = this.match();

    if (!match) {
      return;
    }

    const customKey = `${match.lobbyId}:${match.questionRoundNumber}:${this.currentPlayerId}`;

    if (this.customExtraRequestedKey === customKey) {
      return;
    }

    this.customExtraRequestedKey = customKey;
    const response = await this.matchService.startCustomQuestionEditing(match.lobbyId);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo activar la pregunta especial.');
    }
  }

  closeCustomQuestionModal(): void {
    this.customQuestionModalOpen.set(false);
  }

  openHistoryModal(): void {
    this.historyModalOpen.set(true);
  }

  closeHistoryModal(): void {
    this.historyModalOpen.set(false);
  }

  async submitQuestion(): Promise<void> {
    const match = this.match();
    const questionId = this.selectedQuestionId();

    if (!match || !questionId || this.questionSubmitted()) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.selectQuestion(match.lobbyId, questionId, this.customQuestion());
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
        ? this.customQuestionDeadline() || match.questionSelectionEndsAt
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
          ? this.customQuestionDeadline() || match.questionSelectionEndsAt
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
