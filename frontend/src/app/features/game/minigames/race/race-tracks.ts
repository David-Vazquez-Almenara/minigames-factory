// Circuitos de la Carrera y su geometria: la linea central se genera a partir de unos puntos de control (curva
// cerrada suavizada, para que rectas y curvas enlacen bien), se mide (distancia recorrida en cada punto) y se
// detectan los cruces consigo misma: en cada cruce, la pasada posterior va por un puente y la anterior por debajo.

export type Surface = 'dirt' | 'asphalt' | 'clay';

export interface TrackDefinition {
  id: string;
  name: string;
  surface: Surface;
  /** Puntos de control (en unidades del dibujo; se multiplican por `scale`). */
  points: Array<[number, number]>;
  scale: number;
  /** Ancho de la carretera (unidades del mundo). */
  width: number;
}

export interface Bridge {
  /** Tramo de arriba (indices de la linea central, puede dar la vuelta al final). */
  from: number;
  to: number;
  /** Tramo de abajo (para la sombra del puente). */
  lowerFrom: number;
  lowerTo: number;
  at: [number, number];
}

export interface Track {
  definition: TrackDefinition;
  /** Linea central muestreada cada STEP unidades. */
  xs: Float64Array;
  ys: Float64Array;
  /** Distancia recorrida desde la salida en cada punto. */
  distances: Float64Array;
  /** Direccion (radianes) de la carretera en cada punto. */
  angles: Float64Array;
  /** 1 si el punto va por encima de un puente. */
  upper: Uint8Array;
  length: number;
  width: number;
  bridges: Bridge[];
  /** Puntos de control (indices de la linea central), en el orden en que hay que pasarlos en cada vuelta. */
  checkpoints: number[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export const RACE_LAPS = 2;
const STEP = 10;
// Un punto de control mas o menos cada tanto recorrido (y nunca en un puente ni debajo de uno).
const CHECKPOINT_SPACING = 1600;

export const TRACKS: TrackDefinition[] = [
  {
    // El recorrido del dibujo: lazos que se cruzan varias veces (cada cruce, un puente).
    id: 'bosque',
    name: 'Bosque',
    surface: 'dirt',
    scale: 7,
    width: 160,
    points: [
      [467, 255], [540, 253], [600, 243], [622, 215], [595, 188], [520, 178], [430, 166], [300, 160], [215, 158],
      [160, 185], [128, 225], [130, 268], [155, 300], [200, 322], [260, 328], [298, 315], [310, 285], [310, 230],
      [312, 160], [318, 118], [350, 85], [420, 74], [520, 82], [605, 98], [660, 135], [700, 192], [735, 228],
      [775, 232], [805, 200], [845, 165], [905, 155], [950, 175], [970, 225], [968, 290], [940, 335], [880, 360],
      [760, 363], [640, 350], [480, 348], [420, 360], [390, 395], [395, 440], [440, 465], [505, 465], [540, 435],
      [525, 400], [470, 390], [330, 388], [210, 385], [120, 375], [70, 345], [55, 305], [85, 280], [150, 270],
      [260, 272], [350, 273], [420, 266],
    ],
  },
  {
    // Circuito de asfalto: recta larga de salida, curva rapida, horquillas y un puente.
    id: 'circuito',
    name: 'Circuito',
    surface: 'asphalt',
    scale: 7.5,
    width: 150,
    points: [
      [330, 650], [600, 655], [850, 635], [975, 545], [985, 405], [905, 315], [760, 295], [560, 305], [400, 335],
      [270, 395], [160, 340], [120, 210], [200, 100], [360, 55], [540, 65], [665, 115], [715, 205], [718, 380],
      [690, 470], [580, 510], [400, 510], [230, 520], [120, 575], [170, 645],
    ],
  },
  {
    // Nudo de trebol: tres cruces casi en angulo recto (tres puentes).
    id: 'canon',
    name: 'Cañón',
    surface: 'clay',
    scale: 7.5,
    width: 160,
    points: Array.from({ length: 15 }, (_unused, index) => {
      const t = (index / 15) * Math.PI * 2 + 2.75;
      const wobble = 1 + 0.07 * Math.sin(index * 2.3);
      return [500 + 150 * wobble * (Math.sin(t) + 2 * Math.sin(2 * t)), 330 + 97 * wobble * (Math.cos(t) - 2 * Math.cos(2 * t))] as [number, number];
    }),
  },
];

/** Curva cerrada Catmull-Rom centripeta (sin bucles raros entre puntos desiguales). */
function catmullRom(points: Array<[number, number]>, perSegment: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = points.length;

  for (let index = 0; index < n; index += 1) {
    const p0 = points[(index - 1 + n) % n];
    const p1 = points[index];
    const p2 = points[(index + 1) % n];
    const p3 = points[(index + 2) % n];
    const knot = (a: [number, number], b: [number, number]) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);

    for (let step = 0; step < perSegment; step += 1) {
      const t = t1 + ((t2 - t1) * step) / perSegment;
      const mix = (a: [number, number], b: [number, number], ta: number, tb: number): [number, number] => [
        ((tb - t) / (tb - ta)) * a[0] + ((t - ta) / (tb - ta)) * b[0],
        ((tb - t) / (tb - ta)) * a[1] + ((t - ta) / (tb - ta)) * b[1],
      ];
      const a1 = mix(p0, p1, t0, t1);
      const a2 = mix(p1, p2, t1, t2);
      const a3 = mix(p2, p3, t2, t3);
      const b1 = mix(a1, a2, t0, t2);
      const b2 = mix(a2, a3, t1, t3);
      out.push(mix(b1, b2, t1, t2));
    }
  }

  return out;
}

/** Puntos repartidos a distancia fija a lo largo de la curva cerrada. */
function resample(points: Array<[number, number]>, step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [points[0]];
  let carry = 0;

  for (let index = 0; index < points.length; index += 1) {
    const [ax, ay] = points[index];
    const [bx, by] = points[(index + 1) % points.length];
    const segment = Math.hypot(bx - ax, by - ay);
    let along = step - carry;

    while (along <= segment) {
      const t = along / segment;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
      along += step;
    }

    carry = segment - (along - step);
  }

  // El ultimo no debe pisar al primero.
  const last = out[out.length - 1];

  if (Math.hypot(last[0] - out[0][0], last[1] - out[0][1]) < step * 0.5) {
    out.pop();
  }

  return out;
}

/** Media movil circular (varias pasadas): curvatura suave, sin esquinas entre rectas y curvas. */
function smooth(points: Array<[number, number]>, radius: number, passes: number): Array<[number, number]> {
  let current = points;
  const n = points.length;

  for (let pass = 0; pass < passes; pass += 1) {
    const next: Array<[number, number]> = [];

    for (let index = 0; index < n; index += 1) {
      let sx = 0;
      let sy = 0;

      for (let offset = -radius; offset <= radius; offset += 1) {
        const [x, y] = current[(index + offset + n) % n];
        sx += x;
        sy += y;
      }

      next.push([sx / (radius * 2 + 1), sy / (radius * 2 + 1)]);
    }

    current = next;
  }

  return current;
}

function intersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): [number, number] | null {
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const t = d3 / (d3 - d4);
    return [cx + (dx - cx) * t, cy + (dy - cy) * t];
  }

  return null;
}

