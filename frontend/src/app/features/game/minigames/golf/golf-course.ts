// Mapas y fisica del Mini golf (2D, vista cenital). La fisica es determinista: con el mismo tiro (angulo y fuerza
// redondeados) todos los clientes calculan exactamente el mismo recorrido, asi cada uno reproduce las bolas de los
// demas sin que nadie le envie posiciones.

export const GOLF_WIDTH = 400;
export const GOLF_HEIGHT = 640;
export const BALL_RADIUS = 8;
export const HOLE_RADIUS = 13;
// Velocidad (unidades/s) con la fuerza maxima.
export const MAX_SHOT_SPEED = 950;
const FRICTION = 190;
const SAND_FRICTION = 720;
const STOP_SPEED = 6;
// Si pasa por el hoyo mas rapido que esto, la bola salta por encima (no entra).
const HOLE_CAPTURE_SPEED = 430;
const WALL_BOUNCE = 0.72;
const BUMPER_BOUNCE = 1.05;
const STEP = 1 / 240;
const MAX_TIME = 9;
// Distancia que cuenta quien cae al agua (igual que no tirar).
export const GOLF_MISS_DISTANCE = 1000;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GolfMap {
  name: string;
  tee: { x: number; y: number };
  hole: { x: number; y: number };
  walls: Rect[];
  sand: Rect[];
  water: Rect[];
  bumpers: Array<{ x: number; y: number; r: number }>;
}

/**
 * Veinte hoyos dificiles. En ninguno hay linea recta libre entre la salida y el hoyo (siempre hay una pared, una seta
 * o agua en medio): hay que jugar con los rebotes. Todos estan comprobados por simulacion: se pueden meter de un golpe
 * y el hoyo esta donde de verdad acaban las bolas que superan los obstaculos.
 */
