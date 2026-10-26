import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';

@Component({
  selector: 'app-who',
  imports: [PlayerAvatarComponent],
  templateUrl: './who.component.html',
  styleUrl: './who.component.scss',
})
export class WhoComponent {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private announcedRound = 0;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.who || null);
  /** Voto propio de la ronda (se marca al momento, sin esperar al servidor). */
  readonly myVote = signal<{ round: number; targetId: string } | null>(null);

  readonly voteTimer = this.timerService.countdown(() => (this.state()?.stage === 'voting' ? this.state()?.voteEndsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 15000,
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly votedThisRound = computed(() => {
    const state = this.state();
    const vote = this.myVote();
    return Boolean(state && ((vote && vote.round === state.round) || state.votedPlayerIds.includes(this.currentPlayerId)));
  });
  readonly canVote = computed(() => this.isPlayer() && this.state()?.stage === 'voting' && this.voteTimer.remainingMs() > 0 && !this.votedThisRound());
  /** Resultado de la ronda en curso cuando ya se ha revelado. */
  readonly reveal = computed(() => {
    const state = this.state();
    return state?.stage === 'reveal' || state?.stage === 'finished' ? state.history.find((entry) => entry.round === state.round) || null : null;
  });

  readonly cards = computed(() => {
    const state = this.state();
    const reveal = this.reveal();
    const vote = this.myVote();
    const myTarget = vote && vote.round === state?.round ? vote.targetId : (reveal?.votes.find((entry) => entry.voterId === this.currentPlayerId)?.targetId ?? null);
    const top = reveal ? Math.max(1, ...reveal.tally.map((entry) => entry.count)) : 1;

    return (this.matchService.match()?.specialRound?.participantIds || []).map((playerId) => {
      const count = reveal?.tally.find((entry) => entry.playerId === playerId)?.count || 0;
      return {
        playerId,
        name: this.matchService.playerName(playerId),
        avatarUrl: this.matchService.playerAvatar(playerId),
        colorId: this.matchService.playerColor(playerId),
        mine: playerId === this.currentPlayerId,
        voted: Boolean(state?.votedPlayerIds.includes(playerId)),
        picked: myTarget === playerId,
        count,
        bar: count / top,
        chosen: Boolean(reveal?.chosen.includes(playerId)),
        voters: (reveal?.votes || [])
          .filter((entry) => entry.targetId === playerId)
          .map((entry) => ({
            playerId: entry.voterId,
            name: this.matchService.playerName(entry.voterId),
            avatarUrl: this.matchService.playerAvatar(entry.voterId),
            colorId: this.matchService.playerColor(entry.voterId),
          })),
      };
    });
  });

  readonly votedCount = computed(() => this.state()?.votedPlayerIds.length || 0);
  readonly totalVoters = computed(() => this.matchService.match()?.specialRound?.participantIds.length || 0);

  /** Texto del resultado de la ronda para este jugador. */
  readonly revealText = computed(() => {
    const reveal = this.reveal();

    if (!reveal) {
      return '';
    }

    if (!reveal.chosen.length) {
      return 'Nadie ha votado en esta ronda.';
    }

    const names = reveal.chosen.map((playerId) => (playerId === this.currentPlayerId ? 'ti' : this.matchService.playerName(playerId)));
    const head = reveal.chosen.length === 1 ? `¡La pregunta es para ${names[0]}!` : `¡Empate entre ${names.slice(0, -1).join(', ')} y ${names.at(-1)}!`;

    if (!this.isPlayer()) {
      return head;
    }

    const points = reveal.points.find((entry) => entry.playerId === this.currentPlayerId)?.points || 0;
    const voted = reveal.votes.some((entry) => entry.voterId === this.currentPlayerId);
    return `${head} ${points ? `Has acertado: +${points}` : voted ? 'No has acertado: +0' : 'No votaste: +0'}`;
  });

  readonly statusText = computed(() => {
    const state = this.state();

    if (!state || state.stage === 'finished') {
      return 'Fin de ¿Quién es quién?';
    }

    if (state.stage === 'question') {
      return 'Lee bien la pregunta…';
    }

    if (state.stage === 'reveal') {
      return this.revealText();
    }

    if (!this.isPlayer()) {
      return 'Mira cómo votan los demás.';
    }

    if (this.votedThisRound()) {
      return `Voto enviado. Esperando al resto (${this.votedCount()}/${this.totalVoters()})…`;
    }

    return this.voteTimer.remainingMs() > 0 ? 'Toca a quien mejor encaje con la pregunta (también puedes votarte a ti).' : '¡Tiempo!';
  });

  readonly myTotal = computed(() =>
    (this.state()?.history || []).reduce((sum, entry) => sum + (entry.points.find((row) => row.playerId === this.currentPlayerId)?.points || 0), 0),
  );

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
      // Al revelar: redoble para quien ha acertado; nunca sonidos de fallo.
      const state = this.state();
      const reveal = this.reveal();

      if (state && reveal && state.stage === 'reveal' && this.announcedRound !== state.round) {
        this.announcedRound = state.round;
        const points = reveal.points.find((entry) => entry.playerId === this.currentPlayerId)?.points || 0;
        untracked(() => (points ? this.audioService.playSfx('acierto') : this.audioService.playSfx('timbre')));
      }
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const best = Math.max(...outcome.ranking.map((row) => row.points));
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine && best > 0 && mine.points === best) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  vote(targetId: string): void {
    const state = this.state();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!state || !lobbyId || !this.canVote()) {
      return;
    }

    this.myVote.set({ round: state.round, targetId });
    this.audioService.playSfx('voto');
    void this.matchService.whoVote(lobbyId, state.round, targetId);
  }
}