const cache = new Map<string, Track>();

export function buildTrack(definition: TrackDefinition): Track {
  const cached = cache.get(definition.id);

  if (cached) {
    return cached;
  }

  const scaled = definition.points.map(([x, y]) => [x * definition.scale, y * definition.scale] as [number, number]);
  const points = resample(smooth(resample(catmullRom(scaled, 24), STEP), 6, 5), STEP);
  const n = points.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const distances = new Float64Array(n);
  const angles = new Float64Array(n);
  let total = 0;

  for (let index = 0; index < n; index += 1) {
    xs[index] = points[index][0];
    ys[index] = points[index][1];

    if (index > 0) {
      total += Math.hypot(xs[index] - xs[index - 1], ys[index] - ys[index - 1]);
    }

    distances[index] = total;
  }

  const length = total + Math.hypot(xs[0] - xs[n - 1], ys[0] - ys[n - 1]);

  for (let index = 0; index < n; index += 1) {
    const next = (index + 1) % n;
    const previous = (index - 1 + n) % n;
    angles[index] = Math.atan2(ys[next] - ys[previous], xs[next] - xs[previous]);
  }

  // Cruces: la pasada posterior (en el orden de la carrera) va por el puente.
  const upper = new Uint8Array(n);
  const bridges: Bridge[] = [];
  const gap = Math.ceil((definition.width * 2) / STEP);
  const span = Math.ceil((definition.width * 0.75 + 80) / STEP);

  for (let i = 0; i < n; i += 1) {
    const ni = (i + 1) % n;

    for (let j = i + gap; j < n; j += 1) {
      if (n - (j - i) < gap) {
        continue;
      }

      const nj = (j + 1) % n;
      const hit = intersect(xs[i], ys[i], xs[ni], ys[ni], xs[j], ys[j], xs[nj], ys[nj]);

      if (hit && !bridges.some((bridge) => Math.hypot(bridge.at[0] - hit[0], bridge.at[1] - hit[1]) < definition.width)) {
        bridges.push({ from: (j - span + n) % n, to: (j + span) % n, lowerFrom: (i - span + n) % n, lowerTo: (i + span) % n, at: hit });

        for (let k = -span; k <= span; k += 1) {
          upper[(j + k + n) % n] = 1;
        }
      }
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let index = 0; index < n; index += 1) {
    minX = Math.min(minX, xs[index]);
    minY = Math.min(minY, ys[index]);
    maxX = Math.max(maxX, xs[index]);
    maxY = Math.max(maxY, ys[index]);
  }

  // Puntos de control repartidos por la vuelta (ni en la salida ni cerca de un cruce, para que no haya dudas de
  // si se ha pasado por el tramo de arriba o el de abajo).
  const nearCrossing = (index: number) =>
    bridges.some((bridge) => Math.hypot(xs[index] - bridge.at[0], ys[index] - bridge.at[1]) < definition.width * 2.2);
  const count = Math.max(8, Math.round(length / CHECKPOINT_SPACING));
  const checkpoints: number[] = [];

  for (let k = 1; k <= count; k += 1) {
    const target = (k / (count + 1)) * length;
    let index = 0;

    while (index < n - 1 && distances[index] < target) {
      index += 1;
    }

    // Si cae junto a un cruce, se mueve hacia delante hasta que queda despejado.
    let shifted = index;

    while (nearCrossing(shifted) && shifted < n - 1) {
      shifted += 1;
    }

    if (distances[shifted] < length - 400 && !checkpoints.includes(shifted) && (!checkpoints.length || shifted - checkpoints[checkpoints.length - 1] > 30)) {
      checkpoints.push(shifted);
    }
  }

  const track: Track = { definition, xs, ys, distances, angles, upper, length, width: definition.width, bridges, checkpoints, bounds: { minX, minY, maxX, maxY } };
  cache.set(definition.id, track);
  return track;
}

/**
 * Punto de la linea central mas cercano, buscando solo cerca del ultimo conocido (asi, en un cruce, el coche
 * sigue en su tramo y no "salta" al de abajo o al de arriba).
 */
export function trackIndexNear(track: Track, x: number, y: number, hint: number, back = 30, ahead = 60): number {
  const n = track.xs.length;
  let best = hint;
  let bestDistance = Infinity;

  for (let offset = -back; offset <= ahead; offset += 1) {
    const index = (hint + offset + n) % n;
    const distance = (track.xs[index] - x) ** 2 + (track.ys[index] - y) ** 2;

    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }

  return best;
}

/** Distancia del punto al centro de la carretera en el indice dado (cerca de el). */
export function distanceToCenter(track: Track, x: number, y: number, index: number): number {
  const n = track.xs.length;
  let best = Infinity;

  for (let offset = -2; offset <= 2; offset += 1) {
    const a = (index + offset + n) % n;
    const b = (a + 1) % n;
    const ax = track.xs[a];
    const ay = track.ys[a];
    const dx = track.xs[b] - ax;
    const dy = track.ys[b] - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
  }

  return best;
}

/** Posicion de salida: filas de dos detras de la linea, mirando hacia delante. */
export function gridSlot(track: Track, slot: number): { x: number; y: number; angle: number; index: number } {
  const n = track.xs.length;
  const row = Math.floor(slot / 2);
  const behind = 70 + row * 95;
  const index = (n - Math.round(behind / STEP) + n) % n;
  const angle = track.angles[index];
  const side = (slot % 2 ? 1 : -1) * track.width * 0.22;
  return { x: track.xs[index] - Math.sin(angle) * side, y: track.ys[index] + Math.cos(angle) * side, angle, index };
}

export const TRACK_STEP = STEP;
