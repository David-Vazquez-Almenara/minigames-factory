import { Directive, ElementRef, inject, OnInit, OnDestroy } from '@angular/core';

@Directive({
  selector: '[appMinigameFullscreen]',
  standalone: true
})
export class MinigameFullscreenDirective implements OnInit, OnDestroy {
  private readonly el = inject(ElementRef);
  private resizeObserver?: ResizeObserver;

  ngOnInit(): void {
    // Desactivar el scroll de la página body por defecto
    document.body.classList.add('minigame-active-no-scroll');

    const container = this.el.nativeElement;
    const gameArea = container.querySelector('.game-area');

    if (gameArea) {
      // Usar ResizeObserver para recalculados automáticos cuando cambia el tamaño del contenido o ventana
      this.resizeObserver = new ResizeObserver(() => {
        this.checkOverflow(container, gameArea);
      });
      this.resizeObserver.observe(gameArea);
      this.resizeObserver.observe(document.body);
    }
  }

  private checkOverflow(container: HTMLElement, gameArea: HTMLElement): void {
    // Si la altura del contenido real es mayor que la pantalla, o si las dimensiones de la pantalla son pequeñas
    const overflow = (gameArea.scrollHeight + 160 > window.innerHeight) || 
                     (window.innerWidth <= 768) || 
                     (window.innerHeight <= 750);

    if (overflow) {
      container.classList.add('fullscreen-mode');
    } else {
      container.classList.remove('fullscreen-mode');
    }

    // Toggles de clases en padres fuera del componente
    const parentScreen = container.closest('.special-round-screen');
    const minigameContainer = container.closest('.minigame-container');

    if (parentScreen && minigameContainer) {
      if (overflow) {
        parentScreen.classList.add('minigame-fullscreen-active');
        minigameContainer.classList.add('minigame-fullscreen-active');
      } else {
        parentScreen.classList.remove('minigame-fullscreen-active');
        minigameContainer.classList.remove('minigame-fullscreen-active');
      }
    }
  }

  ngOnDestroy(): void {
    // Limpiar clase del body
    document.body.classList.remove('minigame-active-no-scroll');

    // Desconectar observador
    this.resizeObserver?.disconnect();

    // Limpiar clases auxiliares en padres
    const container = this.el.nativeElement;
    const parentScreen = container.closest('.special-round-screen');
    const minigameContainer = container.closest('.minigame-container');

    if (parentScreen) {
      parentScreen.classList.remove('minigame-fullscreen-active');
    }
    if (minigameContainer) {
      minigameContainer.classList.remove('minigame-fullscreen-active');
    }
  }
}
