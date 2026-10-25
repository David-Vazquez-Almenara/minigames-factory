import { Injectable, effect, inject, signal } from '@angular/core';
import { AudioService, MusicTrack } from './audio.service';
import { SocketService } from './socket.service';

/**
 * Decide que musica de fondo suena segun donde este el jugador:
 * menu principal y lobby -> musica de sala de espera (la misma, sin cortes al entrar al lobby);
 * ruleta y explicacion del minijuego -> musica de ruleta; el minijuego en si -> musica de minijuego;
 * marcador y podio -> musica de marcador.
 */
@Injectable({ providedIn: 'root' })
export class MusicDirectorService {
  private readonly audioService = inject(AudioService);
  private readonly socketService = inject(SocketService);
  /** Se incrementa cuando termina la explicacion de un minijuego, para volver a decidir la pista. */
  private readonly introTick = signal(0);
  private introTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      this.introTick();
      const match = this.socketService.match();
      let track: MusicTrack = 'lobby';
      clearTimeout(this.introTimer);

      if (match) {
        if (match.phase === 'scoreboard' || match.phase === 'finished') {
          track = 'scoreboard';
        } else if (match.phase === 'special-round') {
          // La explicacion sigue con la musica de la ruleta; al acabar entra la del minijuego (la suya propia si
          // hay un archivo en assets/audio/sonido-minijuegos; si no, la de minijuego normal).
          const remaining = (match.specialRound?.introEndsAt || 0) - this.socketService.serverNow();
          track = remaining > 0 ? 'roulette' : `minigame:${match.specialRound?.minigameId || ''}`;

          if (remaining > 0) {
            this.introTimer = setTimeout(() => this.introTick.update((tick) => tick + 1), remaining + 30);
          }
        } else {
          track = 'roulette';
        }
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
