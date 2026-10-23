import { Component, computed, effect, input, signal } from '@angular/core';

/** Foto de perfil del jugador (URL elegida por el). Si no hay imagen o no carga, muestra su inicial. */
@Component({
  selector: 'app-player-avatar',
  template: `
    @if (avatarUrl() && !broken()) {
      <img
        [src]="avatarUrl()"
        [alt]="name() ? 'Foto de ' + name() : 'Foto de perfil'"
        [style.width.px]="size()"
        [style.height.px]="size()"
        referrerpolicy="no-referrer"
        draggable="false"
        (error)="broken.set(true)"
      />
    } @else {
      <span
        class="fallback"
        [style.width.px]="size()"
        [style.height.px]="size()"
        [style.font-size.px]="size() * 0.46"
        [style.background-color]="fallbackColor()"
        aria-hidden="true"
      >{{ initial() }}</span>
    }
  `,
  styles: `
    :host {
      display: inline-grid;
      flex-shrink: 0;
      place-items: center;
      line-height: 0;
    }

    img,
    .fallback {
      display: grid;
      place-items: center;
      object-fit: cover;
      background-color: #fff;
      border: 2px solid #000;
      border-radius: 20px;
    }

    .fallback {
      color: #000;
      font-weight: 1000;
      line-height: 1;
    }
  `,
})
export class PlayerAvatarComponent {
  readonly avatarUrl = input<string | null | undefined>('');
  readonly name = input('');
  readonly color = input('');
  readonly size = input(40);

  readonly broken = signal(false);
  readonly initial = computed(() => (this.name().trim().charAt(0) || '?').toUpperCase());
  // Tono pastel estable por jugador, a juego con la paleta de la app.
  readonly fallbackColor = computed(() => {
    const seed = [...(this.color() || this.name())].reduce((total, character) => total + character.charCodeAt(0) * 31, 7);
    return `hsl(${seed % 360}, 85%, 82%)`;
  });

  constructor() {
    // Si cambia la URL se vuelve a intentar cargarla.
    effect(() => {
      this.avatarUrl();
      this.broken.set(false);
    });
  }
}
