import { Component, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { CrewmateComponent } from '../../../../shared/components/crewmate/crewmate.component';
import { scrollGameToTop } from '../../../../shared/scroll-game-to-top';
import { AmongVoteComponent } from './among-vote/among-vote.component';
import { EjectionComponent } from './ejection/ejection.component';
import { EJECTION_MS, ImpostorParticipantView, RESULTS_AT_MS, VOTE_REVEAL_MS } from './impostor-timeline';

type ImpostorView = 'turns' | 'voting' | 'vote-reveal' | 'ejection' | 'results';

const NO_EJECTION_REASONS: Record<string, string> = {
  tie: 'Empate',
  skip: 'Votación saltada',
  'no-votes': 'Nadie votó',
};

@Component({
  selector: 'app-impostor',
  imports: [AmongVoteComponent, CrewmateComponent, EjectionComponent],
  templateUrl: './impostor.component.html',
  styleUrl: './impostor.component.scss',
})
export class ImpostorComponent {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly host = inject(ElementRef<HTMLElement>);
  private lastTurnPlayerId: string | null = null;
  private lastView: ImpostorView | null = null;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly isHost = this.matchService.isHost;
  readonly hostPaused = this.matchService.hostPaused;
  readonly specialRound = computed(() => this.matchService.match()?.specialRound || null);
  readonly state = computed(() => this.specialRound()?.impostor || null);
  readonly privateRole = computed(() => {
    const privateState = this.matchService.privateState();
    return privateState?.minigameId === 'impostor' ? privateState.impostor : null;
  });
  readonly myRole = computed(() => this.privateRole()?.role || null);
  readonly secretWord = computed(() => {
    const role = this.privateRole();
    return role?.role === 'innocent' ? role.word : '';
  });
  readonly secretCategory = computed(() => {
    const role = this.privateRole();
    return role?.role === 'impostor' ? role.category : '';
  });
  readonly isParticipant = computed(() => Boolean(this.specialRound()?.participantIds.includes(this.currentPlayerId)));
  readonly roleHidden = signal(false);
  readonly sending = signal(false);
  readonly errorMessage = signal('');

  // Reloj de la resolucion: decide en que momento de la secuencia (votos, expulsion, resultados) estamos.
  private readonly resolutionClock = this.timerService.countdown(
    () => {
      const state = this.state();
      return state && (state.stage === 'reveal' || state.stage === 'no-ejection') ? state.stageStartedAt + RESULTS_AT_MS : null;
    },
    { paused: () => this.hostPaused() },
  );

  readonly view = computed<ImpostorView>(() => {
    const state = this.state();

    if (!state) {
      return 'turns';
    }

    if (state.stage === 'turns' || state.stage === 'voting') {
      return state.stage;
    }

    const elapsed = RESULTS_AT_MS - this.resolutionClock.remainingMs();

    if (elapsed < VOTE_REVEAL_MS) {
      return 'vote-reveal';
    }

    if (elapsed < VOTE_REVEAL_MS + EJECTION_MS || state.stage === 'no-ejection') {
      return 'ejection';
    }

    return 'results';
  });

  readonly participants = computed<ImpostorParticipantView[]>(() =>
    (this.specialRound()?.participantIds || []).map((playerId) => ({
      id: playerId,
      name: this.matchService.playerName(playerId),
      color: this.matchService.playerColor(playerId),
      active: this.matchService.isPlayerActive(playerId),
    })),
  );

  readonly turnRows = computed(() => {
    const state = this.state();

    if (!state) {
      return [];
    }

    return state.turnOrder.map((playerId, index) => ({
      id: playerId,
      name: this.matchService.playerName(playerId),
      color: this.matchService.playerColor(playerId),
      active: this.matchService.isPlayerActive(playerId),
      status: index < state.turnIndex ? 'done' : index === state.turnIndex ? 'current' : 'pending',
      order: index + 1,
    }));
  });

  readonly currentTurnPlayerId = computed(() => this.state()?.currentTurnPlayerId || null);
  readonly isMyTurn = computed(() => this.currentTurnPlayerId() === this.currentPlayerId);
  readonly myTurnDone = computed(() => Boolean(this.state()?.completedTurnIds.includes(this.currentPlayerId)));
  readonly canHostSkipTurn = computed(
    () => this.isHost() && !this.isMyTurn() && Boolean(this.currentTurnPlayerId()) && !this.matchService.isPlayerActive(this.currentTurnPlayerId()),
  );

  readonly ejection = computed(() => {
    const state = this.state();
    const result = state?.outcome || state?.lastRoundResult;

    if (!state || !result) {
      return null;
    }

    const outcome = state.outcome;
    const ejectedId = result.ejectedId;

    if (outcome?.abandoned) {
      return { color: null, text: 'El impostor ha abandonado la nave.', subtitle: 'Victoria para los inocentes.', dramatic: false };
    }

    if (ejectedId) {
      const name = this.matchService.playerName(ejectedId);
      const wasImpostor = outcome?.ejectedWasImpostor;
      return {
        color: this.matchService.playerColor(ejectedId),
        text: wasImpostor ? `${name} era el impostor.` : `${name} no era el impostor.`,
        subtitle: wasImpostor ? 'Quedan 0 impostores.' : 'Queda 1 impostor... y acaba de ganar.',
        dramatic: true,
      };
    }

    const reason = NO_EJECTION_REASONS[result.reason] || 'Sin decision';
    return {
      color: null,
      text: `Nadie fue expulsado. (${reason})`,
      subtitle: outcome
        ? 'Era la última ronda: el impostor se sale con la suya.'
        : `Siguiente ronda de palabras: ${state.wordRound + 1} de ${state.maxRounds}.`,
      dramatic: Boolean(outcome),
    };
  });

  readonly iWon = computed(() => {
    const outcome = this.state()?.outcome;
    const role = this.myRole();

    if (!outcome || !role) {
      return null;
    }

    return (outcome.winner === 'impostor') === (role === 'impostor');
  });

  constructor() {
    effect(() => {
      const turnPlayerId = this.currentTurnPlayerId();

      if (turnPlayerId && turnPlayerId !== this.lastTurnPlayerId) {
        this.audioService.playEffect('turn');
      }

      this.lastTurnPlayerId = turnPlayerId;
    });

    effect(() => {
      const view = this.view();
      const previous = this.lastView;
      this.lastView = view;

      if (view === previous || previous === null) {
        return;
      }

      untracked(() => {
        if (view !== 'ejection') {
          scrollGameToTop(this.host.nativeElement);
        }

        if (view === 'voting') {
          this.audioService.playEffect('reveal');
        } else if (view === 'vote-reveal') {
          this.audioService.playEffect('vote-end');
        } else if (view === 'results') {
          this.audioService.playEffect(this.iWon() === false ? 'defeat' : 'victory');
        }
      });
    });
  }

  toggleRoleVisibility(): void {
    this.roleHidden.update((hidden) => !hidden);
  }

  async advanceTurn(): Promise<void> {
    const lobbyId = this.matchService.match()?.lobbyId;
    const state = this.state();

    if (!lobbyId || !state || this.sending() || (!this.isMyTurn() && !this.canHostSkipTurn())) {
      return;
    }

    this.sending.set(true);
    this.audioService.playEffect('confirm');
    const response = await this.matchService.advanceImpostorTurn(lobbyId, state.turnIndex);
    this.sending.set(false);
    this.errorMessage.set(response.ok ? '' : response.reason || 'No se pudo pasar el turno.');
  }

  async castVote(targetId: string): Promise<void> {
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!lobbyId || this.sending()) {
      return;
    }

    this.sending.set(true);
    const response = await this.matchService.voteImpostor(lobbyId, targetId);
    this.sending.set(false);
    this.errorMessage.set(response.ok ? '' : response.reason || 'No se pudo registrar el voto.');
  }

  playerName(playerId: string | null | undefined): string {
    return this.matchService.playerName(playerId);
  }

  playerColor(playerId: string | null | undefined): string {
    return this.matchService.playerColor(playerId);
  }
}