export const GOLF_MAPS: GolfMap[] = [
  {
    name: 'La S',
    tee: { x: 60, y: 595 },
    hole: { x: 48, y: 224 },
    walls: [{ x: 0, y: 430, w: 290, h: 22 }, { x: 110, y: 250, w: 290, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 330, y: 120, r: 16 }],
  },
  {
    name: 'Doble S',
    tee: { x: 340, y: 600 },
    hole: { x: 368, y: 288 },
    walls: [{ x: 130, y: 470, w: 270, h: 22 }, { x: 0, y: 330, w: 270, h: 22 }, { x: 130, y: 190, w: 270, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 70, y: 260, r: 18 }],
  },
  {
    name: 'La caja',
    tee: { x: 200, y: 600 },
    hole: { x: 240, y: 208 },
    walls: [{ x: 110, y: 90, w: 22, h: 170 }, { x: 268, y: 90, w: 22, h: 170 }, { x: 110, y: 238, w: 180, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 200, y: 420, r: 32 }],
  },
  {
    name: 'Tres pasillos',
    tee: { x: 60, y: 600 },
    hole: { x: 320, y: 528 },
    walls: [{ x: 125, y: 230, w: 22, h: 410 }, { x: 253, y: 0, w: 22, h: 330 }],
    sand: [],
    water: [],
    bumpers: [],
  },
  {
    name: 'El caracol',
    tee: { x: 60, y: 600 },
    hole: { x: 288, y: 192 },
    walls: [{ x: 60, y: 60, w: 290, h: 22 }, { x: 328, y: 60, w: 22, h: 330 }, { x: 120, y: 368, w: 230, h: 22 }, { x: 120, y: 160, w: 22, h: 230 }, { x: 120, y: 160, w: 140, h: 22 }],
    sand: [],
    water: [],
    bumpers: [],
  },
  {
    name: 'Ventanas',
    tee: { x: 200, y: 600 },
    hole: { x: 160, y: 144 },
    walls: [{ x: 0, y: 330, w: 60, h: 22 }, { x: 100, y: 330, w: 200, h: 22 }, { x: 340, y: 330, w: 60, h: 22 }, { x: 0, y: 180, w: 180, h: 22 }, { x: 220, y: 180, w: 180, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 200, y: 460, r: 28 }],
  },
  {
    name: 'El tobogán',
    tee: { x: 345, y: 600 },
    hole: { x: 32, y: 480 },
    walls: [{ x: 180, y: 110, w: 32, h: 530 }],
    sand: [{ x: 0, y: 300, w: 120, h: 70 }],
    water: [],
    bumpers: [{ x: 100, y: 60, r: 18 }],
  },
  {
    name: 'Muro y setas',
    tee: { x: 200, y: 600 },
    hole: { x: 48, y: 128 },
    walls: [{ x: 40, y: 310, w: 320, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 100, y: 200, r: 20 }, { x: 200, y: 175, r: 20 }, { x: 300, y: 200, r: 20 }, { x: 200, y: 430, r: 26 }, { x: 60, y: 90, r: 16 }, { x: 340, y: 90, r: 16 }],
  },
  {
    name: 'El foso',
    tee: { x: 200, y: 600 },
    hole: { x: 208, y: 144 },
    walls: [{ x: 130, y: 330, w: 140, h: 22 }],
    sand: [],
    water: [{ x: 105, y: 60, w: 30, h: 200 }, { x: 265, y: 60, w: 30, h: 200 }, { x: 105, y: 230, w: 190, h: 30 }],
    bumpers: [],
  },
  {
    name: 'Pasillos cruzados',
    tee: { x: 345, y: 600 },
    hole: { x: 80, y: 528 },
    walls: [{ x: 253, y: 230, w: 22, h: 410 }, { x: 125, y: 0, w: 22, h: 330 }],
    sand: [{ x: 0, y: 260, w: 120, h: 70 }],
    water: [],
    bumpers: [],
  },
  {
    name: 'El embudo',
    tee: { x: 200, y: 600 },
    hole: { x: 272, y: 320 },
    walls: [{ x: 60, y: 200, w: 22, h: 260 }, { x: 318, y: 200, w: 22, h: 260 }, { x: 60, y: 438, w: 115, h: 22 }, { x: 225, y: 438, w: 115, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 200, y: 360, r: 24 }],
  },
  {
    name: 'Pinball loco',
    tee: { x: 200, y: 605 },
    hole: { x: 336, y: 160 },
    walls: [{ x: 120, y: 300, w: 160, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 80, y: 500, r: 18 }, { x: 200, y: 470, r: 22 }, { x: 320, y: 500, r: 18 }, { x: 130, y: 400, r: 18 }, { x: 270, y: 400, r: 18 }, { x: 60, y: 300, r: 16 }, { x: 340, y: 300, r: 16 }, { x: 130, y: 200, r: 18 }, { x: 270, y: 200, r: 18 }, { x: 200, y: 130, r: 20 }, { x: 90, y: 90, r: 14 }, { x: 310, y: 90, r: 14 }],
  },
  {
    name: 'La cruz',
    tee: { x: 80, y: 600 },
    hole: { x: 384, y: 272 },
    walls: [{ x: 40, y: 310, w: 160, h: 22 }, { x: 200, y: 150, w: 22, h: 340 }, { x: 222, y: 310, w: 140, h: 22 }],
    sand: [],
    water: [],
    bumpers: [],
  },
  {
    name: 'Agua en S',
    tee: { x: 60, y: 600 },
    hole: { x: 48, y: 176 },
    walls: [],
    sand: [],
    water: [{ x: 0, y: 420, w: 290, h: 30 }, { x: 110, y: 240, w: 290, h: 30 }],
    bumpers: [],
  },
  {
    name: 'La doble caja',
    tee: { x: 200, y: 600 },
    hole: { x: 272, y: 224 },
    walls: [{ x: 60, y: 80, w: 22, h: 300 }, { x: 318, y: 80, w: 22, h: 300 }, { x: 60, y: 358, w: 280, h: 22 }, { x: 60, y: 80, w: 120, h: 22 }, { x: 140, y: 170, w: 120, h: 22 }],
    sand: [],
    water: [],
    bumpers: [],
  },
  {
    name: 'La escalera',
    tee: { x: 50, y: 600 },
    hole: { x: 48, y: 112 },
    walls: [{ x: 0, y: 500, w: 150, h: 22 }, { x: 130, y: 380, w: 150, h: 22 }, { x: 250, y: 260, w: 150, h: 22 }, { x: 130, y: 140, w: 150, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 330, y: 420, r: 18 }],
  },
  {
    name: 'Laberinto',
    tee: { x: 340, y: 600 },
    hole: { x: 384, y: 272 },
    walls: [{ x: 80, y: 470, w: 320, h: 22 }, { x: 0, y: 320, w: 300, h: 22 }, { x: 200, y: 100, w: 22, h: 140 }],
    sand: [],
    water: [],
    bumpers: [{ x: 70, y: 420, r: 16 }, { x: 330, y: 290, r: 16 }],
  },
  {
    name: 'La U profunda',
    tee: { x: 80, y: 600 },
    hole: { x: 256, y: 480 },
    walls: [{ x: 170, y: 200, w: 60, h: 440 }],
    sand: [{ x: 240, y: 260, w: 160, h: 60 }],
    water: [],
    bumpers: [{ x: 200, y: 40, r: 18 }],
  },
  {
    name: 'El rincón',
    tee: { x: 330, y: 600 },
    hole: { x: 96, y: 128 },
    walls: [{ x: 0, y: 150, w: 120, h: 22 }, { x: 150, y: 0, w: 22, h: 110 }, { x: 80, y: 330, w: 320, h: 22 }],
    sand: [],
    water: [],
    bumpers: [{ x: 150, y: 230, r: 20 }],
  },
  {
    name: 'La gran final',
    tee: { x: 60, y: 600 },
    hole: { x: 160, y: 224 },
    walls: [{ x: 0, y: 470, w: 300, h: 22 }, { x: 100, y: 320, w: 300, h: 22 }, { x: 180, y: 90, w: 22, h: 160 }],
    sand: [{ x: 0, y: 360, w: 90, h: 60 }],
    water: [{ x: 230, y: 160, w: 170, h: 40 }],
    bumpers: [{ x: 330, y: 400, r: 18 }, { x: 80, y: 230, r: 18 }],
  },
];

