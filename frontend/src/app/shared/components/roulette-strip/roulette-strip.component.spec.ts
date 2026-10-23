import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouletteItem, RouletteStripComponent } from './roulette-strip.component';

const NUMBERS: RouletteItem[] = Array.from({ length: 10 }, (_unused, index) => ({ key: `n${index + 1}`, label: String(index + 1) }));

function cardUnderMarker(host: HTMLElement): HTMLElement | undefined {
  const marker = host.querySelector('.marker')!.getBoundingClientRect();
  const markerX = marker.left + marker.width / 2;

  return Array.from(host.querySelectorAll<HTMLElement>('.roulette-card')).find((card) => {
    const rect = card.getBoundingClientRect();
    return rect.left <= markerX && rect.right >= markerX;
  });
}

function centerOffset(host: HTMLElement, card: HTMLElement): number {
  const marker = host.querySelector('.marker')!.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  return Math.abs(rect.left + rect.width / 2 - (marker.left + marker.width / 2));
}

describe('RouletteStripComponent', () => {
  let fixture: ComponentFixture<RouletteStripComponent>;
  let host: HTMLElement;

  async function render(width: number, winnerIndex: number, spinStartsAt: number | null, durationMs = 6000): Promise<void> {
    host.style.width = `${width}px`;
    fixture.componentRef.setInput('items', NUMBERS);
    fixture.componentRef.setInput('variant', 'number');
    fixture.componentRef.setInput('clock', 'local');
    fixture.componentRef.setInput('muted', true);
    fixture.componentRef.setInput('winnerIndex', winnerIndex);
    fixture.componentRef.setInput('landingOffset', 0.25);
    fixture.componentRef.setInput('spinDurationMs', durationMs);
    fixture.componentRef.setInput('spinStartsAt', spinStartsAt);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [RouletteStripComponent] }).compileComponents();
    fixture = TestBed.createComponent(RouletteStripComponent);
    host = fixture.nativeElement as HTMLElement;
    document.body.appendChild(host);
  });

  afterEach(() => host.remove());

  for (const width of [360, 768, 1280]) {
    it(`detiene la tira exactamente sobre cada numero del 1 al 10 (ancho ${width}px)`, async () => {
      for (let winnerIndex = 0; winnerIndex < 10; winnerIndex += 1) {
        // Un giro ya terminado coloca la tira directamente en su posicion final.
        await render(width, winnerIndex, Date.now() - 10000);
        const card = cardUnderMarker(host)!;

        expect(card.dataset['rouletteKey']).toBe(`n${winnerIndex + 1}`);
        expect(card.dataset['winner']).toBe('true');
        expect(centerOffset(host, card)).toBeLessThan(1);
      }
    });
  }

  it('emite el ganador real al terminar una animacion completa', async () => {
    const landed: string[] = [];
    fixture.componentInstance.landed.subscribe((key) => landed.push(key));
    await render(800, 6, Date.now(), 400);
    await new Promise((resolve) => setTimeout(resolve, 700));

    const card = cardUnderMarker(host)!;
    expect(landed).toEqual(['n7']);
    expect(card.dataset['rouletteKey']).toBe('n7');
    expect(centerOffset(host, card)).toBeLessThan(1);
  });

  it('recalcula el centrado si cambia el tamano de la pantalla', async () => {
    await render(1280, 3, Date.now() - 10000);
    host.style.width = '420px';
    await new Promise((resolve) => setTimeout(resolve, 150));

    const card = cardUnderMarker(host)!;
    expect(card.dataset['rouletteKey']).toBe('n4');
    expect(centerOffset(host, card)).toBeLessThan(1);
  });
});
