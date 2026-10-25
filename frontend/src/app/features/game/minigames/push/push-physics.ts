// Fisica de Empujar: discos sobre una pista de hielo circular (radio ARENA_RADIUS, centro en 0,0).
// Todos los clientes simulan lo mismo a partir de las mismas posiciones y los mismos impulsos (vx, vy). Para que el
// resultado sea identico en cualquier navegador la simulacion solo usa sumas, productos, divisiones y raices
// cuadradas (operaciones exactas en IEEE 754): nada de exp, sin o cos dentro del bucle.

export const ARENA_RADIUS = 10;
export const DISC_RADIUS = 1.1;
/** Velocidad inicial con la fuerza maxima (unidades por segundo). */
export const MAX_SPEED = 16;
export const STEP = 1 / 120;
const FRICTION = 0.986;
const DECEL = 0.5 * STEP;
const RESTITUTION = 0.92;
const STOP_SPEED = 0.02;
const MAX_STEPS = 120 * 12;

export interface PushBody {
  playerId: string;
  x: number;
  y: number;
}

export interface PushImpulse {
  playerId: string;
  vx: number;
  vy: number;
}

export interface PushResult {
  /** Una foto cada 2 pasos (60 por segundo) para animar. */
  frames: Array<Float64Array>;
  frameEvery: number;
  ids: string[];
  /** Posicion final de los que siguen en pie. */
  finals: PushBody[];
  /** Quien cae (disco entero fuera de la pista), en que paso y con que velocidad salia. */
  falls: Array<{ playerId: string; step: number; x: number; y: number; vx: number; vy: number }>;
  /** Choques entre discos (paso y fuerza) para los sonidos. */
  hits: Array<{ step: number; strength: number }>;
  steps: number;
}

/** Redondeo de los impulsos que viajan por la red (todos simulan con el valor redondeado). */
export const roundImpulse = (value: number) => Math.round(value * 10000) / 10000;

/** Disco completamente fuera de la pista. */
export function isOut(x: number, y: number): boolean {
  const limit = ARENA_RADIUS + DISC_RADIUS;
  return x * x + y * y > limit * limit;
}

export function simulatePush(bodies: PushBody[], impulses: PushImpulse[]): PushResult {
  const count = bodies.length;
  const ids = bodies.map((body) => body.playerId);
  const px = bodies.map((body) => body.x);
  const py = bodies.map((body) => body.y);
  const vx = bodies.map((body) => impulses.find((impulse) => impulse.playerId === body.playerId)?.vx ?? 0);
  const vy = bodies.map((body) => impulses.find((impulse) => impulse.playerId === body.playerId)?.vy ?? 0);
  const active = bodies.map(() => true);
  const frames: Float64Array[] = [];
  const falls: PushResult['falls'] = [];
  const hits: PushResult['hits'] = [];
  const minDistance = DISC_RADIUS * 2;
  const snapshot = () => {
    const frame = new Float64Array(count * 2);
    for (let index = 0; index < count; index += 1) {
      frame[index * 2] = px[index];
      frame[index * 2 + 1] = py[index];
    }
    frames.push(frame);
  };

  snapshot();
  let step = 0;

  for (; step < MAX_STEPS; step += 1) {
    let moving = false;

    for (let index = 0; index < count; index += 1) {
      if (!active[index]) continue;
      px[index] += vx[index] * STEP;
      py[index] += vy[index] * STEP;
    }

    // Choques entre discos (misma masa): impulso a lo largo de la normal y se separan si se solapan.
    for (let first = 0; first < count; first += 1) {
      if (!active[first]) continue;

      for (let second = first + 1; second < count; second += 1) {
        if (!active[second]) continue;
        const dx = px[second] - px[first];
        const dy = py[second] - py[first];
        const distanceSq = dx * dx + dy * dy;

        if (distanceSq >= minDistance * minDistance || distanceSq === 0) continue;

        const distance = Math.sqrt(distanceSq);
        const nx = dx / distance;
        const ny = dy / distance;
        const approach = (vx[first] - vx[second]) * nx + (vy[first] - vy[second]) * ny;

        if (approach > 0) {
          const impulse = ((1 + RESTITUTION) * approach) / 2;
          vx[first] -= impulse * nx;
          vy[first] -= impulse * ny;
          vx[second] += impulse * nx;
          vy[second] += impulse * ny;
          hits.push({ step, strength: approach });
        }

        const push = (minDistance - distance) / 2;
        px[first] -= nx * push;
        py[first] -= ny * push;
        px[second] += nx * push;
        py[second] += ny * push;
      }
    }

    for (let index = 0; index < count; index += 1) {
      if (!active[index]) continue;

      // Rozamiento del hielo: proporcional y una pequena frenada constante para que acaben parando.
      vx[index] *= FRICTION;
      vy[index] *= FRICTION;
      const speedSq = vx[index] * vx[index] + vy[index] * vy[index];

      if (speedSq > 0) {
        const speed = Math.sqrt(speedSq);
        const slowed = speed > DECEL ? (speed - DECEL) / speed : 0;
        vx[index] *= slowed;
        vy[index] *= slowed;
      }

      if (isOut(px[index], py[index])) {
        active[index] = false;
        falls.push({ playerId: ids[index], step, x: px[index], y: py[index], vx: vx[index], vy: vy[index] });
        continue;
      }

      if (vx[index] * vx[index] + vy[index] * vy[index] > STOP_SPEED * STOP_SPEED) {
        moving = true;
      } else {
        vx[index] = 0;
        vy[index] = 0;
      }
    }

    if (step % 2 === 1) snapshot();

    if (!moving) {
      step += 1;
      break;
    }
  }

  snapshot();
  return {
    frames,
    frameEvery: 2,
    ids,
    finals: bodies
      .map((body, index) => ({ playerId: body.playerId, x: px[index], y: py[index] }))
      .filter((_body, index) => active[index]),
    falls,
    hits,
    steps: step,
  };
}

/** Donde acabaria un disco con ese impulso si no chocara con nadie (el circulito de la vista previa). */
export function predictStop(body: PushBody, vx: number, vy: number): { x: number; y: number } {
  const result = simulatePush([body], [{ playerId: body.playerId, vx, vy }]);
  const last = result.frames[result.frames.length - 1];
  const fall = result.falls[0];
  // Si se sale, se marca el sitio por donde cae.
  return fall ? { x: fall.x, y: fall.y } : { x: last[0], y: last[1] };
}
