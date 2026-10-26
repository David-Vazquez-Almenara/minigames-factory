import { Component, ElementRef, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { scrollGameToTop } from '../../../../shared/scroll-game-to-top';
import { RouletteItem, RouletteStripComponent } from '../../../../shared/components/roulette-strip/roulette-strip.component';
import { TenButResultsComponent } from './ten-but-results/ten-but-results.component';

export const NUMBER_COLORS = [
  '#ff9b9b',
  '#ffb38a',
  '#ffcf8a',
  '#ffe891',
  '#fff4b8',
  '#e6f7a7',
  '#c9f2a0',
  '#b9f7a7',
  '#9eefa0',
  '#7fe39b',
];

const NUMBER_ITEMS: RouletteItem[] = NUMBER_COLORS.map((accent, index) => ({
  key: `n${index + 1}`,
  label: String(index + 1),
  accent,
}));
// Los demas jugadores ven la misma tira girando, pero sin numeros: el secreto nunca llega a su cliente.
// Todas las casillas son blancas e identicas para que el color no delate si el numero es alto o bajo.
const HIDDEN_ITEMS: RouletteItem[] = NUMBER_COLORS.map((_accent, index) => ({ key: `h${index}`, label: '?', accent: '#ffffff' }));

@Component({
  selector: 'app-ten-but',
  imports: [PlayerAvatarComponent, RouletteStripComponent, TenButResultsComponent],
  templateUrl: './ten-but.component.html',
  styleUrl: './ten-but.component.scss',
})
export class TenButComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private lastStage = '';
  private autoSpinTimer?: ReturnType<typeof setTimeout>;
  private autoSpinRoundKey = '';

  readonly numbers = Array.from({ length: 10 }, (_unused, index) => index + 1);
  readonly numberColors = NUMBER_COLORS;
  readonly numberItems = NUMBER_ITEMS;
  readonly hiddenItems = HIDDEN_ITEMS;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly specialRound = computed(() => this.matchService.match()?.specialRound || null);
  readonly state = computed(() => this.specialRound()?.tenBut || null);
  readonly privateTenBut = computed(() => {
    const privateState = this.matchService.privateState();
    return privateState?.minigameId === 'ten-but' ? privateState.tenBut : null;
  });
  readonly isSpeaker = computed(() => this.state()?.speakerId === this.currentPlayerId);
  readonly isParticipant = computed(() => Boolean(this.specialRound()?.participantIds.includes(this.currentPlayerId)));
  readonly speakerName = computed(() => this.matchService.playerName(this.state()?.speakerId));
  readonly speakerColor = computed(() => this.matchService.playerColor(this.state()?.speakerId));
  readonly speakerAvatar = computed(() => this.matchService.playerAvatar(this.state()?.speakerId));
  readonly secretNumber = computed(() => {
    const privateTenBut = this.privateTenBut();
    return privateTenBut?.role === 'speaker' ? privateTenBut.secretNumber || null : null;
  });
  readonly landingOffset = computed(() => {
    const privateTenBut = this.privateTenBut();
    return privateTenBut?.role === 'speaker' ? privateTenBut.landingOffset || 0 : 0;
  });
  readonly numberRevealed = signal(false);
  readonly selectedNumber = signal<number | null>(null);
  readonly confirmedAnswer = signal<number | null>(null);
  readonly sending = signal(false);
  readonly errorMessage = signal('');

  readonly submittedAnswer = computed(() => {
    const privateTenBut = this.privateTenBut();
    const fromServer = privateTenBut?.role === 'guesser' ? privateTenBut.submittedAnswer : null;
    return this.confirmedAnswer() ?? fromServer ?? null;
  });
  readonly hasAnswered = computed(
    () => this.submittedAnswer() !== null || Boolean(this.state()?.answeredPlayerIds.includes(this.currentPlayerId)),
  );
  readonly guessers = computed(() =>
    (this.specialRound()?.participantIds || [])
      .filter((playerId) => playerId !== this.state()?.speakerId)
      .map((playerId) => ({
        id: playerId,
        name: this.matchService.playerName(playerId),
        color: this.matchService.playerColor(playerId),
        avatarUrl: this.matchService.playerAvatar(playerId),
        answered: Boolean(this.state()?.answeredPlayerIds.includes(playerId)),
      })),
  );
  readonly answeredCount = computed(() => this.guessers().filter((guesser) => guesser.answered).length);

  readonly answerTimer = this.timerService.countdown(() => this.state()?.answerEndsAt, {
    beep: true,
    paused: () => this.matchService.hostPaused(),
  });

  constructor() {
    // El portavoz no pulsa nada: un segundo despues de ver su pantalla, la ruleta gira sola.
    effect(() => {
      const state = this.state();
      const roundKey = `${this.matchService.match()?.lobbyId}:${this.specialRound()?.roundNumber}`;

      if (state?.stage !== 'waiting-spin' || !this.isSpeaker() || this.autoSpinRoundKey === roundKey) {
        return;
      }

      this.autoSpinRoundKey = roundKey;
      clearTimeout(this.autoSpinTimer);
      this.autoSpinTimer = setTimeout(() => void this.spin(), 1000);
    });

    effect(() => {
      const stage = this.state()?.stage || '';

      if (stage === this.lastStage) {
        return;
      }

      if (this.lastStage) {
        scrollGameToTop(this.host.nativeElement);
      }

      if (stage === 'answering' && this.lastStage) {
        this.audioService.playEffect('turn');
      }

      if (stage !== 'spinning' && stage !== 'answering') {
        this.numberRevealed.set(false);
      }

      this.lastStage = stage;
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.autoSpinTimer);
  }

  async spin(): Promise<void> {
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!lobbyId || !this.isSpeaker() || this.sending() || this.state()?.stage !== 'waiting-spin') {
      return;
    }

    this.sending.set(true);
    const response = await this.matchService.spinTenBut(lobbyId);
    this.sending.set(false);
    this.errorMessage.set(response.ok ? '' : response.reason || 'No se pudo girar la ruleta.');
  }

  onSpeakerLanded(): void {
    this.numberRevealed.set(true);
    this.audioService.playEffect('reveal');
  }

  selectNumber(value: number): void {
    if (this.hasAnswered() || this.state()?.stage !== 'answering') {
      return;
    }

    this.selectedNumber.set(value);
    this.audioService.playEffect('select');
  }

  async confirmAnswer(): Promise<void> {
    const lobbyId = this.matchService.match()?.lobbyId;
    const value = this.selectedNumber();

    if (!lobbyId || value === null || this.hasAnswered() || this.sending()) {
      return;
    }

    this.sending.set(true);
    const response = await this.matchService.answerTenBut(lobbyId, value);
    this.sending.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo enviar la respuesta.');
      return;
    }

    this.errorMessage.set('');
    this.confirmedAnswer.set(response.answer ?? value);
    this.audioService.playEffect('confirm');
  }
}
