/**
 * Jugadores que se ven en los minijuegos "de cliente" con hueco para 4 (cronometro, duelo): el propio jugador y los
 * que van justo antes que el en el orden de la partida (dando la vuelta si hace falta). Asi, con 5 jugadores, el
 * quinto ve al segundo, tercero y cuarto y nunca se queda solo. Con 4 o menos se ven todos.
 * Es solo decorativo: la clasificacion tiene en cuenta a todo el mundo.
 */
export function neighbourWindow(participantIds: string[], playerId: string, size = 4): string[] {
  const index = participantIds.indexOf(playerId);

  if (participantIds.length <= size || index < 0) {
    return participantIds.slice(0, size);
  }

  return Array.from({ length: size }, (_unused, offset) => participantIds[(index - (size - 1) + offset + participantIds.length) % participantIds.length]);
}
