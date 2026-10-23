import { Component, computed, inject, signal } from '@angular/core';
import { AudioService } from '../../../core/services/audio.service';
import { MatchService } from '../../../core/services/match.service';
import { SocketService } from '../../../core/services/socket.service';
import { MiiStageComponent, MiiStagePlayer } from '../../../shared/components/mii-stage/mii-stage.component';
import { PlayerAvatarComponent } from '../../../shared/components/player-avatar/player-avatar.component';

@Component({
  selector: 'app-match-finished',
  imports: [MiiStageComponent, PlayerAvatarComponent],
  templateUrl: './match-finished.component.html',
  styleUrl: './match-finished.component.scss',
})
export class MatchFinishedComponent {
  private readonly matchService = inject(MatchService);
  private readonly socketService = inject(SocketService);

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly loading = signal(false);
  readonly errorMessage = signal('');
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
  readonly confetti = Array.from({ length: 28 }, (_unused, index) => ({
    left: (index * 37) % 100,
    delay: (index % 7) * 180,
    hue: (index * 53) % 360,
  }));

  constructor() {
    inject(AudioService).playEffect('victory');
  }

  playerAvatar(playerId: string): string {
    return this.matchService.playerAvatar(playerId);
  }

  playerColor(playerId: string): string {
    return this.matchService.playerColor(playerId);
  }

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

  async leave(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (lobbyId) {
      await this.socketService.leaveRoom(lobbyId);
    }

    this.matchService.clearMatchState();
    this.socketService.lobby.set(null);
  }
}
