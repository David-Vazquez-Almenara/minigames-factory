// Reglas del Bomberman en el cliente: la explosion en cruz (con reaccion en cadena, igual que el servidor) y las
// colisiones de las bombas con su dueno. Todo trabaja con casillas enteras (indice = y * size + x).

/** 'W' pared exterior, 'C' columna, 'S' piedra, '.' suelo. */
export type BombermanCell = 'W' | 'C' | 'S' | '.';

export interface RuleBomb {
  id: number;
  owner: string;
  x: number;
  y: number;
  radius: number;
  explodeAt: number;
  /**
   * Excepcion de colision del dueno: true mientras el dueno siga en la casilla donde la puso. En cuanto entra en
   * otra casilla pasa a false y ya no vuelve a true (la bomba es solida tambien para el).
   */
  ownerInside: boolean;
}

export interface BlastResult {
  /** Bombas que explotan en el grupo (la que empieza y las alcanzadas en cadena). */
  detonated: number[];
  /** Casillas alcanzadas por las llamas (incluidas las de las bombas). */
  hit: number[];
  /** Piedras que se rompen. */
  stones: number[];
  /** Brazo de llama en cada casilla, para dibujarlo: centro, horizontal, vertical o punta (con su direccion). */
  shapes: Map<number, FlameShape>;
}

export type FlameShape = 'center' | 'h' | 'v' | 'end-up' | 'end-down' | 'end-left' | 'end-right';

const DIRECTIONS: Array<{ dx: number; dy: number; arm: 'h' | 'v'; end: FlameShape }> = [
  { dx: 0, dy: -1, arm: 'v', end: 'end-up' },
  { dx: 0, dy: 1, arm: 'v', end: 'end-down' },
  { dx: -1, dy: 0, arm: 'h', end: 'end-left' },
  { dx: 1, dy: 0, arm: 'h', end: 'end-right' },
];

/**
 * Explosion de un grupo de bombas sobre una foto del mapa: cruz de su radio en las 4 direcciones; las piedras se
 * rompen y paran la llama, las columnas y la pared la paran sin romperse, y cualquier bomba alcanzada explota en
 * el acto (una sola vez cada una). Al calcularse sobre la foto inicial, el orden no cambia el resultado.
 */
export function computeBlast(size: number, cells: ArrayLike<string>, bombs: ReadonlyArray<Pick<RuleBomb, 'id' | 'x' | 'y' | 'radius'>>, triggerIds: number[]): BlastResult {
  const byCell = new Map(bombs.map((bomb) => [bomb.y * size + bomb.x, bomb]));
  const byId = new Map(bombs.map((bomb) => [bomb.id, bomb]));
  const detonated = new Set<number>();
  const queue = [...triggerIds];
  const hit = new Set<number>();
  const stones = new Set<number>();
  const shapes = new Map<number, FlameShape>();
  // Un brazo horizontal y otro vertical en la misma casilla (o un centro) se dibujan como centro.
  const mark = (index: number, shape: FlameShape) => {
    const current = shapes.get(index);

    if (!current || shape === 'center') {
      shapes.set(index, shape);
    } else if (current !== shape && current !== 'center') {
      const isEnd = (value: FlameShape) => value.startsWith('end');
      const orientation = (value: FlameShape) => (value === 'h' || value === 'end-left' || value === 'end-right' ? 'h' : 'v');

      if (orientation(current) !== orientation(shape)) {
        shapes.set(index, 'center');
      } else if (isEnd(current) && !isEnd(shape)) {
        shapes.set(index, shape);
      }
    }
  };

  while (queue.length) {
    const id = queue.shift()!;

    if (detonated.has(id)) {
      continue;
    }

    const bomb = byId.get(id);

    if (!bomb) {
      continue;
    }

    detonated.add(id);
    const origin = bomb.y * size + bomb.x;
    hit.add(origin);
    mark(origin, 'center');

    for (const direction of DIRECTIONS) {
      for (let step = 1; step <= bomb.radius; step += 1) {
        const x = bomb.x + direction.dx * step;
        const y = bomb.y + direction.dy * step;

        if (x < 0 || y < 0 || x >= size || y >= size) {
          break;
        }

        const index = y * size + x;
        const cell = cells[index];

        if (cell === 'W' || cell === 'C') {
          break;
        }

        hit.add(index);
        const other = byCell.get(index);

        if (other && !detonated.has(other.id)) {
          queue.push(other.id);
        }

        const last = step === bomb.radius || cell === 'S';
        mark(index, last ? direction.end : direction.arm);

        if (cell === 'S') {
          stones.add(index);
          break;
        }
      }
    }
  }

  return {
    detonated: [...detonated],
    hit: [...hit].sort((first, second) => first - second),
    stones: [...stones].sort((first, second) => first - second),
    shapes,
  };
}

/**
 * ¿Puede el jugador entrar en la casilla (x, y)? Solo suelo, y nunca en una bomba salvo la propia mientras no ha
 * salido de ella (en la practica, entrar en una bomba nunca se puede: salir de la propia siempre). Las bombas
 * no empujan ni mueven a nadie: solo deciden si se puede entrar.
 */
export function canEnter(size: number, cells: ArrayLike<string>, bombs: ReadonlyArray<RuleBomb>, playerId: string, from: { x: number; y: number }, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= size || y >= size || Math.abs(x - from.x) + Math.abs(y - from.y) !== 1) {
    return false;
  }

  if (cells[y * size + x] !== '.') {
    return false;
  }

  const bomb = bombs.find((item) => item.x === x && item.y === y);
  // La excepcion del dueno solo vale para la casilla en la que esta (y por tanto nunca para volver a entrar).
  return !bomb || (bomb.owner === playerId && bomb.ownerInside && bomb.x === from.x && bomb.y === from.y);
}

/** El jugador ha entrado en otra casilla: sus bombas pasan a ser solidas para el (para siempre). */
export function leaveOwnBombs(bombs: RuleBomb[], playerId: string, x: number, y: number): void {
  for (const bomb of bombs) {
    if (bomb.owner === playerId && bomb.ownerInside && (bomb.x !== x || bomb.y !== y)) {
      bomb.ownerInside = false;
    }
  }
}

/** ¿Se puede poner una bomba aqui? Suelo, sin otra bomba y con capacidad libre. */
export function canPlaceBomb(size: number, cells: ArrayLike<string>, bombs: ReadonlyArray<RuleBomb>, playerId: string, capacity: number, x: number, y: number): boolean {
  return (
    x > 0 &&
    y > 0 &&
    x < size - 1 &&
    y < size - 1 &&
    cells[y * size + x] === '.' &&
    !bombs.some((bomb) => bomb.x === x && bomb.y === y) &&
    bombs.filter((bomb) => bomb.owner === playerId).length < capacity
  );
}
