// Voladuras "ragdoll" pregrabadas (Patata caliente y Canon): no hay fisica real, sino animaciones por fotogramas
// clave que imitan a un cuerpo que sale despedido hacia atras por una explosion: vuela dando vueltas sin control,
// golpea el suelo, rebota y queda tirado con los brazos y las piernas abiertos. La variante la decide el
// servidor (o algo comun a todas las pantallas), asi todos ven exactamente la misma caida.
//
// El cuerpo gira sobre la cadera. Canales (metros o radianes):
// - back: distancia hacia atras (desde donde estaba). side: hacia su izquierda (+) o derecha (-).
// - y: altura de la cadera (0.9 de pie; 0.28 tumbado en el suelo).
// - pitch: giro hacia atras (negativo) o hacia delante; -PI/2 = tumbado boca arriba, PI/2 = boca abajo.
// - roll: giro de lado. yaw: giro sobre si mismo.
// - bodyX, headX, headZ, armLX, armLZ, armRX, armRZ, legLX, legLZ, legRX, legRZ: extremidades.

export type BlastChannel =
  | 'back'
  | 'side'
  | 'y'
  | 'pitch'
  | 'roll'
  | 'yaw'
  | 'bodyX'
  | 'headX'
  | 'headZ'
  | 'armLX'
  | 'armLZ'
  | 'armRX'
  | 'armRZ'
  | 'legLX'
  | 'legLZ'
  | 'legRX'
  | 'legRZ';

type Keyframe = { t: number } & Partial<Record<BlastChannel, number>>;

const PI = Math.PI;
const HALF_PI = PI / 2;
const TAU = PI * 2;
/** Altura de la cadera de pie y tumbado. */
export const BLAST_STAND_Y = 0.9;
export const BLAST_LYING_Y = 0.28;

// Postura final: tumbado como una estrella (brazos y piernas abiertos, la cabeza caida a un lado).
const SPLAT = { armLX: -0.2, armLZ: -1.45, armRX: 0.25, armRZ: 1.6, legLX: -0.15, legLZ: -0.45, legRX: 0.2, legRZ: 0.4, headZ: 0.5, headX: -0.15 };

const VARIANTS: Keyframe[][] = [
  // 1) Voltereta hacia atras completa, cae de espaldas, rebota y resbala.
  [
    { t: 0, y: BLAST_STAND_Y },
    { t: 0.07, y: 1.05, back: 0.35, pitch: -0.35, armLZ: -1.9, armRZ: 1.9, armLX: -0.6, armRX: -0.6, headX: -0.7, legLX: 0.5, legRX: -0.3 },
    { t: 0.42, y: 2.75, back: 2.3, pitch: -2.7, armLZ: -2.6, armRZ: 2.4, legLX: -0.9, legRX: 0.7, legLZ: -0.3, legRZ: 0.3, headX: 0.4 },
    { t: 0.8, y: 1.9, back: 3.9, pitch: -5.3, armLZ: -1.2, armRZ: 2.9, legLX: 0.8, legRX: -0.5, headZ: -0.5 },
    { t: 1.04, y: BLAST_LYING_Y, back: 4.6, pitch: -TAU - HALF_PI, ...SPLAT, armLZ: -2.2, armRZ: 2.3 },
    { t: 1.18, y: 0.62, back: 5.0, pitch: -TAU - 1.2, legLX: -0.9, legRX: -0.7, armLZ: -1.0, armRZ: 1.1 },
    { t: 1.34, y: BLAST_LYING_Y, back: 5.35, pitch: -TAU - HALF_PI, ...SPLAT },
    { t: 1.44, y: 0.36, back: 5.5, pitch: -TAU - 1.45 },
    { t: 1.62, y: BLAST_LYING_Y, back: 5.7, pitch: -TAU - HALF_PI, ...SPLAT },
  ],
  // 2) Sale girando como una peonza, de lado, y cae de espaldas con dos rebotes.
  [
    { t: 0, y: BLAST_STAND_Y },
    { t: 0.08, y: 1.1, back: 0.4, side: 0.15, pitch: -0.5, roll: 0.4, armLZ: -2.4, armRZ: 1.0, headZ: 0.8, legLZ: -0.5 },
    { t: 0.4, y: 2.3, back: 2.1, side: 0.6, pitch: -1.2, roll: 1.4, yaw: 3.8, armLZ: -2.7, armRZ: 2.7, legLZ: -0.6, legRZ: 0.6, headX: -0.6 },
    { t: 0.78, y: 1.5, back: 3.6, side: 0.9, pitch: -1.5, roll: 0.9, yaw: 7.6, armLX: -1.3, armRX: 0.9, legLX: 1.0, legRX: -0.6 },
    { t: 0.98, y: BLAST_LYING_Y, back: 4.2, side: 1.0, pitch: -HALF_PI, roll: 0.15, yaw: 9.4, ...SPLAT },
    { t: 1.12, y: 0.7, back: 4.6, side: 1.1, pitch: -1.0, roll: -0.3, yaw: 9.9, armLZ: -0.6, armRZ: 0.8, legLX: -1.1, legRX: -0.9 },
    { t: 1.3, y: BLAST_LYING_Y, back: 5.0, side: 1.15, pitch: -HALF_PI, roll: 0.1, yaw: 10.3, ...SPLAT },
    { t: 1.42, y: 0.42, back: 5.15, pitch: -1.35, yaw: 10.45 },
    { t: 1.58, y: BLAST_LYING_Y, back: 5.3, side: 1.2, pitch: -HALF_PI, roll: 0, yaw: 10.5, ...SPLAT },
  ],
  // 3) Planchazo: sale muy alto, da tres cuartos de vuelta y cae boca abajo; resbala por el suelo.
  [
    { t: 0, y: BLAST_STAND_Y },
    { t: 0.06, y: 1.05, back: 0.3, pitch: -0.25, armLZ: -1.6, armRZ: 1.6, headX: -0.8, legLX: 0.4, legRX: 0.4 },
    { t: 0.55, y: 3.6, back: 2.2, side: -0.3, pitch: -2.2, roll: -0.3, armLZ: -2.8, armRZ: 2.8, armLX: -0.5, armRX: -0.5, legLZ: -0.5, legRZ: 0.5, headX: 0.3 },
    { t: 0.95, y: 2.4, back: 3.4, side: -0.5, pitch: -3.6, roll: -0.2, armLX: -2.6, armRX: -2.6, armLZ: -0.4, armRZ: 0.4, legLX: -0.4, legRX: -0.4 },
    { t: 1.22, y: BLAST_LYING_Y, back: 4.3, side: -0.6, pitch: -PI - HALF_PI, roll: 0, armLX: -2.9, armRX: -2.9, armLZ: -0.6, armRZ: 0.6, legLX: 0.2, legRX: 0.1, headX: 0.3, headZ: -0.6 },
    { t: 1.34, y: 0.45, back: 4.7, pitch: -PI - 1.35, legLX: 0.9, legRX: 0.7 },
    { t: 1.48, y: BLAST_LYING_Y, back: 5.0, pitch: -PI - HALF_PI, legLX: 0.15, legRX: 0.05 },
    { t: 1.9, y: BLAST_LYING_Y, back: 5.75, side: -0.65, pitch: -PI - HALF_PI, armLZ: -1.3, armRZ: 1.4, armLX: -2.5, armRX: -2.5, legLZ: -0.4, legRZ: 0.4 },
  ],
];

