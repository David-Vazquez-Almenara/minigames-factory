import { Component, HostListener, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { AudioService } from '../../../../core/services/audio.service';
import { GameTimerService } from '../../../../core/services/game-timer.service';
import { MatchService } from '../../../../core/services/match.service';
import { PlayerAvatarComponent } from '../../../../shared/components/player-avatar/player-avatar.component';
import { getPlayerColor } from '../../../../shared/player-colors';

type CheckState = 'waiting' | 'running' | 'cooldown' | 'finished';
type CheckResult = 'perfect' | 'good' | 'miss';

// Tras cada intento la ruleta vuelve a aparecer medio segundo despues.
const COOLDOWN_MS = 500;
// Una vuelta completa de la aguja: lenta al principio, rapida cerca de la meta.
const SLOW_REVOLUTION_MS = 1500;
const FAST_REVOLUTION_MS = 760;
const RING_RADIUS = 80;

interface SkillCheck {
  zoneStart: number;
  zoneSize: number;
  greatSize: number;
  revolutionMs: number;
}

/** Arco SVG del anillo entre dos angulos (0 grados = arriba, sentido horario). */
function arcPath(startDeg: number, endDeg: number, radius = RING_RADIUS): string {
  const point = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${(100 + radius * Math.cos(rad)).toFixed(2)} ${(100 + radius * Math.sin(rad)).toFixed(2)}`;
  };

  return `M ${point(startDeg)} A ${radius} ${radius} 0 ${endDeg - startDeg > 180 ? 1 : 0} 1 ${point(endDeg)}`;
}

@Component({
  selector: 'app-pogo',
  imports: [PlayerAvatarComponent],
  templateUrl: './pogo.component.html',
  styleUrl: './pogo.component.scss',
})
export class PogoComponent implements OnDestroy {
  private readonly matchService = inject(MatchService);
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private frameHandle?: number;
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  private checkStartedAt = 0;
  private lastSeenJump = 0;

  readonly currentPlayerId = this.matchService.currentPlayerId;
  readonly specialRound = computed(() => this.matchService.match()?.specialRound || null);
  readonly state = computed(() => this.specialRound()?.pogo || null);
  readonly isRacer = computed(() => Boolean(this.state()?.racers.some((racer) => racer.playerId === this.currentPlayerId)));
  readonly startTimer = this.timerService.countdown(() => this.state()?.raceStartsAt, { paused: () => this.matchService.hostPaused() });
  readonly raceTimer = this.timerService.countdown(() => (this.state()?.stage === 'racing' ? this.state()?.raceEndsAt : null), {
    paused: () => this.matchService.hostPaused(),
  });
  readonly raceStarted = computed(() => this.startTimer.remainingMs() <= 0);

  readonly checkState = signal<CheckState>('waiting');
  readonly check = signal<SkillCheck | null>(null);
  readonly needleAngle = signal(0);
  readonly lastResult = signal<CheckResult | null>(null);
  readonly streak = signal(0);
  readonly bestStreak = signal(0);
  readonly localProgress = signal(0);
  readonly localJumpSeq = signal(0);
  readonly localJumpKind = signal<CheckResult>('good');
  /** Secuencia de saltos de cada rival, para reiniciar su animacion al recibirlos. */
  readonly remoteJumps = signal(new Map<string, { seq: number; kind: CheckResult }>());

  readonly myRacer = computed(() => this.state()?.racers.find((racer) => racer.playerId === this.currentPlayerId) || null);
  readonly myProgress = computed(() => Math.max(this.localProgress(), this.myRacer()?.progress || 0));
  readonly myFinished = computed(() => Boolean(this.myRacer()?.finishedAt) || this.myProgress() >= (this.state()?.goal || Infinity));

  readonly racers = computed(() => {
    const state = this.state();

    if (!state) {
      return [];
    }

    const others = state.racers.filter((racer) => racer.playerId !== this.currentPlayerId);
    const ordered = [...others, ...state.racers.filter((racer) => racer.playerId === this.currentPlayerId)];

    // El jugador local siempre en el carril delantero (z-index maximo); los rivales detras y mas pequenos.
    return ordered.map((racer, index) => {
      const mine = racer.playerId === this.currentPlayerId;
      const lane = mine ? 0 : ordered.length - 1 - index;
      const progress = mine ? this.myProgress() : racer.progress;
      const remote = this.remoteJumps().get(racer.playerId);

      return {
        ...racer,
        mine,
        lane,
        progress,
        percent: Math.min(100, (progress / state.goal) * 100),
        name: this.matchService.playerName(racer.playerId),
        avatarUrl: this.matchService.playerAvatar(racer.playerId),
        color: getPlayerColor(this.matchService.playerColor(racer.playerId)).body,
        jumpSeq: mine ? this.localJumpSeq() : remote?.seq || 0,
        jumpKind: mine ? this.localJumpKind() : remote?.kind || 'good',
        finished: Boolean(racer.finishedAt) || progress >= state.goal,
      };
    });
  });

  readonly zonePaths = computed(() => {
    const check = this.check();

    if (!check) {
      return null;
    }

    return {
      great: arcPath(check.zoneStart, check.zoneStart + check.greatSize),
      good: arcPath(check.zoneStart + check.greatSize, check.zoneStart + check.zoneSize),
    };
  });

  readonly outcomeRows = computed(() =>
    (this.state()?.outcome?.ranking || []).map((entry) => ({
      ...entry,
      avatarUrl: this.matchService.playerAvatar(entry.playerId),
      color: this.matchService.playerColor(entry.playerId),
      mine: entry.playerId === this.currentPlayerId,
    })),
  );

  constructor() {
    effect(() => {
      // Arranca la primera ruleta en cuanto da comienzo la carrera.
      if (this.raceStarted() && this.state()?.stage === 'racing' && this.isRacer() && untracked(this.checkState) === 'waiting') {
        untracked(() => {
          this.audioService.playEffect('reveal');
          this.startCheck();
        });
      }
    });

    effect(() => {
      if (this.state()?.stage === 'results' || this.myFinished()) {
        untracked(() => this.stopChecks(this.myFinished() ? 'finished' : 'waiting'));
      }
    });

    effect(() => {
      const jump = this.matchService.lastPogoJump();

      if (!jump || jump.at === this.lastSeenJump || jump.playerId === this.currentPlayerId) {
        return;
      }

      this.lastSeenJump = jump.at;
      untracked(() =>
        this.remoteJumps.update((current) => {
          const next = new Map(current);
          next.set(jump.playerId, { seq: (current.get(jump.playerId)?.seq || 0) + 1, kind: jump.gain === 2 ? 'perfect' : jump.gain ? 'good' : 'miss' });
          return next;
        }),
      );
    });
  }

  ngOnDestroy(): void {
    this.stopChecks('waiting');
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.code !== 'Space' || event.repeat) {
      return;
    }

    event.preventDefault();
    this.press();
  }

  press(): void {
    if (this.checkState() !== 'running') {
      return;
    }

    // La aguja se detiene y la comprobacion se hace aqui mismo, sin esperar al servidor.
    this.evaluate(this.needleAngle());
  }

  checkpointTransform(): string {
    return `rotate(${this.needleAngle()} 100 100)`;
  }

  private startCheck(): void {
    const state = this.state();

    if (!state || state.stage !== 'racing' || this.myFinished()) {
      return;
    }

    const difficulty = Math.min(1, this.myProgress() / state.goal);
    const zoneSize = 58 - 20 * difficulty;
    this.check.set({
      zoneStart: 110 + Math.random() * (330 - 110 - zoneSize),
      zoneSize,
      greatSize: 15 - 5 * difficulty,
      revolutionMs: SLOW_REVOLUTION_MS - (SLOW_REVOLUTION_MS - FAST_REVOLUTION_MS) * difficulty,
    });
    this.needleAngle.set(0);
    this.checkState.set('running');
    this.checkStartedAt = performance.now();
    this.frameHandle = requestAnimationFrame(() => this.tick());
  }

  private tick(): void {
    const check = this.check();

    if (this.checkState() !== 'running' || !check) {
      return;
    }

    const angle = ((performance.now() - this.checkStartedAt) / check.revolutionMs) * 360;

    if (angle >= 360) {
      // Una vuelta entera sin pulsar cuenta como fallo, como en un "skill check".
      this.evaluate(360);
      return;
    }

    this.needleAngle.set(angle);
    this.frameHandle = requestAnimationFrame(() => this.tick());
  }

  private evaluate(angle: number): void {
    const check = this.check();
    const lobbyId = this.matchService.match()?.lobbyId;

    if (!check || !lobbyId) {
      return;
    }

    cancelAnimationFrame(this.frameHandle || 0);
    this.needleAngle.set(Math.min(angle, 359.9));
    const offset = angle - check.zoneStart;
    const result: CheckResult = offset >= 0 && offset <= check.greatSize ? 'perfect' : offset >= 0 && offset <= check.zoneSize ? 'good' : 'miss';
    const gain = result === 'perfect' ? 2 : result === 'good' ? 1 : 0;

    this.lastResult.set(result);
    this.localJumpKind.set(result);
    this.localJumpSeq.update((seq) => seq + 1);
    this.audioService.playEffect(result === 'perfect' ? 'reveal' : result === 'good' ? 'confirm' : 'spin-stop');

    if (gain) {
      this.localProgress.update((progress) => Math.min(this.state()?.goal || progress + gain, Math.max(progress, this.myRacer()?.progress || 0) + gain));
      this.streak.update((streak) => streak + 1);
      this.bestStreak.update((best) => Math.max(best, this.streak()));
    } else {
      this.streak.set(0);
    }

    // Solo se comunica el resultado; el servidor lo valida (ritmo y limites) y lo reparte al resto.
    void this.matchService.pogoJump(lobbyId, gain);

    this.checkState.set('cooldown');
    this.cooldownTimer = setTimeout(() => {
      if (this.checkState() === 'cooldown') {
        this.startCheck();
      }
    }, COOLDOWN_MS);
  }

  private stopChecks(nextState: CheckState): void {
    cancelAnimationFrame(this.frameHandle || 0);
    clearTimeout(this.cooldownTimer);
    this.checkState.set(nextState);
  }
}
