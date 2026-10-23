import { Component, computed, effect, inject, signal, viewChild } from '@angular/core';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { DrawingBoardComponent } from '../../../../shared/components/drawing-board/drawing-board.component';

const PAINT_TARGETS = [
  'Manzana',
  'Castillo',
  'Cohete',
  'Guitarra',
  'Zapato',
  'Helado',
  'Sombrero',
  'Llave',
  'Barco',
  'Robot',
  'Dinosaurio',
  'Camara',
  'Pizza',
  'Bicicleta',
  'Reloj',
  'Montana',
  'Avion',
  'Lampara',
  'Corona',
  'Paraguas',
  'Fantasma',
  'Taza',
  'Balon',
  'Arbol',
  'Coche',
];

@Component({
  selector: 'app-paint',
  imports: [DrawingBoardComponent],
  templateUrl: './paint.component.html',
  styleUrl: './paint.component.scss',
})
export class PaintComponent {
  private readonly matchService = inject(MatchService);
  private readonly board = viewChild(DrawingBoardComponent);
  private preparedRoundKey = '';
  private submittedRoundKey = '';

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly specialRound = computed(() => this.match()?.specialRound || null);
  readonly target = computed(() => this.specialRound()?.paintTarget || null);
  readonly submissions = computed(() => this.specialRound()?.paintSubmissions || []);
  readonly phase = computed(() => this.specialRound()?.paintPhase || 'preparing');
  private readonly phaseTimer = inject(GameTimerService).countdown(
    () => (this.phase() === 'drawing' ? this.specialRound()?.paintEndsAt : this.specialRound()?.paintVoteEndsAt),
    {
      paused: () => this.matchService.hostPaused(),
      onExpire: () => {
        if (this.phase() === 'drawing' && !this.submitted()) {
          void this.submitDrawing();
        }
      },
    },
  );
  readonly remainingSeconds = this.phaseTimer.seconds;
  readonly submitted = signal(false);
  readonly votedTargetId = signal('');
  readonly loading = signal(false);
  readonly errorMessage = signal('');

  readonly submittedCount = computed(() => this.submissions().length);
  readonly totalPlayers = computed(() => this.match()?.totalPlayers || 0);
  readonly votableSubmissions = computed(() =>
    this.submissions().filter((submission) => submission.playerId !== this.currentPlayerId),
  );
  readonly canSubmit = computed(() => this.phase() === 'drawing' && !this.submitted() && !this.loading());

  constructor() {
    effect(() => {
      const match = this.match();
      const specialRound = match?.specialRound;

      if (!match || !specialRound || specialRound.minigameId !== 'paint' || !this.isHost()) {
        return;
      }

      const roundKey = `${match.lobbyId}:${specialRound.roundNumber}:${specialRound.minigameId}`;

      if (this.preparedRoundKey === roundKey || specialRound.preparedByHost || specialRound.paintTarget) {
        return;
      }

      this.preparedRoundKey = roundKey;
      void this.preparePaint(match.lobbyId);
    });
  }

  openImageSearch(): void {
    const label = this.target()?.label;

    if (!label) {
      return;
    }

    window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(label)}`, '_blank', 'noopener');
  }

  hasVoted(): boolean {
    return Boolean(this.votedTargetId());
  }

  async submitDrawing(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;
    const round = this.specialRound();
    const board = this.board();

    if (!lobbyId || !round || !board || !this.canSubmit()) {
      return;
    }

    const submitKey = `${lobbyId}:${round.roundNumber}:${this.currentPlayerId}`;

    if (submitKey === this.submittedRoundKey) {
      return;
    }

    this.submittedRoundKey = submitKey;
    this.loading.set(true);
    const response = await this.matchService.submitPaintDrawing(lobbyId, board.toDataUrl('image/png'));
    this.loading.set(false);

    if (!response.ok) {
      this.submittedRoundKey = '';
      this.errorMessage.set(response.reason || 'No se pudo enviar el dibujo.');
      return;
    }

    this.submitted.set(true);
  }

  async vote(targetPlayerId: string): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || this.phase() !== 'voting' || this.votedTargetId() || targetPlayerId === this.currentPlayerId) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.submitPaintVote(lobbyId, targetPlayerId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo votar el dibujo.');
      return;
    }

    this.votedTargetId.set(targetPlayerId);
  }

  private async preparePaint(lobbyId: string): Promise<void> {
    const label = PAINT_TARGETS[Math.floor(Math.random() * PAINT_TARGETS.length)];
    const response = await this.matchService.preparePaintMinigame(lobbyId, {
      id: label.toLowerCase().replace(/\s+/g, '-'),
      label,
    });

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo preparar A Pintar.');
    }
  }
}
