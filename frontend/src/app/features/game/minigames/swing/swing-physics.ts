// Fisica del "Salto con cuerda". Es un espejo exacto de la del servidor (backend/src/server.js, swingJump y
// swingAngleAt): el cliente que se suelta anima su salto al instante con el mismo resultado que calculara el servidor.

export const SWING_PIVOT = { x: 1, y: 13.2 };
export const SWING_ROPE = 4.5;
export const SWING_SPEED = 14;
export const SWING_GRAVITY = 9.8;
/** La cuerda sube 15 grados por encima de la horizontal a cada lado (de -15 a 195 contando desde atras). */
export const SWING_AMPLITUDE = 105;

/** Angulo de la cuerda (grados; 0 = vertical, +90 = horizontal hacia delante) y sentido del balanceo. */
export function swingAngleAt(elapsedMs: number, periodMs: number): { angle: number; dir: 1 | -1 } {
  const phase = (2 * Math.PI * elapsedMs) / periodMs;
  return { angle: SWING_AMPLITUDE * Math.sin(phase), dir: Math.cos(phase) >= 0 ? 1 : -1 };
}

export interface SwingLaunch {
  x0: number;
  y0: number;
  vx: number;
  vy: number;
  distance: number;
  flightMs: number;
}

/** Salto al soltarse con el angulo y sentido dados (todos con la misma velocidad). Distancia desde el tronco. */
export function swingLaunch(angleDeg: number, dir: 1 | -1): SwingLaunch {
  const angle = (Math.max(-SWING_AMPLITUDE, Math.min(SWING_AMPLITUDE, angleDeg)) * Math.PI) / 180;
  const x0 = SWING_PIVOT.x + SWING_ROPE * Math.sin(angle);
  const y0 = SWING_PIVOT.y - SWING_ROPE * Math.cos(angle);
  const vx = dir * SWING_SPEED * Math.cos(angle);
  const vy = dir * SWING_SPEED * Math.sin(angle);
  const time = (vy + Math.sqrt(vy * vy + 2 * SWING_GRAVITY * y0)) / SWING_GRAVITY;
  return { x0, y0, vx, vy, distance: Math.round((x0 + vx * time) * 100) / 100, flightMs: Math.round(time * 1000) };
}

/** Posicion en el aire a los `t` segundos de soltarse. */
export function swingFlightPoint(launch: SwingLaunch, t: number): { x: number; y: number } {
  const time = Math.min(t, launch.flightMs / 1000);
  return {
    x: launch.x0 + launch.vx * time,
    y: Math.max(0, launch.y0 + launch.vy * time - (SWING_GRAVITY * time * time) / 2),
  };
}
