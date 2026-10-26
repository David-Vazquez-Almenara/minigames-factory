import { AfterViewInit, Component, ElementRef, HostListener, OnDestroy, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { TowerGame } from './tower-game';

@Component({
  selector: 'app-tower',
  imports: [PlayerAvatarComponent],
  templateUrl: './tower.component.html',
  styleUrl: './tower.component.scss',
})
export class TowerComponent implements AfterViewInit, OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly hostRef = viewChild.required<ElementRef<HTMLElement>>('playfield');
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private game?: TowerGame;
  private lastCountdownSecond = -1;
  private announcedFinal = false;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly state = computed(() => this.matchService.match()?.specialRound?.tower || null);
  /** Altura propia y si ya se ha caido: lo decide este cliente al instante. */
  readonly myLevel = signal(0);
  readonly lost = signal(false);
  readonly perfectSeq = signal(0);

  readonly startTimer = this.timerService.countdown(() => this.state()?.startsAt);
  readonly playTimer = this.timerService.countdown(() => (this.state()?.stage === 'playing' ? this.state()?.endsAt : null), {
    beep: true,
    paused: () => this.matchService.hostPaused(),
    totalMs: 45000,
    onExpire: () => this.timeUp(),
  });

  readonly isPlayer = computed(() => Boolean(this.matchService.match()?.specialRound?.participantIds.includes(this.currentPlayerId)));
  readonly started = computed(() => this.state()?.stage === 'playing' && this.startTimer.remainingMs() <= 0);
  readonly timeOver = computed(() => this.started() && this.playTimer.remainingMs() <= 0);
  readonly canDrop = computed(() => this.isPlayer() && this.started() && !this.timeOver() && !this.lost());

  /** Alturas de todos en directo (la propia, la local), de mayor a menor. */
  readonly board = computed(() =>
    (this.state()?.levels || [])
      .map((entry) => {
        const mine = entry.playerId === this.currentPlayerId;
        return {
          ...entry,
          level: mine ? Math.max(entry.level, this.myLevel()) : entry.level,
          lost: mine ? this.lost() || entry.lost : entry.lost,
          mine,
          name: this.matchService.playerName(entry.playerId),
          avatarUrl: this.matchService.playerAvatar(entry.playerId),
          colorId: this.matchService.playerColor(entry.playerId),
        };
      })
      .sort((first, second) => second.level - first.level),
  );

  readonly statusText = computed(() => {
    if (!this.isPlayer()) {
      return 'Mira cómo construyen los demás.';
    }

    if (!this.started()) {
      return 'Prepárate: suelta cada caja justo encima de la anterior.';
    }

    if (this.lost()) {
      return `¡Se ha caído! Has llegado a ${this.myLevel()} ${this.myLevel() === 1 ? 'caja' : 'cajas'}.`;
    }

    if (this.timeOver()) {
      return `¡Tiempo! Torre de ${this.myLevel()} ${this.myLevel() === 1 ? 'caja' : 'cajas'}.`;
    }

    return 'Pulsa ESPACIO o toca la pantalla para soltar la caja.';
  });

  readonly ranking = computed(() =>
    (this.state()?.outcome?.ranking || []).map((row) => ({
      ...row,
      avatarUrl: this.matchService.playerAvatar(row.playerId),
      colorId: this.matchService.playerColor(row.playerId),
      mine: row.playerId === this.currentPlayerId,
      pointsText: row.points < 0 ? `−${-row.points}` : `+${row.points}`,
    })),
  );

  constructor() {
    effect(() => {
      const seconds = this.startTimer.seconds();

      if (this.state()?.stage !== 'playing' || seconds === this.lastCountdownSecond) {
        return;
      }

      const first = this.lastCountdownSecond < 0;
      this.lastCountdownSecond = seconds;
      untracked(() => {
        if (seconds > 0 && seconds <= 3) {
          this.audioService.playEffect('tick');
        } else if (seconds === 0 && !first) {
          this.audioService.playEffect('reveal');
        }
      });
    });

    effect(() => {
      // Al acabar la cuenta atras empieza a moverse la caja (solo para quien juega).
      if (this.started() && this.isPlayer() && !this.timeOver()) {
        untracked(() => this.game?.start());
      }
    });

    effect(() => {
      const outcome = this.state()?.outcome;

      if (outcome && !this.announcedFinal) {
        this.announcedFinal = true;
        const mine = outcome.ranking.find((row) => row.playerId === this.currentPlayerId);

        if (mine?.position === 1) {
          untracked(() => this.audioService.playFileEffect('win'));
        }
      }
    });
  }

  ngAfterViewInit(): void {
    this.game = new TowerGame(this.canvasRef().nativeElement, this.hostRef().nativeElement, {
      onPlace: (level, perfect) => this.placed(level, perfect),
      onLose: (level) => this.fell(level),
    });

    if (this.started() && this.isPlayer() && !this.timeOver()) {
      this.game.start();
    }
  }

  ngOnDestroy(): void {
    this.game?.dispose();
    this.game = undefined;
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || event.repeat) {
      return;
    }

    event.preventDefault();
    this.drop();
  }

  drop(): void {
    if (this.canDrop()) {
      this.game?.drop();
    }
  }

  private placed(level: number, perfect: boolean): void {
    this.myLevel.set(level);
    this.audioService.playSfx(perfect ? 'acierto' : 'palanca', { rate: 1 + Math.min(0.6, level * 0.02) });

    if (perfect) {
      this.perfectSeq.update((seq) => seq + 1);
    }

    // Se avisa de cada caja para que el resto vea la altura en directo (sin esperar respuesta).
    void this.report({});
  }

  private fell(level: number): void {
    this.myLevel.set(level);
    this.lost.set(true);
    this.audioService.playSfx('aplastar', { gain: 0.6 });
    void this.report({ lost: true });
  }

  private timeUp(): void {
    if (!this.isPlayer() || this.lost()) {
      return;
    }

    this.game?.stop();
    void this.report({ finished: true });
  }

  private report(state: { lost?: boolean; finished?: boolean }) {
    const lobbyId = this.matchService.match()?.lobbyId;
    return lobbyId ? this.matchService.towerProgress(lobbyId, this.myLevel(), state) : Promise.resolve(null);
  }
}
