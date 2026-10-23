import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { GameTimerService } from '../../../core/services/game-timer.service';
import { MatchService } from '../../../core/services/match.service';
import { BalloonComponent } from '../minigames/balloon/balloon.component';
import { BarrelsComponent } from '../minigames/barrels/barrels.component';
import { BlackjackComponent } from '../minigames/blackjack/blackjack.component';
import { CarsComponent } from '../minigames/cars/cars.component';
import { CupsComponent } from '../minigames/cups/cups.component';
import { ImpostorComponent } from '../minigames/impostor/impostor.component';
import { MathOperationsComponent } from '../minigames/math-operations/math-operations.component';
import { PaintComponent } from '../minigames/paint/paint.component';
import { PinturilloComponent } from '../minigames/pinturillo/pinturillo.component';
import { PogoComponent } from '../minigames/pogo/pogo.component';
import { TenButComponent } from '../minigames/ten-but/ten-but.component';

type SpecialStage = 'intro' | 'explanation' | 'game';

// Minijuegos que se juegan a pantalla completa (escena 3D que ocupa toda la ventana).
const FULLSCREEN_MINIGAMES = new Set(['blackjack', 'barrels', 'balloon', 'cups', 'cars']);
// Respaldo si el servidor no enviara los tiempos de la intro.
const INTRO_MS = 1750;
const EXPLANATION_MS = 5000;

@Component({
  selector: 'app-special-round',
  imports: [
    BalloonComponent,
    BarrelsComponent,
    BlackjackComponent,
    CarsComponent,
    CupsComponent,
    ImpostorComponent,
    MathOperationsComponent,
    PaintComponent,
    PinturilloComponent,
    PogoComponent,
    TenButComponent,
  ],
  templateUrl: './special-round.component.html',
  styleUrl: './special-round.component.scss',
})
export class SpecialRoundComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly timerService = inject(GameTimerService);
  private stageTimers: Array<ReturnType<typeof setTimeout>> = [];
  private loadedRoundKey = '';
  private readonly explanationWindow = signal<{ start: number; end: number } | null>(null);

  readonly match = this.matchService.match;
  readonly isHost = this.matchService.isHost;
  readonly stage = signal<SpecialStage>('intro');
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly specialRound = computed(() => this.match()?.specialRound || null);
  readonly isFullscreen = computed(() => FULLSCREEN_MINIGAMES.has(this.specialRound()?.minigameId || ''));
  // La explicacion dura lo que diga el servidor: mas tiempo cuanto mas larga es (minimo el de siempre).
  readonly explanationTimer = this.timerService.countdown(() => this.explanationWindow()?.end, {
    totalMs: () => {
      const window = this.explanationWindow();
      return window ? window.end - window.start : EXPLANATION_MS;
    },
  });

  /** Cuenta atras hasta que el marcador se abre solo (si el host no pulsa antes "Ver marcador"). */
  readonly autoScoreboard = this.timerService.countdown(() => this.specialRound()?.autoScoreboardAt, {
    paused: () => this.matchService.hostPaused(),
  });

  constructor() {
    effect(() => {
      const round = this.specialRound();
      const lobbyId = this.match()?.lobbyId || '';

      if (!round || !lobbyId) {
        return;
      }

      const nextKey = `${lobbyId}:${round.roundNumber}:${round.minigameId}`;

      if (nextKey === this.loadedRoundKey) {
        return;
      }

      this.loadedRoundKey = nextKey;
      this.startIntroSequence(round.titleEndsAt, round.introEndsAt);
    });
  }

  ngOnDestroy(): void {
    this.clearStageTimers();
  }

  async continueMinigame(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || !this.isHost() || this.loading()) {
      return;
    }

    this.loading.set(true);
    const response = await this.matchService.continueFromSpecialRound(lobbyId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo continuar despues del minijuego.');
    }
  }

  /** Titulo "Minijuego" -> explicacion -> juego, con los tiempos del servidor (igual para todos y al recargar). */
  private startIntroSequence(titleEndsAt?: number, introEndsAt?: number): void {
    this.clearStageTimers();
    const now = this.matchService.serverNow();
    const titleEnd = titleEndsAt ?? now + INTRO_MS;
    const introEnd = introEndsAt ?? titleEnd + EXPLANATION_MS;
    this.explanationWindow.set({ start: titleEnd, end: introEnd });

    if (now >= introEnd) {
      this.stage.set('game');
      return;
    }

    this.stage.set(now >= titleEnd ? 'explanation' : 'intro');
    this.stageTimers = [
      setTimeout(() => this.stage.set('explanation'), Math.max(0, titleEnd - now)),
      setTimeout(() => this.stage.set('game'), Math.max(0, introEnd - now)),
    ];
  }

  private clearStageTimers(): void {
    this.stageTimers.forEach((timer) => clearTimeout(timer));
    this.stageTimers = [];
  }
}
