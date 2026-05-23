import { FormsModule } from '@angular/forms';
import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MatchService } from '../../../core/services/match.service';

const IMAGE_SELECTION_SECONDS = 60;

@Component({
  selector: 'app-character-selection',
  imports: [FormsModule],
  templateUrl: './character-selection.component.html',
  styleUrl: './character-selection.component.scss',
})
export class CharacterSelectionComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private timer?: ReturnType<typeof setInterval>;
  private validationRun = 0;
  private loadedLobbyId = '';
  private timeoutHandled = false;
  private autoVerifyKey = '';

  readonly assignment = this.matchService.currentAssignment;
  readonly match = this.matchService.match;
  readonly readyCount = this.matchService.readyCount;
  readonly totalPlayers = this.matchService.totalPlayers;
  readonly hostPaused = this.matchService.hostPaused;
  readonly imageSelectionTimerReset = this.matchService.imageSelectionTimerReset;
  readonly isHost = this.matchService.isHost;
  readonly unreadyPlayers = this.matchService.unreadyImagePlayers;
  readonly waitingNextRoundMessage = this.matchService.waitingNextRoundMessage;
  readonly imageUrl = signal('');
  readonly previewUrl = signal('');
  readonly errorMessage = signal('');
  readonly validating = signal(false);
  readonly imageValid = signal(false);
  readonly submitted = signal(false);
  readonly editingSelection = signal(false);
  readonly remainingSeconds = signal(IMAGE_SELECTION_SECONDS);
  readonly showTimeoutDecision = signal(false);
  readonly timeoutDecisionLoading = signal(false);
  readonly verificationPlayers = signal<Array<{ id: string; name: string }>>([]);

  readonly readyLabel = computed(() => `${this.readyCount()} / ${this.totalPlayers()}`);
  readonly canSubmit = computed(
    () =>
      this.imageValid() &&
      !this.validating() &&
      !this.hostPaused() &&
      (!this.submitted() || this.editingSelection()),
  );
  readonly timeoutDecisionPlayers = computed(() => {
    const verificationPlayers = this.verificationPlayers();
    return verificationPlayers.length ? verificationPlayers : this.unreadyPlayers();
  });

  constructor() {
    this.syncTimer();

    effect(() => {
      const match = this.match();
      const lobbyId = match?.lobbyId || '';

      if (lobbyId && lobbyId !== this.loadedLobbyId) {
        this.loadedLobbyId = lobbyId;
        this.loadSavedImage(lobbyId);
      }

      const serverSubmitted = Boolean(
        match?.readySelections.some((selection) => selection.playerId === this.matchService.currentPlayerId),
      );

      if (!this.editingSelection()) {
        this.submitted.set(serverSubmitted);
      }

      this.syncTimer();

      if (
        this.isHost() &&
        match?.phase === 'image-selection' &&
        this.readyCount() === this.totalPlayers() &&
        this.totalPlayers() > 0 &&
        !this.timeoutDecisionLoading()
      ) {
        const verifyKey = `${match.lobbyId}:${this.readyCount()}:${match.imageSelectionEndsAt}`;

        if (verifyKey !== this.autoVerifyKey) {
          this.autoVerifyKey = verifyKey;
          void this.verifyEveryoneReady();
        }
      }
    });

    effect(() => {
      const resetDeadline = this.imageSelectionTimerReset();

      if (resetDeadline) {
        this.timeoutHandled = false;
        this.showTimeoutDecision.set(false);
        this.updateRemainingSeconds(resetDeadline);
        this.clearTimer();
        this.startTimer();
      }
    });

    effect(() => {
      if (!this.hostPaused() && !this.timer && this.remainingSeconds() > 0) {
        this.startTimer();
      }

      if (this.hostPaused()) {
        this.clearTimer();
      }
    });
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  updateImageUrl(value: string): void {
    this.imageUrl.set(value);
    this.imageValid.set(false);
    this.errorMessage.set('');
    this.previewUrl.set('');

    const runId = (this.validationRun += 1);

    setTimeout(() => {
      if (runId !== this.validationRun || (this.submitted() && !this.editingSelection())) {
        return;
      }

      void this.validatePreview(runId);
    }, 350);
  }

  async submitSelection(): Promise<void> {
    const validation = await this.matchService.validateImageUrl(this.imageUrl());

    if (!validation.ok) {
      this.imageValid.set(false);
      this.errorMessage.set(validation.error);
      return;
    }

    const assignment = this.assignment();

    if (!assignment) {
      this.errorMessage.set('No se encontro tu asignacion de personaje.');
      return;
    }

    this.validating.set(true);
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId) {
      this.errorMessage.set('No se encontro la sala activa.');
      return;
    }

    const response = await this.matchService.submitImageSelection(lobbyId, validation.imageUrl);
    this.validating.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo guardar tu imagen.');
      return;
    }

    this.previewUrl.set(validation.imageUrl);
    this.imageValid.set(true);
    this.matchService.savePlayerImageUrl(lobbyId, validation.imageUrl);
    this.editingSelection.set(false);
    this.submitted.set(true);
  }

  editSelection(): void {
    this.editingSelection.set(true);
  }

  handleImageSelectionTimeout(): void {
    if (!this.isHost()) {
      return;
    }

    if (this.readyCount() < this.totalPlayers()) {
      this.verificationPlayers.set([]);
      this.showTimeoutDecision.set(true);
      return;
    }

    void this.verifyEveryoneReady();
  }

  async verifyEveryoneReady(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId) {
      return;
    }

    this.timeoutDecisionLoading.set(true);
    const response = await this.matchService.verifyImageSelectionReady(lobbyId);
    this.timeoutDecisionLoading.set(false);

    if (response.ok) {
      this.showTimeoutDecision.set(false);
      this.verificationPlayers.set([]);
      return;
    }

    this.verificationPlayers.set(
      (response.unreadyPlayers || []).map((player) => ({
        id: player.playerId,
        name: player.name,
      })),
    );
    this.errorMessage.set(response.reason || '');
    this.showTimeoutDecision.set(true);
  }

  async waitForUnreadyPlayers(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId) {
      return;
    }

    this.timeoutDecisionLoading.set(true);
    const response = await this.matchService.extendImageSelection(lobbyId);
    this.timeoutDecisionLoading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo ampliar el tiempo.');
      return;
    }

    const nextDeadline = response.match?.imageSelectionEndsAt || Date.now() + IMAGE_SELECTION_SECONDS * 1000;
    this.verificationPlayers.set([]);
    this.showTimeoutDecision.set(false);
    this.timeoutHandled = false;
    this.autoVerifyKey = '';
    this.clearTimer();
    this.updateRemainingSeconds(nextDeadline);
    this.startTimer();
  }

  async excludeUnreadyPlayers(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId) {
      return;
    }

    this.timeoutDecisionLoading.set(true);
    const response = await this.matchService.excludeUnreadyImagePlayers(lobbyId);
    this.timeoutDecisionLoading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo sacar a los jugadores sin imagen.');
      return;
    }

    this.verificationPlayers.set([]);
    this.showTimeoutDecision.set(false);
  }

  private async validatePreview(runId: number): Promise<void> {
    this.validating.set(true);
    const validation = await this.matchService.validateImageUrl(this.imageUrl());

    if (runId !== this.validationRun) {
      return;
    }

    this.validating.set(false);
    this.imageValid.set(validation.ok);
    this.errorMessage.set(validation.error);
    this.previewUrl.set(validation.ok ? validation.imageUrl : '');
  }

  private loadSavedImage(lobbyId: string): void {
    const savedImageUrl = this.matchService.getSavedImageUrl(lobbyId);

    if (!savedImageUrl) {
      return;
    }

    this.imageUrl.set(savedImageUrl);
    void this.validatePreview((this.validationRun += 1));
  }

  private syncTimer(): void {
    const match = this.match();

    if (!match?.imageSelectionEndsAt || this.hostPaused()) {
      return;
    }

    this.updateRemainingSeconds(match.imageSelectionEndsAt);
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) {
      return;
    }

    const match = this.match();

    if (!match?.imageSelectionEndsAt) {
      return;
    }

    this.clearTimer();

    this.timer = setInterval(() => {
      if (this.hostPaused()) {
        return;
      }

      this.updateRemainingSeconds(this.match()?.imageSelectionEndsAt || Date.now());
    }, 1000);
  }

  private updateRemainingSeconds(deadline: number): void {
    const nextSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    this.remainingSeconds.set(nextSeconds);

    if (nextSeconds > 0) {
      this.timeoutHandled = false;
      this.showTimeoutDecision.set(false);
      return;
    }

    this.clearTimer();

    if (!this.timeoutHandled) {
      this.timeoutHandled = true;
      this.handleImageSelectionTimeout();
    }
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }
}
