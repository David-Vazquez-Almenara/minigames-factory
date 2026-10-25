import type { CrossyRow } from '../../../../core/services/socket.service';

// Reglas comunes de Cruza la carretera (las usan la escena 3D y la deteccion de atropellos del cliente).
// Las columnas jugables van de -4 a 4; los coches recorren un circuito de `wrap` columnas centrado en 0 y los
// trenes cruzan de un lado a otro cada `periodMs`. Todo depende solo del reloj comun (ms desde el inicio).

export const CROSSY_HALF_COLS = 4;
export const TRAIN_SPEED = 30;
export const TRAIN_LENGTH = 12;
/** El tren arranca fuera de la pantalla, a esta distancia del centro. */
const TRAIN_START = 9;
/** Tiempo que la luz roja avisa antes de que llegue el tren. */
export const TRAIN_WARNING_MS = 1400;
/** Lo que tarda el tren en cruzar entero (la luz sigue encendida mientras pasa). */
export const TRAIN_PASS_MS = ((TRAIN_START * 2 + TRAIN_LENGTH) / TRAIN_SPEED) * 1000;
/** Media anchura de la gallina para los choques. */
const CHICKEN_HALF = 0.3;

const mod = (value: number, size: number) => ((value % size) + size) % size;

/** Centro (en columnas) de cada coche de una carretera en el instante `ms`. */
export function carPositions(row: Extract<CrossyRow, { type: 'road' }>, ms: number, wrap: number): number[] {
  const travelled = (row.dir * row.speed * ms) / 1000;
  return row.cars.map((start) => mod(start + travelled, wrap) - wrap / 2);
}

/** Fase del tren (ms desde que entro el ultimo) y si la luz roja esta encendida. */
export function trainPhase(row: Extract<CrossyRow, { type: 'rail' }>, ms: number): { phase: number; warning: boolean; passing: boolean } {
  const phase = mod(ms - row.offsetMs, row.periodMs);
  const passing = phase < TRAIN_PASS_MS;
  return { phase, passing, warning: passing || phase > row.periodMs - TRAIN_WARNING_MS };
}

/** Morro y cola del tren en columnas (null si no esta cruzando). */
export function trainSpan(row: Extract<CrossyRow, { type: 'rail' }>, ms: number): { head: number; tail: number } | null {
  const { phase, passing } = trainPhase(row, ms);

  if (!passing) {
    return null;
  }

  const head = -row.dir * TRAIN_START + (row.dir * TRAIN_SPEED * phase) / 1000;
  return { head, tail: head - row.dir * TRAIN_LENGTH };
}

/** Que atropella a una gallina en la casilla (row, col): un coche, un tren o nada. */
export function hitAt(rows: CrossyRow[], rowIndex: number, col: number, ms: number, wrap: number): 'car' | 'train' | null {
  const row = rows[rowIndex];

  if (row?.type === 'road') {
    return carPositions(row, ms, wrap).some((x) => Math.abs(x - col) < row.length / 2 + CHICKEN_HALF) ? 'car' : null;
  }

  if (row?.type === 'rail') {
    const span = trainSpan(row, ms);
    return span && col > Math.min(span.head, span.tail) - CHICKEN_HALF && col < Math.max(span.head, span.tail) + CHICKEN_HALF ? 'train' : null;
  }

  return null;
}

/** Si se puede saltar a esa casilla (dentro del ancho, sin arbol y sin bajar de la salida). */
export function canEnter(rows: CrossyRow[], rowIndex: number, col: number): boolean {
  const row = rows[rowIndex];

  if (!row || Math.abs(col) > CROSSY_HALF_COLS) {
    return false;
  }

  return row.type !== 'grass' || !row.trees.includes(col);
}

/** Columna de salida de cada jugador: repartidos por la fila de salida. */
export function startColumn(index: number, count: number): number {
  const spacing = Math.min(2, (CROSSY_HALF_COLS * 2) / Math.max(1, count - 1));
  return Math.max(-CROSSY_HALF_COLS, Math.min(CROSSY_HALF_COLS, Math.round((index - (count - 1) / 2) * spacing)));
}
