import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { AudioService } from '../../../core/services/audio.service';
import { GameTimerService } from '../../../core/services/game-timer.service';
import { MatchService } from '../../../core/services/match.service';
import { SocketService } from '../../../core/services/socket.service';
import { MiiStageComponent, MiiStagePlayer } from '../../../shared/components/mii-stage/mii-stage.component';
import { PlayerAvatarComponent } from '../../../shared/components/player-avatar/player-avatar.component';

// Podio a pantalla completa unos segundos; despues, en una transicion lateral, los "maricones del dia" y,
// 2 segundos mas tarde, el boton del host para volver al lobby.
const PODIUM_MS = 5500;
// Duracion de la transicion lateral (igual que en el SCSS).
const SLIDE_MS = 850;
const LOSERS_BEFORE_ACTIONS_MS = SLIDE_MS + 2000;

type FinishedPhase = 'podium' | 'losers' | 'actions';

@Component({
  selector: 'app-match-finished',
  imports: [MiiStageComponent, PlayerAvatarComponent],
  templateUrl: './match-finished.component.html',
  styleUrl: './match-finished.component.scss',
})
export class MatchFinishedComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly socketService = inject(SocketService);
  private readonly timers: Array<ReturnType<typeof setTimeout>> = [];

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly phase = signal<FinishedPhase>('podium');
  /** El podio se desmonta cuando ya ha salido de pantalla (libera su escena 3D). */
  readonly showPodium = signal(true);
  readonly standings = computed(() => this.match()?.finalStandings || []);
  // Orden visual del podio: 2º, 1º, 3º.
  readonly podium = computed(() =>
    [this.standings()[1], this.standings()[0], this.standings()[2]].filter((entry) => Boolean(entry)),
  );
  // Podio en 3D: el 1º baila a lo grande, el 2º un baile tranquilo y el 3º aplaude.
  readonly podiumMiis = computed<MiiStagePlayer[]>(() => {
    const styleByPlace: Record<number, Pick<MiiStagePlayer, 'mood' | 'elevation' | 'pedestal'>> = {
      1: { mood: 'dance-big', elevation: 0.95, pedestal: { color: '#ebd620', label: '1º' } },
      2: { mood: 'dance-small', elevation: 0.62, pedestal: { color: '#e6e6e6', label: '2º' } },
      3: { mood: 'clap', elevation: 0.38, pedestal: { color: '#ce8946', label: '3º' } },
    };

    return this.podium().map((entry) => ({
      id: entry.playerId,
      name: entry.playerName,
      avatarUrl: this.matchService.playerAvatar(entry.playerId),
      color: this.matchService.playerColor(entry.playerId),
      label: entry.playerName,
      labelTone: 'name',
      badge: `${entry.score} pts`,
      ...(styleByPlace[entry.position] || { mood: 'clap' }),
    }));
  });

  /** Quien (o quienes, si empatan) ha sacado la puntuacion mas baja de toda la partida. */
  readonly losers = computed(() => {
    const standings = this.standings();

    if (!standings.length) {
      return [];
    }

    const lowest = Math.min(...standings.map((entry) => entry.score));
    return standings.filter((entry) => entry.score === lowest);
  });
  readonly lowestScore = computed(() => this.losers()[0]?.score ?? 0);
  readonly losersTitle = computed(() => (this.losers().length > 1 ? 'MARICONES DEL DÍA' : 'MARICÓN DEL DÍA'));
  // La misma tristeza que cuando se pierde un minijuego en el marcador.
  readonly loserMiis = computed<MiiStagePlayer[]>(() =>
    this.losers().map((entry) => ({
      id: entry.playerId,
      name: entry.playerName,
      avatarUrl: this.matchService.playerAvatar(entry.playerId),
      color: this.matchService.playerColor(entry.playerId),
      mood: 'sad',
      label: entry.playerName,
      labelTone: 'name',
      badge: `${entry.score} pts`,
    })),
  );

  /** Para quien no es host: cuenta atras hasta que el servidor le lleve al lobby detras del host. */
  readonly lobbyCountdown = inject(GameTimerService).countdown(() => this.socketService.lobbyReturnAt(), { clock: 'local' });
  readonly hostInLobby = computed(() => this.socketService.lobbyReturnAt() !== null);

  readonly confetti = Array.from({ length: 28 }, (_unused, index) => ({
    left: (index * 37) % 100,
    delay: (index % 7) * 180,
    hue: (index * 53) % 360,
  }));

  constructor() {
    inject(AudioService).playEffect('victory');
    this.timers.push(
      setTimeout(() => this.phase.set('losers'), PODIUM_MS),
      setTimeout(() => this.showPodium.set(false), PODIUM_MS + SLIDE_MS + 100),
      setTimeout(() => this.phase.set('actions'), PODIUM_MS + LOSERS_BEFORE_ACTIONS_MS),
    );
  }

  ngOnDestroy(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
  }

  playerAvatar(playerId: string): string {
    return this.matchService.playerAvatar(playerId);
  }

  playerColor(playerId: string): string {
    return this.matchService.playerColor(playerId);
  }

  /** Solo el host: vuelve al mismo lobby y, al confirmarlo, arrastra al resto 3 segundos despues. */
  async returnToLobby(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || this.loading()) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.returnToLobby(lobbyId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo volver al lobby.');
    }
  }
}
