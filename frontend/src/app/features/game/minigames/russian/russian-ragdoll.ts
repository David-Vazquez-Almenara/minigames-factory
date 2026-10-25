// Caidas "ragdoll" pregrabadas de la Ruleta rusa: en vez de fisica real, tres animaciones por fotogramas clave que
// imitan a un cuerpo que se queda sin fuerza de golpe (la cabeza sale despedida, fallan las rodillas, cae al suelo
// y rebota un poco). Cada caida se elige al azar (la misma en todas las pantallas: la decide el numero de turno).
//
// Canales (radianes salvo `drop`, en metros):
// - fallX / fallZ: giro de todo el cuerpo sobre los pies (fallX < 0 hacia atras; fallZ > 0 hacia la izquierda).
// - drop: cuanto baja la cadera (rodillas que fallan).
// - bodyX/bodyZ, headX/headZ: torso y cabeza. armLX/armLZ, armRX/armRZ: brazos. legLX/legRX: piernas.

export type RagdollChannel =
  | 'fallX'
  | 'fallZ'
  | 'drop'
  | 'bodyX'
  | 'bodyZ'
  | 'headX'
  | 'headZ'
  | 'armLX'
  | 'armLZ'
  | 'armRX'
  | 'armRZ'
  | 'legLX'
  | 'legRX';

type Keyframe = { t: number } & Partial<Record<RagdollChannel, number>>;

const HALF_PI = Math.PI / 2;

export const RAGDOLL_VARIANTS: Keyframe[][] = [
  // 1) Se desploma hacia atras: latigazo de la cabeza, rodillas que ceden y de espaldas al suelo con rebote.
  [
    { t: 0 },
    { t: 0.1, headX: -0.55, headZ: 0.6, armRZ: 1.4, armRX: -0.6, bodyZ: 0.12 },
    { t: 0.3, drop: 0.22, legLX: -0.7, legRX: -0.45, fallX: -0.25, armLZ: -0.6, headX: -0.4 },
    { t: 0.62, fallX: -HALF_PI, drop: 0.1, legLX: -0.35, legRX: -0.15, armLZ: -1.7, armRZ: 1.9, armRX: 0, headX: -0.25 },
    { t: 0.76, fallX: -1.36, armLZ: -1.5, armRZ: 1.7 },
    { t: 0.9, fallX: -HALF_PI, headX: -0.1, headZ: 0.9, legLX: -0.2, legRX: 0.05 },
    { t: 0.98, fallX: -1.5 },
    { t: 1.08, fallX: -HALF_PI, armLZ: -1.75, armRZ: 2.0 },
  ],
  // 2) Cae de lado: la cabeza se va a la izquierda y todo el cuerpo detras, como un saco.
  [
    { t: 0 },
    { t: 0.1, headZ: 0.85, headX: -0.2, armRZ: 1.2, bodyZ: 0.25 },
    { t: 0.28, drop: 0.16, legLX: -0.35, legRX: 0.25, fallZ: 0.35, armLZ: -0.4, armRX: -0.5 },
    { t: 0.58, fallZ: HALF_PI, drop: 0.06, armLZ: -2.4, armRZ: 0.6, armRX: 0.4, headZ: 0.5, legLX: -0.5, legRX: 0.4 },
    { t: 0.7, fallZ: 1.38 },
    { t: 0.82, fallZ: HALF_PI, headZ: 0.3 },
    { t: 0.9, fallZ: 1.52, armLZ: -2.6 },
    { t: 1.0, fallZ: HALF_PI, legLX: -0.7, legRX: 0.2 },
  ],
  // 3) Primero de rodillas, se queda un instante y se derrumba hacia el lado derecho.
  [
    { t: 0 },
    { t: 0.1, headX: -0.4, headZ: 0.7, armRZ: 0.9, armRX: -0.3 },
    { t: 0.32, drop: 0.38, legLX: 1.2, legRX: 1.1, bodyX: 0.3, headX: 0.5, headZ: 0.3, armRZ: 0.25, armLZ: -0.2, armRX: 0.2 },
    { t: 0.55, drop: 0.36, bodyX: 0.4, headX: 0.7, legLX: 1.25, legRX: 1.15 },
    { t: 0.85, fallZ: -HALF_PI, drop: 0.2, bodyX: 0.2, headX: 0.2, headZ: -0.4, armLZ: -1.4, armRZ: 2.3, legLX: 0.9, legRX: 0.6 },
    { t: 0.97, fallZ: -1.36, headZ: -0.6 },
    { t: 1.1, fallZ: -HALF_PI, headZ: -0.35 },
    { t: 1.18, fallZ: -1.5 },
    { t: 1.28, fallZ: -HALF_PI, armLZ: -1.6 },
  ],
];

const smooth = (value: number) => value * value * (3 - 2 * value);

/** Valor de un canal en el instante `t` (segundos desde el disparo); se mantiene el ultimo al terminar. */
export function sampleRagdoll(variant: number, t: number): Record<RagdollChannel, number> {
  const frames = RAGDOLL_VARIANTS[variant % RAGDOLL_VARIANTS.length];
  const channels: RagdollChannel[] = ['fallX', 'fallZ', 'drop', 'bodyX', 'bodyZ', 'headX', 'headZ', 'armLX', 'armLZ', 'armRX', 'armRZ', 'legLX', 'legRX'];
  const result = {} as Record<RagdollChannel, number>;

  for (const channel of channels) {
    // Cada canal interpola solo entre los fotogramas que lo definen (el resto lo arrastran).
    const keys = frames.filter((frame) => frame.t === 0 || frame[channel] !== undefined).map((frame) => ({ t: frame.t, v: frame[channel] ?? 0 }));
    let value = keys[keys.length - 1].v;

    for (let index = 0; index < keys.length - 1; index += 1) {
      const from = keys[index];
      const to = keys[index + 1];

      if (t <= to.t) {
        const progress = to.t > from.t ? Math.max(0, (t - from.t) / (to.t - from.t)) : 1;
        value = from.v + (to.v - from.v) * smooth(Math.min(1, progress));
        break;
      }
    }

    result[channel] = value;
  }

  return result;
}

/** Duracion de la caida (s). */
export function ragdollDuration(variant: number): number {
  const frames = RAGDOLL_VARIANTS[variant % RAGDOLL_VARIANTS.length];
  return frames[frames.length - 1].t;
}
