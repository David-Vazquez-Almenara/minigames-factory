import { DestroyRef, Injectable, Signal, computed, effect, inject, signal, untracked } from '@angular/core';
import { SocketService } from './socket.service';

const TICK_MS = 200;

export interface GameCountdown {
  /** Segundos restantes redondeados hacia arriba, listos para mostrar. */
  readonly seconds: Signal<number>;
  /** Milisegundos restantes (congelados mientras la partida esta en pausa). */
  readonly remainingMs: Signal<number>;
  /** Progreso de 0 a 1 respecto a `totalMs`, si se indico. */
  readonly progress: Signal<number>;
}

export interface CountdownOptions {
  /** Duracion total de la fase, para calcular `progress`. */
  totalMs?: number | (() => number);
  /** Mientras devuelva true el contador se congela (p. ej. el host se ha desconectado). */
  paused?: () => boolean;
  /** Se llama una sola vez por cada plazo cuando llega a cero. */
  onExpire?: () => void;
  /** Los plazos locales usan Date.now(); los del servidor, el reloj sincronizado (por defecto). */
  clock?: 'server' | 'local';
}

/**
 * Temporizador comun de todos los minijuegos. Comparte un unico intervalo para toda la app, trabaja con
 * plazos absolutos (los mismos que envia el servidor) y se limpia solo al destruirse el componente.
 */
@Injectable({ providedIn: 'root' })
export class GameTimerService {
  private readonly socketService = inject(SocketService);
  private readonly tick = signal(Date.now());
  private subscribers = 0;
  private handle?: ReturnType<typeof setInterval>;

  now(clock: 'server' | 'local' = 'server'): number {
    return clock === 'server' ? this.socketService.serverNow() : Date.now();
  }

  /** Debe llamarse en contexto de inyeccion (inicializador de campo o constructor de un componente). */
  countdown(deadline: () => number | null | undefined, options: CountdownOptions = {}): GameCountdown {
    const destroyRef = inject(DestroyRef);
    const frozenRemaining = signal<number | null>(null);
    let expiredDeadline: number | null = null;

    this.retain();
    destroyRef.onDestroy(() => this.release());

    const liveRemaining = computed(() => {
      this.tick();
      const target = deadline();
      return target ? Math.max(0, target - this.now(options.clock)) : 0;
    });

    const remainingMs = computed(() => frozenRemaining() ?? liveRemaining());
    const seconds = computed(() => Math.ceil(remainingMs() / 1000));
    const progress = computed(() => {
      const totalMs = typeof options.totalMs === 'function' ? options.totalMs() : options.totalMs;
      return totalMs ? Math.min(1, Math.max(0, 1 - remainingMs() / totalMs)) : 0;
    });

    effect(() => {
      const paused = options.paused?.() ?? false;
      frozenRemaining.set(paused ? untracked(liveRemaining) : null);
    });

    effect(() => {
      const target = deadline();
      const remaining = remainingMs();

      if (!target || remaining > 0 || expiredDeadline === target || frozenRemaining() !== null) {
        return;
      }

      expiredDeadline = target;
      untracked(() => options.onExpire?.());
    });

    return { seconds, remainingMs, progress };
  }

  private retain(): void {
    this.subscribers += 1;

    if (!this.handle) {
      this.handle = setInterval(() => this.tick.set(Date.now()), TICK_MS);
    }
  }

  private release(): void {
    this.subscribers = Math.max(0, this.subscribers - 1);

    if (!this.subscribers && this.handle) {
      clearInterval(this.handle);
      this.handle = undefined;
    }
  }
}
