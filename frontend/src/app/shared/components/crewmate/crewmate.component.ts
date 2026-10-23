import { Component, computed, input } from '@angular/core';
import { getPlayerColor } from '../../player-colors';

@Component({
  selector: 'app-crewmate',
  template: `
    <svg
      viewBox="0 0 64 72"
      [attr.width]="size()"
      [attr.height]="size() * 1.125"
      [class.ghost]="ghost()"
      role="img"
      [attr.aria-label]="label() || 'Tripulante ' + palette().name"
    >
      <path class="backpack" d="M8 28c0-4 3-7 7-7h4v32h-4c-4 0-7-3-7-7z" [attr.fill]="palette().shadow" />
      <path
        class="body"
        d="M18 18c0-10 6-16 15-16s16 6 16 18v34c0 4-2 7-6 7h-4c-3 0-4-2-4-5v-4h-6v4c0 3-1 5-4 5h-3c-3 0-4-2-4-6z"
        [attr.fill]="palette().body"
      />
      <path
        class="body-shade"
        d="M49 34v20c0 4-2 7-6 7h-4c-3 0-4-2-4-5v-4h-6v-2c9 0 18-6 20-16z"
        [attr.fill]="palette().shadow"
        opacity="0.55"
      />
      <path class="visor" d="M30 16h17c5 0 7 3 7 7s-2 7-7 7H30c-4 0-6-3-6-7s2-7 6-7z" fill="#93c9da" />
      <path d="M33 18h12c3 0 5 1.5 5 3.5H33c-2 0-3-1-3-1.8s1-1.7 3-1.7z" fill="#e3f4f8" opacity="0.95" />
      <path
        class="outline"
        d="M8 28c0-4 3-7 7-7h3c1-12 7-19 15-19s16 6 16 18v34c0 4-2 7-6 7h-4c-3 0-4-2-4-5v-4h-6v4c0 3-1 5-4 5h-3c-3 0-4-2-4-6v-1h-1c-4 0-7-3-7-7z"
        fill="none"
        stroke="#000"
        stroke-width="3"
        stroke-linejoin="round"
      />
      <path d="M30 16h17c5 0 7 3 7 7s-2 7-7 7H30c-4 0-6-3-6-7s2-7 6-7z" fill="none" stroke="#000" stroke-width="3" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-grid;
      flex-shrink: 0;
      place-items: center;
      line-height: 0;
    }

    svg {
      overflow: visible;
    }

    svg.ghost {
      opacity: 0.45;
      filter: grayscale(0.6);
    }
  `,
})
export class CrewmateComponent {
  readonly color = input<string>('gray');
  readonly size = input(40);
  readonly ghost = input(false);
  readonly label = input('');

  readonly palette = computed(() => getPlayerColor(this.color()));
}
