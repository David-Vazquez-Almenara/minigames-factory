/** Lleva la pantalla de juego al principio cuando un minijuego cambia de fase, para que la nueva fase se vea entera. */
export function scrollGameToTop(element: Element | null | undefined): void {
  element?.closest('.game-view-shell')?.scrollTo({ top: 0, behavior: 'smooth' });
}
