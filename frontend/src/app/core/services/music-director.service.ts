import { Injectable, effect, inject } from '@angular/core';
import { AudioService, MusicTrack } from './audio.service';
import { SocketService } from './socket.service';

/**
 * Decide que musica de fondo suena segun donde este el jugador:
 * menu principal y lobby -> musica de sala de espera (la misma, sin cortes al entrar al lobby);
 * minijuegos (ruleta incluida) -> musica de minijuego; marcador y podio -> musica de marcador.
 */
@Injectable({ providedIn: 'root' })
export class MusicDirectorService {
  private readonly audioService = inject(AudioService);
  private readonly socketService = inject(SocketService);

  constructor() {
    effect(() => {
      const match = this.socketService.match();
      let track: MusicTrack = 'lobby';

      if (match) {
        track = match.phase === 'scoreboard' || match.phase === 'finished' ? 'scoreboard' : 'minigame';
      }

      // Se intenta desde el primer instante; si el navegador lo bloquea, AudioService la arranca en el primer gesto.
      this.audioService.playMusic(track);
    });
  }

  /**
   * Red de seguridad tras crear o unirse a un lobby: cuando el navegador esta desocupado comprueba que la
   * musica suena y, si no, la reinicia (parando antes cualquier reproduccion previa).
   */
  verifyMusicSoon(): void {
    const check = () => this.audioService.ensureMusicPlaying();
    const idle = (window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number })
      .requestIdleCallback;

    if (idle) {
      idle(check, { timeout: 2500 });
    } else {
      setTimeout(check, 1200);
    }
  }
}
