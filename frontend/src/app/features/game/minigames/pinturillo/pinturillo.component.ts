import {
  Component,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { DrawingBoardComponent } from '../../../../shared/components/drawing-board/drawing-board.component';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';

// Cada cuanto como maximo se envia el dibujo al resto: fluido sin saturar el socket.
const FRAME_INTERVAL_MS = 350;
const WORD_REVEAL_MS = 4200;

@Component({
  selector: 'app-pinturillo',
  imports: [DrawingBoardComponent, FormsModule, PlayerAvatarComponent],
  templateUrl: './pinturillo.component.html',
  styleUrl: './pinturillo.component.scss',
})
export class PinturilloComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly board = viewChild(DrawingBoardComponent);
  private readonly chatList = viewChild<ElementRef<HTMLElement>>('chatList');
  private frameTimer?: ReturnType<typeof setTimeout>;
  private seenMessages = 0;
  private lastHintCount = -1;
  private lastStage = '';

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly isHost = this.matchService.isHost;
  readonly specialRound = computed(() => this.matchService.match()?.specialRound || null);
  readonly state = computed(() => this.specialRound()?.pinturillo || null);
  readonly privateRole = computed(() => {
    const privateState = this.matchService.privateState();
    return privateState?.minigameId === 'pinturillo' ? privateState.pinturillo || null : null;
  });
  readonly isDrawer = computed(() => this.state()?.drawerId === this.currentPlayerId);
  readonly isParticipant = computed(() => Boolean(this.specialRound()?.participantIds.includes(this.currentPlayerId)));
  readonly secretWord = computed(() => {
    const role = this.privateRole();
    return role?.role === 'drawer' ? role.word : '';
  });
  readonly drawerName = computed(() => this.matchService.playerName(this.state()?.drawerId));
  readonly hasGuessed = computed(() => Boolean(this.state()?.guessedPlayerIds.includes(this.currentPlayerId)));
  readonly frame = this.matchService.pinturilloFrame;
  readonly guessText = signal('');
  readonly sending = signal(false);
  readonly feedback = signal('');
  readonly letterCount = computed(() => (this.state()?.hint || []).filter((character) => character !== ' ').length);

  readonly startTimer = this.timerService.countdown(() => this.state()?.startsAt, { paused: () => this.matchService.hostPaused() });
  readonly drawTimer = this.timerService.countdown(() => (this.state()?.stage === 'drawing' ? this.state()?.endsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
  });
  readonly started = computed(() => this.startTimer.remainingMs() <= 0);
  private readonly revealEndsAt = signal<number | null>(null);
  readonly revealTimer = this.timerService.countdown(() => this.revealEndsAt(), { clock: 'local' });
  readonly showWordReveal = computed(() => this.state()?.stage === 'results' && this.revealTimer.remainingMs() > 0);

  readonly messages = computed(() =>
    (this.state()?.chat || []).map((message) => ({
      ...message,
      name: this.matchService.playerName(message.playerId),
      avatarUrl: this.matchService.playerAvatar(message.playerId),
      color: this.matchService.playerColor(message.playerId),
      mine: message.playerId === this.currentPlayerId,
    })),
  );

  readonly players = computed(() =>
    (this.specialRound()?.participantIds || []).map((playerId) => ({
      id: playerId,
      name: this.matchService.playerName(playerId),
      avatarUrl: this.matchService.playerAvatar(playerId),
      color: this.matchService.playerColor(playerId),
      drawer: playerId === this.state()?.drawerId,
      guessed: Boolean(this.state()?.guessedPlayerIds.includes(playerId)),
    })),
  );

  readonly resultRows = computed(() => {
    const outcome = this.state()?.outcome;

    if (!outcome) {
      return [];
    }

    const guesses = new Map(outcome.guesses.map((guess) => [guess.playerId, guess]));

    return (this.specialRound()?.participantIds || [])
      .filter((playerId) => playerId !== outcome.drawerId)
      .map((playerId) => ({
        id: playerId,
        name: this.matchService.playerName(playerId),
        avatarUrl: this.matchService.playerAvatar(playerId),
        color: this.matchService.playerColor(playerId),
        order: guesses.get(playerId)?.order || null,
        points: guesses.get(playerId)?.points || 0,
      }))
      .sort((first, second) => (first.order || 99) - (second.order || 99));
  });

  constructor() {
    effect(() => {
      const lobbyId = this.matchService.match()?.lobbyId;

      // Al entrar (o reconectar) se pide el ultimo dibujo para no ver el lienzo en blanco.
      if (lobbyId && this.state() && !untracked(this.isDrawer)) {
        void this.matchService.requestPinturilloFrame(lobbyId);
      }
    });

    effect(() => {
      const state = this.state();

      if (!state) {
        return;
      }

      const revealed = state.hint.filter((character) => character && character !== ' ').length;

      if (this.lastHintCount >= 0 && revealed > this.lastHintCount && state.stage === 'drawing') {
        this.audioService.playEffect('pop');
      }

      this.lastHintCount = revealed;

      if (state.stage === 'results' && this.lastStage === 'drawing') {
        this.revealEndsAt.set(Date.now() + WORD_REVEAL_MS);
        this.audioService.playEffect('vote-end');
      } else if (state.stage === 'results' && !this.lastStage) {
        this.revealEndsAt.set(null);
      }

      this.lastStage = state.stage;
    });

    effect(() => {
      const messages = this.messages();
      const fresh = messages.slice(this.seenMessages);
      this.seenMessages = messages.length;

      for (const message of fresh) {
        if (message.kind === 'correct') {
          // Acertar tu mismo suena a victoria; que acierte otro, campanita.
          if (message.mine) {
            this.audioService.playFileEffect('win');
          } else {
            this.audioService.playSfx('acierto', { gain: 0.7 });
          }
        } else if (message.kind === 'chat' && !message.mine) {
          this.audioService.playEffect('tick');
        }
      }
    });

    afterRenderEffect(() => {
      this.messages();
      const list = this.chatList()?.nativeElement;

      if (list) {
        list.scrollTop = list.scrollHeight;
      }
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.frameTimer);
  }

  onBoardChanged(): void {
    if (this.frameTimer || !this.isDrawer()) {
      return;
    }

    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      this.pushFrame();
    }, FRAME_INTERVAL_MS);
  }

  async sendGuess(): Promise<void> {
    const lobbyId = this.matchService.match()?.lobbyId;
    const text = this.guessText().trim();

    if (!lobbyId || !text || this.sending()) {
      return;
    }

    this.sending.set(true);
    const response = await this.matchService.guessPinturillo(lobbyId, text);
    this.sending.set(false);

    if (!response.ok) {
      this.feedback.set(response.reason || 'No se pudo enviar.');
      return;
    }

    this.guessText.set('');
    this.feedback.set(response.correct ? `¡Correcto! +${response.points} puntos` : response.close ? '¡Casi! Estás muy cerca.' : '');
  }

  hintSlotClass(character: string): string {
    return character === ' ' ? 'space' : character ? 'shown' : 'hidden';
  }

  private pushFrame(): void {
    const lobbyId = this.matchService.match()?.lobbyId;
    const board = this.board();

    if (!lobbyId || !board || this.state()?.stage !== 'drawing') {
      return;
    }

    // WebP comprimido: unos pocos KB por fotograma frente a cientos en PNG.
    this.matchService.sendPinturilloFrame(lobbyId, board.toDataUrl('image/webp', 0.6));
  }
}