export interface GolfSimulation {
  /** Posicion de la bola en cada paso de la simulacion (STEP segundos entre puntos). */
  path: Array<{ x: number; y: number }>;
  stepMs: number;
  holed: boolean;
  water: boolean;
  /** Distancia final al hoyo (0 si entra; GOLF_MISS_DISTANCE si cae al agua). */
  distance: number;
}

const inside = (rect: Rect, x: number, y: number) => x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;

/** Redondeo comun del tiro: lo que se envia y lo que simula cada cliente es exactamente lo mismo. */
export function roundShot(value: number): number {
  return Math.round(value * 100000) / 100000;
}

/** Simula un golpe (angulo en radianes, 0 = hacia la derecha, -PI/2 = hacia arriba; fuerza 0-1). */
export function simulateGolf(map: GolfMap, angle: number, power: number): GolfSimulation {
  let x = map.tee.x;
  let y = map.tee.y;
  let vx = Math.cos(angle) * MAX_SHOT_SPEED * power;
  let vy = Math.sin(angle) * MAX_SHOT_SPEED * power;
  const path = [{ x, y }];
  const walls = [...map.walls, { x: -100, y: -100, w: 100, h: GOLF_HEIGHT + 200 }, { x: GOLF_WIDTH, y: -100, w: 100, h: GOLF_HEIGHT + 200 }, { x: -100, y: -100, w: GOLF_WIDTH + 200, h: 100 }, { x: -100, y: GOLF_HEIGHT, w: GOLF_WIDTH + 200, h: 100 }];

  for (let time = 0; time < MAX_TIME; time += STEP) {
    const speed = Math.hypot(vx, vy);

    if (speed < STOP_SPEED) {
      break;
    }

    // Rozamiento (mucho mas en la arena).
    const friction = map.sand.some((rect) => inside(rect, x, y)) ? SAND_FRICTION : FRICTION;
    const slowed = Math.max(0, speed - friction * STEP);
    vx *= slowed / speed;
    vy *= slowed / speed;
    x += vx * STEP;
    y += vy * STEP;

    // Paredes (rectangulos y bordes del campo): rebote contra la cara mas cercana.
    for (const wall of walls) {
      const nearestX = Math.max(wall.x, Math.min(x, wall.x + wall.w));
      const nearestY = Math.max(wall.y, Math.min(y, wall.y + wall.h));
      const dx = x - nearestX;
      const dy = y - nearestY;
      const distance = Math.hypot(dx, dy);

      if (distance < BALL_RADIUS) {
        const nx = distance > 0 ? dx / distance : 0;
        const ny = distance > 0 ? dy / distance : -1;
        x = nearestX + nx * BALL_RADIUS;
        y = nearestY + ny * BALL_RADIUS;
        const along = vx * nx + vy * ny;

        if (along < 0) {
          vx -= (1 + WALL_BOUNCE) * along * nx;
          vy -= (1 + WALL_BOUNCE) * along * ny;
        }
      }
    }

    // Setas de rebote: devuelven la bola con algo mas de fuerza.
    for (const bumper of map.bumpers) {
      const dx = x - bumper.x;
      const dy = y - bumper.y;
      const distance = Math.hypot(dx, dy);

      if (distance < bumper.r + BALL_RADIUS && distance > 0) {
        const nx = dx / distance;
        const ny = dy / distance;
        x = bumper.x + nx * (bumper.r + BALL_RADIUS);
        y = bumper.y + ny * (bumper.r + BALL_RADIUS);
        const along = vx * nx + vy * ny;

        if (along < 0) {
          vx -= (1 + BUMPER_BOUNCE) * along * nx;
          vy -= (1 + BUMPER_BOUNCE) * along * ny;
        }
      }
    }

    path.push({ x, y });

    if (map.water.some((rect) => inside(rect, x, y))) {
      return { path, stepMs: STEP * 1000, holed: false, water: true, distance: GOLF_MISS_DISTANCE };
    }

    if (Math.hypot(x - map.hole.x, y - map.hole.y) < HOLE_RADIUS && Math.hypot(vx, vy) < HOLE_CAPTURE_SPEED) {
      path.push({ x: map.hole.x, y: map.hole.y });
      return { path, stepMs: STEP * 1000, holed: true, water: false, distance: 0 };
    }
  }

  return { path, stepMs: STEP * 1000, holed: false, water: false, distance: Math.round(Math.hypot(x - map.hole.x, y - map.hole.y)) };
}