export const BLAST_VARIANT_COUNT = VARIANTS.length;

const CHANNELS: BlastChannel[] = ['back', 'side', 'y', 'pitch', 'roll', 'yaw', 'bodyX', 'headX', 'headZ', 'armLX', 'armLZ', 'armRX', 'armRZ', 'legLX', 'legLZ', 'legRX', 'legRZ'];
const DEFAULTS: Partial<Record<BlastChannel, number>> = { y: BLAST_STAND_Y };
// Los canales de posicion van en linea recta entre fotogramas (vuelo y rebotes); el resto, suavizados.
const LINEAR = new Set<BlastChannel>(['back', 'side']);
const smooth = (value: number) => value * value * (3 - 2 * value);

/** Postura del cuerpo `t` segundos despues de la explosion (se mantiene la ultima al terminar). */
export function sampleBlast(variant: number, t: number): Record<BlastChannel, number> {
  const frames = VARIANTS[((variant % VARIANTS.length) + VARIANTS.length) % VARIANTS.length];
  const result = {} as Record<BlastChannel, number>;

  for (const channel of CHANNELS) {
    const fallback = DEFAULTS[channel] ?? 0;
    const keys = frames.filter((frame) => frame.t === 0 || frame[channel] !== undefined).map((frame) => ({ t: frame.t, v: frame[channel] ?? fallback }));
    let value = keys[keys.length - 1].v;

    for (let index = 0; index < keys.length - 1; index += 1) {
      const from = keys[index];
      const to = keys[index + 1];

      if (t <= to.t) {
        const progress = to.t > from.t ? Math.min(1, Math.max(0, (t - from.t) / (to.t - from.t))) : 1;
        // La altura sigue una parabola entre fotogramas (sube frenando y cae acelerando).
        const eased = LINEAR.has(channel) ? progress : channel === 'y' ? (to.v > from.v ? 1 - (1 - progress) * (1 - progress) : progress * progress) : smooth(progress);
        value = from.v + (to.v - from.v) * eased;
        break;
      }
    }

    result[channel] = value;
  }

  return result;
}

/** Duracion de la voladura (s). */
export function blastDuration(variant: number): number {
  const frames = VARIANTS[((variant % VARIANTS.length) + VARIANTS.length) % VARIANTS.length];
  return frames[frames.length - 1].t;
}

/** Instantes (s) en los que el cuerpo golpea el suelo (para el sonido y las manchas). */
export function blastImpacts(variant: number): number[] {
  const frames = VARIANTS[((variant % VARIANTS.length) + VARIANTS.length) % VARIANTS.length];
  return frames.filter((frame, index) => index > 0 && frame.y === BLAST_LYING_Y && frames[index - 1].y !== BLAST_LYING_Y).map((frame) => frame.t);
}
