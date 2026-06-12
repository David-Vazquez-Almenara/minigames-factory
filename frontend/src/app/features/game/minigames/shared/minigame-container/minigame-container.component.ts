import { NgComponentOutlet } from '@angular/common';
import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { MinigameService } from '../minigame.service';
import { MINIGAME_COMPONENTS } from '../minigame.registry';

type ContainerStage = 'intro' | 'explanation' | 'game';

@Component({
  selector: 'app-minigame-container',
  imports: [NgComponentOutlet],
  templateUrl: './minigame-container.component.html',
  styleUrl: './minigame-container.component.scss',
})
export class MinigameContainerComponent implements OnDestroy {
  private readonly minigameService = inject(MinigameService);
  private stageTimers: ReturnType<typeof setTimeout>[] = [];
  private progressTimer?: ReturnType<typeof setInterval>;
  private gameTimer?: ReturnType<typeof setInterval>;
  private activeDeadline: number | null = null;
  private loadedRoundKey = '';
  private preparedRoundKey = '';

  readonly match = this.minigameService.match;
  readonly isHost = this.minigameService.isHost;
  readonly stage = signal<ContainerStage>('intro');
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly timerProgress = signal(0);
  readonly remainingSeconds = signal(0);
  readonly specialRound = this.minigameService.currentRound;
  readonly activeComponent = computed(() => {
    const minigameId = this.specialRound()?.minigameId;
    return minigameId ? MINIGAME_COMPONENTS[minigameId] || null : null;
  });
  readonly title = computed(() => this.specialRound()?.title || 'Minijuego');
  readonly description = computed(() => this.specialRound()?.description || '');

  constructor() {
    effect(() => {
      const round = this.specialRound();
      const lobbyId = this.match()?.lobbyId || '';

      if (!round || !lobbyId) {
        return;
      }

      const nextKey = `${lobbyId}:${round.roundNumber}:${round.minigameId}`;

      if (nextKey !== this.loadedRoundKey) {
        this.loadedRoundKey = nextKey;
        this.startIntroSequence();
      }

      if (!this.isHost() || round.preparedByHost || this.preparedRoundKey === nextKey) {
        return;
      }

      const info = this.minigameService.buildHostGameInfo();

      if (!info) {
        return;
      }

      this.preparedRoundKey = nextKey;
      void this.minigameService.sendGameData(info).then((response) => {
        if (!response.ok) {
          this.preparedRoundKey = '';
          this.errorMessage.set(response.reason || 'No se pudo preparar el minijuego.');
        }
      });
    });

    effect(() => {
      const round = this.specialRound();

      if (round?.paintPhase === 'drawing') {
        this.syncGameTimer(round.paintEndsAt ?? null);
      } else if (round?.paintPhase === 'voting') {
        this.syncGameTimer(round.paintVoteEndsAt ?? null);
      } else if (round?.preparedByHost && !round?.paintPhase) {
        // Minijuego genérico: calcula el deadline UNA SOLA VEZ cuando
        // preparedByHost pasa a true. Si activeDeadline ya existe, el
        // timer está corriendo — no lo tocamos aunque el effect vuelva
        // a dispararse por cambios en progress/results.
        if (!this.activeDeadline) {
          const durationSeconds = this.minigameService.currentInfo()?.time ?? 60;
          this.syncGameTimer(Date.now() + durationSeconds * 1000);
        }
      } else if (!round?.preparedByHost) {
        // Aún preparando: sin timer.
        this.syncGameTimer(null);
      }
    });
  }

  ngOnDestroy(): void {
    this.clearTimers();
    this.clearGameTimer();
  }

  async skipMinigame(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || !this.isHost() || this.loading()) {
      return;
    }

    this.loading.set(true);
    const response = await this.minigameService.continueFromSpecialRound(lobbyId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo continuar despues del minijuego.');
    }
  }

  exitTest(): void {
    this.minigameService.clearMatchState();
  }

  private startIntroSequence(): void {
    this.clearTimers();
    this.stage.set('intro');
    this.timerProgress.set(0);

    this.stageTimers.push(
      setTimeout(() => this.stage.set('explanation'), 1750),
      setTimeout(() => this.startExplanationTimer(), 2500),
    );
  }

  private startExplanationTimer(): void {
    const startedAt = Date.now();
    const durationMs = 5000;

    this.progressTimer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
      this.timerProgress.set(progress);

      if (progress >= 1) {
        this.stage.set('game');
        this.clearProgressTimer();
      }
    }, 50);
  }

  private clearTimers(): void {
    for (const timer of this.stageTimers) {
      clearTimeout(timer);
    }

    this.stageTimers = [];
    this.clearProgressTimer();
  }

  private syncGameTimer(deadline: number | null): void {
    if (this.activeDeadline === deadline) {
      return;
    }

    this.clearGameTimer();
    this.activeDeadline = deadline;

    if (!deadline) {
      this.remainingSeconds.set(0);
      return;
    }

    const update = () => {
      const nextSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      this.remainingSeconds.set(nextSeconds);

      if (nextSeconds <= 0) {
        this.clearGameTimer();
      }
    };

    update();
    this.gameTimer = setInterval(update, 1000);
  }

  private clearGameTimer(): void {
    if (!this.gameTimer) {
      return;
    }

    clearInterval(this.gameTimer);
    this.gameTimer = undefined;
  }

  private clearProgressTimer(): void {
    if (!this.progressTimer) {
      return;
    }

    clearInterval(this.progressTimer);
    this.progressTimer = undefined;
  }
}