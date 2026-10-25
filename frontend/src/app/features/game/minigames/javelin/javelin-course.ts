// Mapas y fisica del Tiro de jabalina. Unidades en metros; x = 0 es la linea de lanzamiento y la altura del terreno
// la da una suma de ondas (colinas) mas algunos baches. La fisica es determinista: con el mismo angulo y la misma
// fuerza, la jabalina cae exactamente en el mismo sitio en todas las pantallas.

export const GRAVITY = 9.8;
export const MIN_SPEED = 6;
export const MAX_SPEED = 26;
/** Altura del hombro sobre el suelo al soltar. */
export const RELEASE_HEIGHT = 1.8;
export const COURSE_END = 120;
const STEP = 1 / 240;

export interface JavelinMap {
  name: string;
  sky: [string, string];
  grass: string;
  dirt: string;
  /** Pendiente general (m de subida por m) y ondas [amplitud, longitud de onda, fase]. */
  slope: number;
  waves: Array<[number, number, number]>;
  /** Baches: [centro, anchura, altura (negativa = hoyo)]. */
  bumps: Array<[number, number, number]>;
}

export const JAVELIN_MAPS: JavelinMap[] = [
  {
    name: 'Colinas suaves',
    sky: ['#8fd3ff', '#e3f6ff'],
    grass: '#6cc24a',
    dirt: '#8a5a32',
    slope: 0,
    waves: [[2.2, 34, 0.4], [0.9, 11, 1.7]],
    bumps: [[18, 3, 1.1], [41, 4, -1.2], [57, 3, 1.4]],
  },
  {
    name: 'El valle',
    sky: ['#ffc58f', '#fff0d9'],
    grass: '#7fbf4d',
    dirt: '#7a4a2a',
    slope: 0,
    waves: [[-6, 120, 0.2], [1.2, 15, 2.4]],
    bumps: [[30, 2.5, 1.3], [46, 3, 1.6]],
  },
  {
    name: 'Cuesta arriba',
    sky: ['#9fb8ff', '#e8eeff'],
    grass: '#5fae45',
    dirt: '#6d4a33',
    slope: 0.16,
    waves: [[1.4, 21, 1.1], [0.6, 7, 0.3]],
    bumps: [[26, 3, -1], [38, 2.5, 1.2], [52, 4, 1.5]],
  },
  {
    name: 'Cuesta abajo',
    sky: ['#ffb3c7', '#fff0f4'],
    grass: '#74c25a',
    dirt: '#8a5a32',
    slope: -0.18,
    waves: [[1.6, 26, 2.2], [0.7, 9, 0.9]],
    bumps: [[22, 3, 1.4], [35, 2, 1.2], [48, 3, -1.3]],
  },
  {
    name: 'Dientes de sierra',
    sky: ['#a7e0d9', '#effcfa'],
    grass: '#66b84c',
    dirt: '#5f4632',
    slope: 0.03,
    waves: [[1.1, 8, 0.6], [2.4, 29, 1.9]],
    bumps: [[16, 2, 1.6], [28, 2, 1.8], [36, 2, 1.8], [44, 2, 1.8], [62, 3, 2]],
  },
  {
    name: 'La meseta',
    sky: ['#ffd98f', '#fff7e0'],
    grass: '#8bc34a',
    dirt: '#8a6a3a',
    slope: 0,
    waves: [[0.5, 13, 0.8]],
    bumps: [[24, 9, 5], [52, 8, 4.5], [38, 2, -1.5]],
  },
];

/** Altura del terreno en x (metros). Se normaliza para que en x = 0 este a 0. */
export function terrainHeight(map: JavelinMap, x: number): number {
  return rawHeight(map, x) - rawHeight(map, 0);
}

function rawHeight(map: JavelinMap, at: number): number {
  // Por debajo de 2 m el suelo es plano (la zona de lanzamiento, donde estan todos los jugadores).
  const x = Math.max(2, at);
  let height = map.slope * x;

  for (const [amplitude, length, phase] of map.waves) {
    height += amplitude * Math.sin((x / length) * Math.PI * 2 + phase);
  }

  for (const [center, width, size] of map.bumps) {
    const distance = (x - center) / width;
    height += size * Math.exp(-distance * distance);
  }

  return height;
}

export interface JavelinFlight {
  angle: number;
  power: number;
  speed: number;
  /** Duracion del vuelo (s) y punto de caida. */
  time: number;
  landX: number;
  landY: number;
  /** Inclinacion de la jabalina al clavarse (radianes, como el angulo de la velocidad). */
  landAngle: number;
}

export const roundShot = (value: number) => Math.round(value * 100000) / 100000;

export function speedFor(power: number): number {
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * Math.max(0, Math.min(1, power));
}

/** Posicion de la jabalina en el instante t (s) del vuelo. */
export function flightPoint(flight: Pick<JavelinFlight, 'angle' | 'speed'>, t: number): { x: number; y: number; angle: number } {
  const vx = flight.speed * Math.cos(flight.angle);
  const vy = flight.speed * Math.sin(flight.angle);
  return { x: vx * t, y: RELEASE_HEIGHT + vy * t - (GRAVITY * t * t) / 2, angle: Math.atan2(vy - GRAVITY * t, vx) };
}

/** Vuelo completo: avanza en pasos fijos hasta tocar el suelo y afina el punto de caida por biseccion. */
export function simulateJavelin(map: JavelinMap, angle: number, power: number): JavelinFlight {
  const speed = speedFor(power);
  const base = { angle, speed };
  let previous = 0;
  let t = STEP;

  for (; t < 30; t += STEP) {
    const point = flightPoint(base, t);

    if (point.x >= COURSE_END) {
      const end = flightPoint(base, t);
      return { angle, power, speed, time: t, landX: COURSE_END, landY: end.y, landAngle: end.angle };
    }

    if (point.y <= terrainHeight(map, point.x)) {
      break;
    }

    previous = t;
  }

  let low = previous;
  let high = t;

  for (let index = 0; index < 30; index += 1) {
    const middle = (low + high) / 2;
    const point = flightPoint(base, middle);

    if (point.y <= terrainHeight(map, point.x)) {
      high = middle;
    } else {
      low = middle;
    }
  }

  const land = flightPoint(base, high);
  return { angle, power, speed, time: high, landX: Math.round(land.x * 100) / 100, landY: land.y, landAngle: land.angle };
}
