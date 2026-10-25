import { Component, computed, inject, input, output, signal } from '@angular/core';
import { AudioService } from '../../../../../core/services/audio.service';
import { GameTimerService } from '../../../../../core/services/game-timer.service';
import { ImpostorRoundResult } from '../../../../../core/services/socket.service';
import { CrewmateComponent } from '../../../../../shared/components/crewmate/crewmate.component';
import { ImpostorParticipantView } from '../impostor-timeline';

@Component({
  selector: 'app-among-vote',
  imports: [CrewmateComponent],
  templateUrl: './among-vote.component.html',
  styleUrl: './among-vote.component.scss',
})
export class AmongVoteComponent {
  private readonly audioService = inject(AudioService);

  readonly participants = input.required<ImpostorParticipantView[]>();
  readonly currentPlayerId = input.required<string>();
  /** Rol privado del jugador local: solo cambia el color de SU propio nombre en SU pantalla. */
  readonly myRole = input<'impostor' | 'innocent' | null>(null);
  readonly canVote = input(true);
  readonly votedPlayerIds = input<string[]>([]);
  readonly blankVoteAllowed = input(true);
  readonly voteEndsAt = input<number | null>(null);
  readonly paused = input(false);
  readonly wordRound = input(1);
  readonly maxRounds = input(5);
  readonly sending = input(false);
  /** Votos ya resueltos (solo tras el recuento) para mostrarlos sobre la tablet. */
  readonly revealedResult = input<ImpostorRoundResult | null>(null);
  readonly vote = output<string>();

  readonly selectedTarget = signal<string | null>(null);
  readonly timer = inject(GameTimerService).countdown(() => this.voteEndsAt(), { paused: () => this.paused() });
  readonly hasVoted = computed(() => this.votedPlayerIds().includes(this.currentPlayerId()));
  readonly locked = computed(() => !this.canVote() || this.hasVoted() || this.sending() || Boolean(this.revealedResult()));
  readonly votersByTarget = computed(() => {
    const byTarget = new Map<string, string[]>();

    for (const entry of this.revealedResult()?.votes || []) {
      byTarget.set(entry.targetId, [...(byTarget.get(entry.targetId) || []), entry.voterId]);
    }

    return byTarget;
  });
  readonly colorById = computed(() => new Map(this.participants().map((participant) => [participant.id, participant.color])));

  select(targetId: string): void {
    if (this.locked() || targetId === this.currentPlayerId() || (targetId === 'skip' && !this.blankVoteAllowed())) {
      return;
    }

    this.selectedTarget.set(this.selectedTarget() === targetId ? null : targetId);
    this.audioService.playEffect('select');
  }

  confirm(event: Event): void {
    event.stopPropagation();
    const target = this.selectedTarget();

    if (!target || this.locked()) {
      return;
    }

    this.audioService.playSfx('voto');
    this.vote.emit(target);
    this.selectedTarget.set(null);
  }

  cancel(event: Event): void {
    event.stopPropagation();
    this.selectedTarget.set(null);
  }

  voterColors(targetId: string): string[] {
    return (this.votersByTarget().get(targetId) || []).map((voterId) => this.colorById().get(voterId) || 'gray');
  }
}
