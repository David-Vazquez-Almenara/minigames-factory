import {
  Component,
  ElementRef,
  OnDestroy,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { AudioService } from '../../../core/services/audio.service';
import { GameTimerService } from '../../../core/services/game-timer.service';

export interface RouletteItem {
  key: string;
  label: string;
  image?: string;
  accent?: string;
}

interface StripGeometry {
  startX: number;
  landX: number;
  finalX: number;
  firstCenter: number;
  pitch: number;
  viewportCenter: number;
}

// Cuantas tarjetas como minimo recorre la tira antes de frenar, para que el giro se sienta largo.
const MIN_TRAVEL_CARDS = 30;

/**
 * Tira horizontal estilo "caja" de Counter-Strike. El ganador llega decidido desde fuera (servidor) y la
 * posicion final se calcula midiendo la tarjeta ganadora real en el DOM, de modo que lo que queda bajo el
 * marcador central es siempre exactamente `items[winnerIndex]`, sea cual sea el tamano de la pantalla.
 */
@Component({
  selector: 'app-roulette-strip',
  templateUrl: './roulette-strip.component.html',
  styleUrl: './roulette-strip.component.scss',
})
export class RouletteStripComponent implements OnDestroy {
  private readonly audioService = inject(AudioService);
  private readonly timerService = inject(GameTimerService);
  private readonly viewportRef = viewChild.required<ElementRef<HTMLElement>>('viewport');
  private readonly trackRef = viewChild.required<ElementRef<HTMLElement>>('track');
  private animation?: Animation;
  private startTimer?: ReturnType<typeof setTimeout>;
  private frameHandle?: number;
  private resizeObserver?: ResizeObserver;
  private lastCenteredIndex = -1;
  private landedKey = '';

  readonly items = input.required<RouletteItem[]>();
  readonly winnerIndex = input.required<number>();
  /** Instante de inicio del giro (reloj del servidor salvo que `clock` sea 'local'). Null = tira en reposo. */
  readonly spinStartsAt = input<number | null>(null);
  readonly spinDurationMs = input(6000);
  /** Desvio (fraccion del ancho de tarjeta) donde frena antes de recolocarse en el centro exacto. */
  readonly landingOffset = input(0);
  readonly variant = input<'card' | 'number'>('card');
  readonly clock = input<'server' | 'local'>('server');
  readonly muted = input(false);
  readonly landed = output<string>();

  readonly hasLanded = signal(false);
  readonly brokenImages = signal(new Set<string>());
  readonly cycles = computed(() => Math.max(3, Math.ceil(MIN_TRAVEL_CARDS / Math.max(1, this.items().length))));
  readonly winnerStripIndex = computed(() => this.items().length * this.cycles() + this.winnerIndex());
  readonly strip = computed(() => {
    const items = this.items();
    const total = items.length * (this.cycles() + 2);

    return Array.from({ length: total }, (_unused, stripIndex) => ({
      ...items[stripIndex % items.length],
      stripIndex,
    }));
  });
  private readonly spinKey = computed(
    () => `${this.spinStartsAt() ?? 'idle'}:${this.winnerIndex()}:${this.items().map((item) => item.key).join(',')}`,
  );

  constructor() {
    afterRenderEffect(() => {
      this.spinKey();
      untracked(() => this.setupSpin());
    });
  }

  ngOnDestroy(): void {
    this.stopAnimation();
    this.resizeObserver?.disconnect();
  }

  markImageBroken(key: string): void {
    this.brokenImages.update((current) => new Set(current).add(key));
  }

  private setupSpin(): void {
    this.stopAnimation();
    this.observeResize();
    const geometry = this.measure();
    const startsAt = this.spinStartsAt();
    const duration = this.spinDurationMs();

    if (!geometry) {
      return;
    }

    if (startsAt === null) {
      this.hasLanded.set(false);
      this.setTranslate(geometry.startX);
      return;
    }

    const elapsed = this.timerService.now(this.clock()) - startsAt;

    if (elapsed >= duration) {
      this.setTranslate(geometry.finalX);
      this.finishLanding(false);
      return;
    }

    this.hasLanded.set(false);

    if (elapsed < 0) {
      this.setTranslate(geometry.startX);
      this.startTimer = setTimeout(() => this.setupSpin(), -elapsed);
      return;
    }

    const track = this.trackRef().nativeElement;
    this.animation = track.animate(
      [
        { transform: `translate3d(${geometry.startX}px, 0, 0)`, easing: 'cubic-bezier(0.05, 0.6, 0.12, 1)' },
        { transform: `translate3d(${geometry.landX}px, 0, 0)`, offset: 0.9, easing: 'cubic-bezier(0.45, 0, 0.25, 1)' },
        { transform: `translate3d(${geometry.finalX}px, 0, 0)` },
      ],
      { duration, fill: 'forwards' },
    );
    this.animation.currentTime = elapsed;

    if (elapsed < 250) {
      this.play('spin-start');
    }

    this.animation.onfinish = () => {
      this.setTranslate(geometry.finalX);
      this.animation?.cancel();
      this.animation = undefined;
      this.finishLanding(true);
    };
    this.watchTicks(geometry);
  }

  private measure(): StripGeometry | null {
    const viewport = this.viewportRef().nativeElement;
    const cards = this.trackRef().nativeElement.children as HTMLCollectionOf<HTMLElement>;
    const winnerCard = cards[this.winnerStripIndex()];

    if (cards.length < 2 || !winnerCard || !viewport.clientWidth) {
      return null;
    }

    const centerOf = (card: HTMLElement) => card.offsetLeft + card.offsetWidth / 2;
    const viewportCenter = viewport.clientWidth / 2;
    const startCard = cards[Math.min(this.items().length, cards.length - 1)];
    const finalX = viewportCenter - centerOf(winnerCard);

    return {
      startX: viewportCenter - centerOf(startCard),
      landX: finalX - this.landingOffset() * winnerCard.offsetWidth,
      finalX,
      firstCenter: centerOf(cards[0]),
      pitch: cards[1].offsetLeft - cards[0].offsetLeft,
      viewportCenter,
    };
  }

  private watchTicks(geometry: StripGeometry): void {
    const track = this.trackRef().nativeElement;

    const step = () => {
      if (!this.animation) {
        return;
      }

      const translateX = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
      const centeredIndex = Math.round((geometry.viewportCenter - translateX - geometry.firstCenter) / geometry.pitch);

      if (centeredIndex !== this.lastCenteredIndex) {
        this.lastCenteredIndex = centeredIndex;
        this.play('tick');
      }

      this.frameHandle = requestAnimationFrame(step);
    };

    this.frameHandle = requestAnimationFrame(step);
  }

  private finishLanding(withSound: boolean): void {
    this.hasLanded.set(true);
    const key = this.spinKey();

    if (this.landedKey === key) {
      return;
    }

    this.landedKey = key;

    if (withSound) {
      this.play('spin-stop');
    }

    this.landed.emit(this.items()[this.winnerIndex()]?.key || '');
  }

  private observeResize(): void {
    if (this.resizeObserver) {
      return;
    }

    let lastWidth = this.viewportRef().nativeElement.clientWidth;
    this.resizeObserver = new ResizeObserver(() => {
      const width = this.viewportRef().nativeElement.clientWidth;

      if (width === lastWidth) {
        return;
      }

      // Al cambiar el tamano se recalcula la geometria y se retoma el giro en el mismo instante.
      lastWidth = width;
      this.setupSpin();
    });
    this.resizeObserver.observe(this.viewportRef().nativeElement);
  }

  private setTranslate(x: number): void {
    this.trackRef().nativeElement.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  private play(effect: 'tick' | 'spin-start' | 'spin-stop'): void {
    if (!this.muted()) {
      this.audioService.playEffect(effect);
    }
  }

  private stopAnimation(): void {
    clearTimeout(this.startTimer);

    if (this.frameHandle) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = undefined;
    }

    if (this.animation) {
      this.animation.onfinish = null;
      this.animation.cancel();
      this.animation = undefined;
    }
  }
}
