import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';

const LETTERS = ['A', 'B', 'C', 'D'];
const KEYS: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, '1': 0, '2': 1, '3': 2, '4': 3 };

@Component({
  selector: 'app-quiz',
  imports: [PlayerAvatarComponent],
  templateUrl: './quiz.component.html',
  styleUrl: './quiz.component.scss',
})
export class QuizComponent {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private announced = '';
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.quiz || null);
  /** Respuesta propia de la ronda (se marca al momento, sin esperar al servidor). */
  readonly myAnswer = signal<{ round: number; choice: number } | null>(null);

  readonly leadTimer = this.timerService.countdown(() => (this.state()?.stage === 'answering' ? this.state()?.answerStartsAt : null));
  readonly answerTimer = this.timerService.countdown(() => (this.state()?.stage === 'answering' ? this.state()?.answerEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly answering = computed(() => this.state()?.stage === 'answering' && this.leadTimer.remainingMs() <= 0 && this.answerTimer.remainingMs() > 0);
  readonly myChoice = computed(() => {
    const state = this.state();
    const mine = this.myAnswer();

    if (!state) {
      return null;
    }

    if (mine && mine.round === state.round) {
      return mine.choice;
    }

    return state.answers.find((entry) => entry.playerId === this.currentPlayerId)?.choice ?? null;
  });
  readonly answered = computed(() => this.myChoice() !== null || Boolean(this.state()?.answeredPlayerIds.includes(this.currentPlayerId)));
  readonly canAnswer = computed(() => this.isPlayer() && this.answering() && !this.answered());
  readonly revealed = computed(() => this.state()?.stage !== 'answering');
  readonly correctIndex = computed(() => this.state()?.correctIndex ?? null);
  readonly difficultyStars = computed(() => '★'.repeat(this.state()?.difficulty || 1) + '☆'.repeat(5 - (this.state()?.difficulty || 1)));

  readonly options = computed(() => {
    const state = this.state();

    if (!state) {
      return [];
    }

    const correct = this.correctIndex();
    return state.options.map((text, index) => ({
      index,
      letter: LETTERS[index],
      text,
      picked: this.myChoice() === index,
      correct: correct === index,
      dimmed: correct !== null && correct !== index,
      voters: state.answers
        .filter((entry) => entry.choice === index)
        .map((entry) => ({
          playerId: entry.playerId,
          name: this.matchService.playerName(entry.playerId),
          avatarUrl: this.matchService.playerAvatar(entry.playerId),
          colorId: this.matchService.playerColor(entry.playerId),
        })),
    }));
  });

  readonly answeredCount = computed(() => this.state()?.answeredPlayerIds.length || 0);
  readonly totalPlayers = computed(() => this.matchService.match()?.specialRound?.participantIds.length || 0);
  readonly myTotal = computed(() =>
    (this.state()?.history || []).reduce((sum, entry) => sum + (entry.points.find((row) => row.playerId === this.currentPlayerId)?.points || 0), 0),
  );

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state || state.stage === 'finished') {
      return 'Fin de las preguntas.';
    }

    if (state.stage === 'votes') {
      return 'Estas son las respuestas de todos… ¿cuál será la buena?';
    }

    if (state.stage === 'correct') {
      const mine = this.myChoice();

      if (!this.isPlayer()) {
        return `La respuesta correcta era la ${LETTERS[state.correctIndex ?? 0]}.`;
      }

      return mine === null ? 'No contestaste: +0' : mine === state.correctIndex ? '¡Correcto! +10' : `Fallaste: era la ${LETTERS[state.correctIndex ?? 0]}.`;
    }

    if (this.leadTimer.remainingMs() > 0) {
      return 'Lee bien la pregunta…';
    }

    if (!this.isPlayer()) {
      return 'Mira cómo contestan los demás.';
    }

    if (this.answered()) {
      return `Respuesta enviada. Esperando al resto (${this.answeredCount()}/${this.totalPlayers()})…`;
    }

    return this.answerTimer.remainingMs() > 0 ? 'Elige una respuesta (o pulsa A, B, C o D).' : '¡Tiempo!';
  });

  readonly ranking = computed(() => {
    const rows = this.state()?.outcome?.ranking || [];
    const levels = [...new Set(rows.map((row) => row.points))];
    return rows.map((row) => ({
      ...row,
      position: levels.indexOf(row.points) + 1,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
    }));
  });

  constructor() {
    effect(() => {
      // Sonidos al destapar los votos y al marcar la correcta (solo si se acierta; nunca de fallo).
      const state = this.state();

      if (!state) {
        return;
      }

      const key = `${state.round}:${state.stage}`;

      if (key !== this.announced) {
        this.announced = key;
        untracked(() => {
          if (state.stage === 'votes') {
            this.audioService.playSfx('carta-voltear');
          } else if (state.stage === 'correct' && this.myChoice() === state.correctIndex) {
            this.audioService.playSfx('acierto');
          }
        });
      }
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine && mine.points > 0 && mine.points === Math.max(...outcome.ranking.map((row) => row.points))) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const choice = KEYS[event.key?.toLowerCase()];

    if (choice !== undefined && !event.repeat && this.canAnswer()) {
      event.preventDefault();
      this.answer(choice);
    }
  }

  answer(choice: number): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canAnswer()) {
      return;
    }

    this.myAnswer.set({ round: state.round, choice });
    this.audioService.playSfx('voto');
    void this.matchService.quizAnswer(lobbyId, state.round, choice);
  }
}
