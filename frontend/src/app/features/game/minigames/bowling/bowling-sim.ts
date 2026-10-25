// Simulacion de la tirada propia en Bolos (vista cenital, metros). x = lateral (0 = centro de la pista), z = a lo
// largo de la pista (0 = linea de falta). Solo se simula la pista del jugador local; las demas se animan sin fisica.

export const LANE_HALF = 0.53;
export const BALL_RADIUS = 0.109;
export const PIN_RADIUS = 0.06;
export const HEAD_PIN_Z = 18.29;
const PIN_SPACING = 0.305;
const ROW_GAP = 0.264;
const BALL_SPEED = 8;
// La direccion maxima (medidor al tope) desvia la bola ~0,5 m al llegar a los bolos.
const MAX_ANGLE = 0.027;
// El efecto curva la bola en el ultimo tramo (gancho).
const HOOK_START_Z = 9;
const MAX_HOOK = 0.55;
const PIN_FRICTION = 2.6;
const STEP = 1 / 500;
const FRAME_MS = 1000 / 60;
const MAX_TIME = 4.2;

/** Posiciones de los 10 bolos (1 delante, 4 al fondo), de delante atras. */
export const PIN_SPOTS: Array<{ x: number; z: number }> = [0, 1, 2, 3].flatMap((row) =>
  Array.from({ length: row + 1 }, (_unused, index) => ({ x: (index - row / 2) * PIN_SPACING, z: HEAD_PIN_Z + row * ROW_GAP })),
);

export interface BowlingFrame {
  ball: { x: number; z: number; inGutter: boolean };
  pins: Array<{ x: number; z: number; down: boolean; dirX: number; dirZ: number }>;
}

export interface BowlingSimulation {
  frames: BowlingFrame[];
  frameMs: number;
  pins: number;
}

/** Tirada con la direccion y el efecto de los medidores (ambos entre -1 y 1). */
export function simulateBowling(direction: number, spin: number): BowlingSimulation {
  let x = 0;
  let z = 0;
  let vx = Math.sin(direction * MAX_ANGLE) * BALL_SPEED;
  let vz = Math.cos(direction * MAX_ANGLE) * BALL_SPEED;
  let inGutter = false;
  const pins = PIN_SPOTS.map((spot) => ({ x: spot.x, z: spot.z, vx: 0, vz: 0, down: false, dirX: 0, dirZ: 1 }));
  const frames: BowlingFrame[] = [];
  let nextFrame = 0;

  for (let time = 0; time < MAX_TIME; time += STEP) {
    // Gancho: a partir de media pista el efecto empuja la bola hacia un lado.
    if (!inGutter && z > HOOK_START_Z && z < HEAD_PIN_Z) {
      vx += -spin * MAX_HOOK * STEP;
    }

    x += vx * STEP;
    z += vz * STEP;

    // Al canal: sigue recta por el canal sin tocar los bolos.
    if (!inGutter && Math.abs(x) > LANE_HALF - BALL_RADIUS * 0.4 && z < HEAD_PIN_Z + 1) {
      inGutter = true;
      x = Math.sign(x) * (LANE_HALF + 0.12);
      vx = 0;
    }

    for (const pin of pins) {
      // Bola contra bolo: el bolo sale despedido y la bola apenas se desvia (pesa mucho mas).
      const dx = pin.x - x;
      const dz = pin.z - z;
      const distance = Math.hypot(dx, dz);

      if (!inGutter && distance < BALL_RADIUS + PIN_RADIUS && distance > 0) {
        const nx = dx / distance;
        const nz = dz / distance;
        const along = vx * nx + vz * nz;

        if (along > 0) {
          pin.vx += nx * along * 1.8;
          pin.vz += nz * along * 1.8;
          vx -= nx * along * 0.22;
          vz -= nz * along * 0.22;
          pin.down = true;
        }
      }

      pin.x += pin.vx * STEP;
      pin.z += pin.vz * STEP;
      const speed = Math.hypot(pin.vx, pin.vz);

      if (speed > 0) {
        pin.dirX = pin.vx / speed;
        pin.dirZ = pin.vz / speed;
        const slowed = Math.max(0, speed - PIN_FRICTION * STEP);
        pin.vx *= slowed / speed;
        pin.vz *= slowed / speed;
      }
    }

    // Bolo contra bolo: choque elastico (misma masa) con algo de perdida.
    for (let first = 0; first < pins.length; first += 1) {
      for (let second = first + 1; second < pins.length; second += 1) {
        const a = pins[first];
        const b = pins[second];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const distance = Math.hypot(dx, dz);

        if (distance < PIN_RADIUS * 2 && distance > 0) {
          const nx = dx / distance;
          const nz = dz / distance;
          const relative = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;

          if (relative > 0) {
            const impulse = relative * 0.92;
            a.vx -= impulse * nx;
            a.vz -= impulse * nz;
            b.vx += impulse * nx;
            b.vz += impulse * nz;
            a.down = true;
            b.down = true;
          }
        }
      }
    }

    if (time * 1000 >= nextFrame) {
      nextFrame += FRAME_MS;
      frames.push({ ball: { x, z, inGutter }, pins: pins.map((pin) => ({ x: pin.x, z: pin.z, down: pin.down, dirX: pin.dirX, dirZ: pin.dirZ })) });
    }
  }

  return { frames, frameMs: FRAME_MS, pins: pins.filter((pin) => pin.down).length };
}
