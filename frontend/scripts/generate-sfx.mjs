// Genera los efectos de sonido de los minijuegos (WAV mono) en public/assets/audio/efectos.
// Son sonidos sinteticos propios, sin licencias de terceros. Uso: node scripts/generate-sfx.mjs
// Para cambiar uno basta con tocar su receta y volver a ejecutar el script (o sustituir el .wav por otro).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'audio', 'efectos');
const TAU = Math.PI * 2;

// Ruido con semilla: el mismo script genera siempre los mismos archivos.
let seed = 1234567;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const white = () => random() * 2 - 1;

const buffer = (seconds) => new Float32Array(Math.ceil(seconds * RATE));
const lerp = (from, to, amount) => from + (to - from) * amount;
const expLerp = (from, to, amount) => from * Math.pow(to / from, amount);
const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Envolvente con ataque lineal y caida exponencial. */
function env(t, attack, decay) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) / decay);
}

/** Filtro biquad (RBJ) con frecuencia variable en el tiempo. */
function biquad(type, q = 0.9) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (input, frequency) => {
    const w = (TAU * Math.min(frequency, RATE * 0.45)) / RATE;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    let b0, b1, b2;
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    } else {
      b0 = alpha; b1 = 0; b2 = -alpha;
    }
    const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
    const output = (b0 * input + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = input; y2 = y1; y1 = output;
    return output;
  };
}

/** Oscilador con frecuencia variable: devuelve la muestra para la frecuencia dada en cada paso. */
function oscillator(shape = 'sine') {
  let phase = 0;
  return (frequency) => {
    phase = (phase + frequency / RATE) % 1;
    switch (shape) {
      case 'triangle': return 1 - 4 * Math.abs(phase - 0.5);
      case 'square': return phase < 0.5 ? 0.7 : -0.7;
      case 'saw': return 2 * phase - 1;
      default: return Math.sin(phase * TAU);
    }
  };
}

/** Suma al buffer una capa de sonido que empieza en `start` segundos. */
function layer(out, start, seconds, sample) {
  const offset = Math.floor(start * RATE);
  const length = Math.min(Math.ceil(seconds * RATE), out.length - offset);
  for (let index = 0; index < length; index += 1) {
    out[offset + index] += sample(index / RATE, index / Math.max(1, length - 1));
  }
}

/** Golpe de ruido filtrado (pasos, choques, golpes de madera...). */
function noiseHit(out, start, { seconds, type = 'bandpass', from, to = from, q = 1, attack = 0.002, decay, gain }) {
  const filter = biquad(type, q);
  layer(out, start, seconds, (t, p) => filter(white(), expLerp(from, to, p)) * env(t, attack, decay) * gain);
}

/** Tono con barrido de frecuencia. */
function toneHit(out, start, { seconds, shape = 'sine', from, to = from, attack = 0.004, decay, gain, vibrato = 0, vibratoRate = 0 }) {
  const osc = oscillator(shape);
  layer(out, start, seconds, (t, p) => {
    const wobble = vibrato ? 1 + vibrato * Math.sin(TAU * vibratoRate * t) : 1;
    return osc(expLerp(from, to, p) * wobble) * env(t, attack, decay) * gain;
  });
}

/** Campanita metalica: parciales inarmonicos que se apagan. */
function bell(out, start, { frequency, seconds = 0.4, decay = 0.12, gain = 0.4, partials = [1, 2.76, 5.4] }) {
  partials.forEach((ratio, index) => toneHit(out, start, { seconds, from: frequency * ratio, decay: decay / (1 + index * 0.8), gain: gain / (1 + index * 1.4) }));
}

const SOUNDS = {
  // --- Interfaz -------------------------------------------------------------------------------
  // Pitido de los ultimos segundos de un contador (se reproduce mas agudo en los 3 ultimos).
  tic: () => {
    const out = buffer(0.2);
    toneHit(out, 0, { seconds: 0.18, from: 880, attack: 0.003, decay: 0.06, gain: 0.7 });
    toneHit(out, 0, { seconds: 0.12, shape: 'triangle', from: 1760, attack: 0.002, decay: 0.03, gain: 0.18 });
    return out;
  },
  // Click suave para cualquier boton de la interfaz.
  boton: () => {
    const out = buffer(0.09);
    toneHit(out, 0, { seconds: 0.08, shape: 'triangle', from: 1250, to: 820, attack: 0.002, decay: 0.022, gain: 0.55 });
    noiseHit(out, 0, { seconds: 0.012, type: 'highpass', from: 3500, decay: 0.003, gain: 0.25 });
    return out;
  },
  // Respuesta correcta (operaciones, pinturillo): dos campanitas que suben.
  acierto: () => {
    const out = buffer(0.6);
    bell(out, 0, { frequency: 1318, decay: 0.16, gain: 0.45 });
    bell(out, 0.09, { frequency: 1760, seconds: 0.5, decay: 0.24, gain: 0.45 });
    return out;
  },
  // Entregar un dibujo: papel que se desliza.
  entregar: () => {
    const out = buffer(0.32);
    noiseHit(out, 0, { seconds: 0.3, from: 700, to: 3200, q: 0.8, attack: 0.08, decay: 0.07, gain: 0.7 });
    return out;
  },
  // Votar: golpe de sello.
  voto: () => {
    const out = buffer(0.22);
    toneHit(out, 0, { seconds: 0.18, from: 190, to: 90, attack: 0.001, decay: 0.05, gain: 0.8 });
    noiseHit(out, 0, { seconds: 0.08, type: 'lowpass', from: 1800, decay: 0.015, gain: 0.6 });
    noiseHit(out, 0, { seconds: 0.02, type: 'highpass', from: 4000, decay: 0.004, gain: 0.25 });
    return out;
  },

  // --- Blackjack ------------------------------------------------------------------------------
  'carta-repartir': () => {
    const out = buffer(0.2);
    noiseHit(out, 0, { seconds: 0.15, from: 1400, to: 4200, q: 0.7, attack: 0.03, decay: 0.04, gain: 0.7 });
    noiseHit(out, 0.14, { seconds: 0.04, type: 'lowpass', from: 2400, decay: 0.008, gain: 0.5 });
    return out;
  },
  'carta-voltear': () => {
    const out = buffer(0.16);
    noiseHit(out, 0, { seconds: 0.05, from: 2600, to: 3600, q: 1.2, attack: 0.004, decay: 0.012, gain: 0.7 });
    noiseHit(out, 0.06, { seconds: 0.07, from: 3000, to: 1800, q: 1.2, attack: 0.004, decay: 0.018, gain: 0.6 });
    return out;
  },
  // Fichas de casino chocando.
  fichas: () => {
    const out = buffer(0.35);
    [0, 0.045, 0.085, 0.14, 0.19].forEach((start, index) => {
      bell(out, start, { frequency: 2900 + index * 260, seconds: 0.12, decay: 0.028, gain: 0.32 - index * 0.03, partials: [1, 1.48, 2.1] });
      noiseHit(out, start, { seconds: 0.02, type: 'highpass', from: 5000, decay: 0.004, gain: 0.25 });
    });
    return out;
  },

  // --- Barriles -------------------------------------------------------------------------------
  // Silbido de caida (dura lo que cae el barril) que se corta al frenarlo.
  'barril-cayendo': () => {
    const out = buffer(1.6);
    const osc = oscillator('sine');
    const rumble = biquad('lowpass', 0.7);
    layer(out, 0, 1.6, (t, p) => {
      const fade = clamp01(t / 0.08) * clamp01((1.6 - t) / 0.12);
      const whistle = osc(expLerp(1700, 520, p) * (1 + 0.012 * Math.sin(TAU * 7 * t))) * lerp(0.25, 0.5, p);
      const wind = rumble(white(), lerp(180, 420, p)) * lerp(0.3, 0.9, p);
      return (whistle + wind) * fade;
    });
    return out;
  },
  // Cuerda que frena en seco: friccion que chirria y tiron final.
  'cuerda-freno': () => {
    const out = buffer(0.5);
    const filter = biquad('bandpass', 2.2);
    layer(out, 0, 0.3, (t, p) => {
      const creak = 0.55 + 0.45 * Math.sign(Math.sin(TAU * lerp(55, 28, p) * t));
      return filter(white(), expLerp(1400, 500, p)) * creak * env(t, 0.005, 0.12) * 1.3;
    });
    toneHit(out, 0.22, { seconds: 0.25, from: 120, to: 70, attack: 0.002, decay: 0.07, gain: 0.7 });
    noiseHit(out, 0.22, { seconds: 0.06, type: 'lowpass', from: 1200, decay: 0.015, gain: 0.5 });
    return out;
  },
  // Barril que aplasta: golpe grave de madera.
  aplastar: () => {
    const out = buffer(0.6);
    toneHit(out, 0, { seconds: 0.55, from: 85, to: 38, attack: 0.002, decay: 0.16, gain: 0.95 });
    noiseHit(out, 0, { seconds: 0.4, type: 'lowpass', from: 900, to: 300, decay: 0.09, gain: 0.8 });
    noiseHit(out, 0.005, { seconds: 0.08, from: 1600, q: 1.5, decay: 0.02, gain: 0.6 });
    return out;
  },

  // --- Globo ----------------------------------------------------------------------------------
  // "Piu" que sube: en el juego se reproduce cada vez mas agudo segun se hincha el globo.
  'globo-inflar': () => {
    const out = buffer(0.34);
    toneHit(out, 0, { seconds: 0.3, shape: 'triangle', from: 320, to: 980, attack: 0.02, decay: 0.12, gain: 0.55 });
    toneHit(out, 0, { seconds: 0.3, from: 640, to: 1960, attack: 0.02, decay: 0.08, gain: 0.15 });
    noiseHit(out, 0, { seconds: 0.3, from: 1500, to: 3200, q: 1.1, attack: 0.05, decay: 0.08, gain: 0.35 });
    return out;
  },
  'globo-explotar': () => {
    const out = buffer(0.7);
    noiseHit(out, 0, { seconds: 0.5, type: 'lowpass', from: 7000, to: 600, attack: 0.001, decay: 0.07, gain: 1 });
    toneHit(out, 0, { seconds: 0.5, from: 110, to: 40, attack: 0.001, decay: 0.12, gain: 0.85 });
    noiseHit(out, 0.03, { seconds: 0.5, from: 2400, to: 800, q: 0.6, attack: 0.01, decay: 0.15, gain: 0.25 });
    return out;
  },
  // Palanca metalica: clac y trinquete.
  palanca: () => {
    const out = buffer(0.25);
    [0, 0.03, 0.06].forEach((start, index) => noiseHit(out, start, { seconds: 0.03, from: 3200 - index * 400, q: 3, decay: 0.006, gain: 0.45 }));
    toneHit(out, 0.08, { seconds: 0.15, from: 240, to: 180, attack: 0.001, decay: 0.035, gain: 0.55 });
    bell(out, 0.08, { frequency: 820, seconds: 0.15, decay: 0.04, gain: 0.2 });
    return out;
  },
  // Pasos al subir al escenario.
  pasos: () => {
    const out = buffer(0.75);
    [0, 0.22, 0.44].forEach((start, index) => {
      noiseHit(out, start, { seconds: 0.08, type: 'lowpass', from: index % 2 ? 900 : 700, decay: 0.022, gain: 0.8 });
      toneHit(out, start, { seconds: 0.06, from: index % 2 ? 130 : 110, decay: 0.02, gain: 0.35 });
    });
    return out;
  },

  // --- Cubiletes ------------------------------------------------------------------------------
  // Cubilete que se arrastra por el tapete (corto: suena en cada cambio).
  'cubilete-deslizar': () => {
    const out = buffer(0.14);
    noiseHit(out, 0, { seconds: 0.13, from: 500, to: 900, q: 0.8, attack: 0.02, decay: 0.035, gain: 0.55 });
    return out;
  },
  'cubilete-levantar': () => {
    const out = buffer(0.4);
    toneHit(out, 0, { seconds: 0.1, from: 620, to: 540, attack: 0.001, decay: 0.025, gain: 0.55 });
    toneHit(out, 0, { seconds: 0.1, from: 1010, attack: 0.001, decay: 0.015, gain: 0.25 });
    noiseHit(out, 0.02, { seconds: 0.35, from: 400, to: 1600, q: 0.7, attack: 0.1, decay: 0.08, gain: 0.35 });
    return out;
  },
  'bola-rodar': () => {
    const out = buffer(0.95);
    const filter = biquad('lowpass', 0.8);
    layer(out, 0, 0.9, (t, p) => {
      const roll = 0.6 + 0.4 * Math.sin(TAU * lerp(26, 12, p) * t);
      return filter(white(), lerp(700, 380, p)) * roll * clamp01(t / 0.06) * (1 - p) * 1.4;
    });
    toneHit(out, 0.86, { seconds: 0.06, from: 1400, decay: 0.012, gain: 0.25 });
    return out;
  },

  // --- Coches ---------------------------------------------------------------------------------
  // Salto al elegir carril: "boing" corto y simpatico.
  'salto-carril': () => {
    const out = buffer(0.32);
    toneHit(out, 0, { seconds: 0.3, from: 260, to: 720, attack: 0.004, decay: 0.09, gain: 0.6, vibrato: 0.06, vibratoRate: 22 });
    noiseHit(out, 0, { seconds: 0.12, from: 800, to: 2400, attack: 0.02, decay: 0.03, gain: 0.25 });
    return out;
  },
  // Atropello: golpe de chapa.
  atropello: () => {
    const out = buffer(0.8);
    toneHit(out, 0, { seconds: 0.4, from: 90, to: 45, attack: 0.001, decay: 0.1, gain: 0.85 });
    noiseHit(out, 0, { seconds: 0.5, from: 3200, to: 1200, q: 0.7, attack: 0.001, decay: 0.09, gain: 0.7 });
    bell(out, 0.01, { frequency: 640, seconds: 0.7, decay: 0.2, gain: 0.25, partials: [1, 1.71, 2.63, 3.9] });
    return out;
  },

  // --- Desenfundar ----------------------------------------------------------------------------
  // Disparo de revolver: chasquido seco, golpe grave y eco que se pierde por la calle.
  disparo: () => {
    const out = buffer(0.9);
    noiseHit(out, 0, { seconds: 0.06, type: 'highpass', from: 2500, attack: 0.0005, decay: 0.012, gain: 1 });
    noiseHit(out, 0, { seconds: 0.3, type: 'lowpass', from: 3000, to: 500, attack: 0.001, decay: 0.05, gain: 0.9 });
    toneHit(out, 0, { seconds: 0.25, from: 110, to: 45, attack: 0.001, decay: 0.06, gain: 0.8 });
    noiseHit(out, 0.09, { seconds: 0.8, type: 'lowpass', from: 1400, to: 300, attack: 0.03, decay: 0.22, gain: 0.25 });
    return out;
  },

  // --- ¿Cuantos hay? --------------------------------------------------------------------------
  // Timbre de bici: dos "ring" metalicos.
  timbre: () => {
    const out = buffer(0.6);
    bell(out, 0, { frequency: 2300, seconds: 0.3, decay: 0.08, gain: 0.4, partials: [1, 1.5, 2.4] });
    bell(out, 0.14, { frequency: 2300, seconds: 0.45, decay: 0.12, gain: 0.4, partials: [1, 1.5, 2.4] });
    return out;
  },

  // --- Jarras en la barra ---------------------------------------------------------------------
  // Jarra que se rompe contra el suelo: golpe y tintineo de cristales.
  cristal: () => {
    const out = buffer(0.9);
    noiseHit(out, 0, { seconds: 0.25, type: 'highpass', from: 3000, attack: 0.001, decay: 0.05, gain: 0.8 });
    toneHit(out, 0, { seconds: 0.15, from: 160, to: 80, attack: 0.001, decay: 0.04, gain: 0.6 });
    [0.02, 0.07, 0.11, 0.18, 0.26, 0.35].forEach((start, index) =>
      bell(out, start, { frequency: 3200 + ((index * 977) % 2400), seconds: 0.35, decay: 0.06, gain: 0.3 - index * 0.03, partials: [1, 1.63, 2.71] }),
    );
    return out;
  },
  // Jarra deslizandose por la madera de la barra.
  deslizar: () => {
    const out = buffer(1.2);
    const filter = biquad('bandpass', 0.9);
    layer(out, 0, 1.2, (t, p) => filter(white(), lerp(900, 380, p)) * clamp01(t / 0.05) * Math.pow(1 - p, 1.6) * 1.2);
    return out;
  },

  // --- Corta verduras -------------------------------------------------------------------------
  // Cuchillo contra la tabla: "toc" seco de madera.
  corte: () => {
    const out = buffer(0.12);
    noiseHit(out, 0, { seconds: 0.05, type: 'highpass', from: 2400, attack: 0.0005, decay: 0.008, gain: 0.5 });
    toneHit(out, 0, { seconds: 0.1, from: 420, to: 260, attack: 0.001, decay: 0.022, gain: 0.7 });
    noiseHit(out, 0, { seconds: 0.08, type: 'lowpass', from: 1200, decay: 0.018, gain: 0.5 });
    return out;
  },

  // --- Salto con cuerda -----------------------------------------------------------------------
  // Grito de "¡yuju!" sintetico: un silbido que sube y baja (al soltarse).
  yuju: () => {
    const out = buffer(0.7);
    const osc = oscillator('triangle');
    layer(out, 0, 0.65, (t, p) => osc(p < 0.45 ? expLerp(420, 980, p / 0.45) : expLerp(980, 620, (p - 0.45) / 0.55)) * env(t, 0.02, 0.3) * 0.6);
    noiseHit(out, 0, { seconds: 0.6, from: 800, to: 2400, q: 0.7, attack: 0.1, decay: 0.2, gain: 0.25 });
    return out;
  },

  // --- Bolos ----------------------------------------------------------------------------------
  // Bola contra los bolos: golpe grave y repiqueteo de madera de los bolos chocando.
  bolos: () => {
    const out = buffer(1.1);
    toneHit(out, 0, { seconds: 0.3, from: 120, to: 70, attack: 0.001, decay: 0.08, gain: 0.8 });
    [0, 0.03, 0.07, 0.1, 0.15, 0.19, 0.26, 0.33, 0.42, 0.55].forEach((start, index) => {
      toneHit(out, start, { seconds: 0.09, from: 700 + ((index * 337) % 500), to: 520, attack: 0.001, decay: 0.025, gain: 0.5 - index * 0.035 });
      noiseHit(out, start, { seconds: 0.05, from: 1800 + ((index * 211) % 900), q: 2, decay: 0.012, gain: 0.35 - index * 0.025 });
    });
    return out;
  },

  // --- Cruza la carretera ---------------------------------------------------------------------
  // Saltito de gallina: "co" corto con un poco de aire.
  cacareo: () => {
    const out = buffer(0.16);
    const osc = oscillator('square');
    const formant = biquad('bandpass', 2.5);
    layer(out, 0, 0.14, (t, p) => formant(osc(expLerp(520, 380, p)), lerp(1400, 900, p)) * env(t, 0.004, 0.04) * 1.4);
    noiseHit(out, 0, { seconds: 0.05, from: 1800, q: 1.2, decay: 0.012, gain: 0.2 });
    return out;
  },
  // Campana del paso a nivel: "ding ding" metalico.
  'campana-tren': () => {
    const out = buffer(0.75);
    [0, 0.28].forEach((start) => bell(out, start, { frequency: 1180, seconds: 0.45, decay: 0.1, gain: 0.45, partials: [1, 2.4, 3.9] }));
    return out;
  },
  // Tren que arrolla: bocina grave y estruendo de ruedas.
  tren: () => {
    const out = buffer(1.1);
    [196, 247, 294].forEach((frequency) => toneHit(out, 0, { seconds: 0.9, shape: 'saw', from: frequency, to: frequency * 0.94, attack: 0.02, decay: 0.45, gain: 0.22 }));
    noiseHit(out, 0, { seconds: 1, type: 'lowpass', from: 900, to: 250, attack: 0.01, decay: 0.35, gain: 0.8 });
    toneHit(out, 0, { seconds: 0.35, from: 90, to: 45, attack: 0.001, decay: 0.09, gain: 0.7 });
    return out;
  },

  // --- Tiro de jabalina -----------------------------------------------------------------------
  // Lanzamiento: zumbido de aire que se aleja.
  lanzar: () => {
    const out = buffer(0.5);
    noiseHit(out, 0, { seconds: 0.48, from: 2600, to: 700, q: 1.1, attack: 0.03, decay: 0.14, gain: 0.8 });
    toneHit(out, 0, { seconds: 0.12, from: 160, to: 110, attack: 0.002, decay: 0.03, gain: 0.35 });
    return out;
  },
  // Jabalina que se clava en la tierra: golpe seco y vibracion de la vara.
  clavar: () => {
    const out = buffer(0.55);
    toneHit(out, 0, { seconds: 0.18, from: 140, to: 70, attack: 0.001, decay: 0.04, gain: 0.8 });
    noiseHit(out, 0, { seconds: 0.08, type: 'lowpass', from: 1500, decay: 0.018, gain: 0.7 });
    toneHit(out, 0.01, { seconds: 0.5, shape: 'triangle', from: 210, attack: 0.002, decay: 0.16, gain: 0.3, vibrato: 0.08, vibratoRate: 28 });
    return out;
  },

  // --- Empujar --------------------------------------------------------------------------------
  // Dos fichas que chocan: "toc" de goma dura con un poco de rebote.
  rebote: () => {
    const out = buffer(0.18);
    toneHit(out, 0, { seconds: 0.15, from: 380, to: 220, attack: 0.001, decay: 0.035, gain: 0.8 });
    noiseHit(out, 0, { seconds: 0.04, type: 'lowpass', from: 2400, decay: 0.008, gain: 0.5 });
    toneHit(out, 0.002, { seconds: 0.1, shape: 'triangle', from: 900, to: 700, attack: 0.001, decay: 0.02, gain: 0.25 });
    return out;
  },
  // Caida al agua: "plof" grave y salpicadura que se apaga.
  chapuzon: () => {
    const out = buffer(1.1);
    toneHit(out, 0, { seconds: 0.35, from: 260, to: 70, attack: 0.002, decay: 0.09, gain: 0.8 });
    noiseHit(out, 0.01, { seconds: 0.9, type: 'lowpass', from: 4200, to: 600, attack: 0.01, decay: 0.22, gain: 0.8 });
    [0.12, 0.2, 0.31, 0.42].forEach((start, index) => toneHit(out, start, { seconds: 0.08, from: 900 + index * 230, to: 1500 + index * 200, attack: 0.002, decay: 0.02, gain: 0.25 }));
    return out;
  },

  // --- Ruleta rusa ----------------------------------------------------------------------------
  // Disparo en vacio: "clic" metalico seco y pequeno eco.
  clic: () => {
    const out = buffer(0.35);
    noiseHit(out, 0, { seconds: 0.03, type: 'highpass', from: 3800, attack: 0.0005, decay: 0.005, gain: 0.9 });
    bell(out, 0, { frequency: 2600, seconds: 0.12, decay: 0.025, gain: 0.35, partials: [1, 1.9, 3.1] });
    toneHit(out, 0.002, { seconds: 0.06, from: 900, to: 600, attack: 0.001, decay: 0.012, gain: 0.35 });
    noiseHit(out, 0.06, { seconds: 0.2, type: 'highpass', from: 2400, attack: 0.002, decay: 0.05, gain: 0.08 });
    return out;
  },
  // Tambor que gira una recamara: trinquete rapido.
  tambor: () => {
    const out = buffer(0.32);
    [0, 0.045, 0.09, 0.13, 0.17].forEach((start, index) => {
      noiseHit(out, start, { seconds: 0.025, from: 3000 + index * 150, q: 3, decay: 0.005, gain: 0.55 - index * 0.06 });
      bell(out, start, { frequency: 1800 + index * 90, seconds: 0.05, decay: 0.012, gain: 0.12, partials: [1, 2.3] });
    });
    return out;
  },
  // Percutor que se monta hacia atras.
  martillo: () => {
    const out = buffer(0.2);
    noiseHit(out, 0, { seconds: 0.03, from: 2200, q: 2.5, decay: 0.006, gain: 0.6 });
    noiseHit(out, 0.07, { seconds: 0.04, from: 3200, q: 3, decay: 0.008, gain: 0.75 });
    bell(out, 0.07, { frequency: 2100, seconds: 0.08, decay: 0.018, gain: 0.18, partials: [1, 2.7] });
    return out;
  },
  // Bala nueva que entra en su recamara: deslizamiento metalico y "clac" al encajar, con un brillo agudo.
  bala: () => {
    const out = buffer(0.55);
    noiseHit(out, 0, { seconds: 0.16, from: 1800, to: 4200, q: 1.4, attack: 0.03, decay: 0.05, gain: 0.45 });
    noiseHit(out, 0.17, { seconds: 0.05, type: 'lowpass', from: 2600, decay: 0.01, gain: 0.8 });
    toneHit(out, 0.17, { seconds: 0.12, from: 420, to: 300, attack: 0.001, decay: 0.03, gain: 0.5 });
    bell(out, 0.17, { frequency: 2900, seconds: 0.35, decay: 0.09, gain: 0.3, partials: [1, 1.52, 2.4] });
    return out;
  },
  // Recarga: balas que entran en el tambor y el tambor que se cierra.
  recarga: () => {
    const out = buffer(1.1);
    [0, 0.22, 0.44].forEach((start) => {
      bell(out, start, { frequency: 3100, seconds: 0.1, decay: 0.02, gain: 0.25, partials: [1, 1.6] });
      noiseHit(out, start, { seconds: 0.03, from: 2800, q: 2, decay: 0.006, gain: 0.4 });
    });
    noiseHit(out, 0.7, { seconds: 0.25, from: 2600, to: 1800, q: 2, attack: 0.01, decay: 0.05, gain: 0.45 });
    noiseHit(out, 0.92, { seconds: 0.05, type: 'lowpass', from: 2000, decay: 0.01, gain: 0.7 });
    toneHit(out, 0.92, { seconds: 0.1, from: 320, to: 220, attack: 0.001, decay: 0.03, gain: 0.4 });
    return out;
  },

  // --- Pogo -----------------------------------------------------------------------------------
  muelle: () => {
    const out = buffer(0.45);
    const osc = oscillator('sine');
    layer(out, 0, 0.42, (t) => osc(430 * (1 + 0.4 * Math.exp(-7 * t) * Math.sin(TAU * 16 * t))) * env(t, 0.003, 0.12) * 0.7);
    noiseHit(out, 0, { seconds: 0.03, type: 'lowpass', from: 1200, decay: 0.008, gain: 0.4 });
    return out;
  },

  // --- Patata caliente ------------------------------------------------------------------------
  // Explosion: estallido, golpe muy grave y estruendo que se apaga con cascotes cayendo.
  explosion: () => {
    const out = buffer(2.2);
    noiseHit(out, 0, { seconds: 0.12, type: 'highpass', from: 1800, attack: 0.0005, decay: 0.03, gain: 1 });
    toneHit(out, 0, { seconds: 0.9, from: 75, to: 28, attack: 0.002, decay: 0.28, gain: 1 });
    noiseHit(out, 0, { seconds: 2.1, type: 'lowpass', from: 2600, to: 160, q: 0.7, attack: 0.004, decay: 0.55, gain: 1 });
    [0.35, 0.52, 0.7, 0.95, 1.2].forEach((start, index) =>
      noiseHit(out, start, { seconds: 0.08, type: 'lowpass', from: 1600 - index * 150, decay: 0.02, gain: 0.25 - index * 0.03 }),
    );
    return out;
  },
  // Mecha encendida: chisporroteo corto (se repite mientras alguien tiene la bomba).
  mecha: () => {
    const out = buffer(0.7);
    const filter = biquad('highpass', 0.8);
    layer(out, 0, 0.7, (t, p) => filter(white() * (random() < 0.08 ? 2.4 : 0.6), 4200) * clamp01(t / 0.03) * clamp01((1 - p) / 0.1) * 0.5);
    return out;
  },
  // Palabra no valida: zumbido grave doble.
  error: () => {
    const out = buffer(0.42);
    [0, 0.2].forEach((start) => toneHit(out, start, { seconds: 0.16, shape: 'square', from: 170, to: 150, attack: 0.003, decay: 0.08, gain: 0.45 }));
    return out;
  },
  // La bomba cae en las manos: golpe blando.
  atrapar: () => {
    const out = buffer(0.2);
    toneHit(out, 0, { seconds: 0.16, from: 210, to: 120, attack: 0.001, decay: 0.04, gain: 0.8 });
    noiseHit(out, 0, { seconds: 0.06, type: 'lowpass', from: 1400, decay: 0.015, gain: 0.5 });
    return out;
  },

  // --- Canon ----------------------------------------------------------------------------------
  // Canonazo: golpe seco muy grave y bocanada de humo.
  canonazo: () => {
    const out = buffer(1.4);
    noiseHit(out, 0, { seconds: 0.05, type: 'highpass', from: 2200, attack: 0.0005, decay: 0.01, gain: 0.9 });
    toneHit(out, 0, { seconds: 0.6, from: 95, to: 32, attack: 0.001, decay: 0.16, gain: 1 });
    noiseHit(out, 0, { seconds: 1.3, type: 'lowpass', from: 1800, to: 200, attack: 0.003, decay: 0.32, gain: 0.85 });
    return out;
  },
  // Bala de canon cortando el aire: silbido que baja.
  silbido: () => {
    const out = buffer(0.9);
    const osc = oscillator('sine');
    layer(out, 0, 0.88, (t, p) => osc(expLerp(1500, 520, p)) * clamp01(t / 0.08) * clamp01((1 - p) / 0.15) * 0.45);
    noiseHit(out, 0, { seconds: 0.85, from: 3000, to: 900, q: 1.5, attack: 0.1, decay: 0.4, gain: 0.3 });
    return out;
  },
};

function toWav(samples) {
  // Normaliza el pico a -1 dB para que todos suenen con un nivel parecido.
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0) || 1;
  const scale = 0.89 / peak;
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * scale)) * 32767), index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

mkdirSync(OUT_DIR, { recursive: true });

for (const [name, recipe] of Object.entries(SOUNDS)) {
  const file = join(OUT_DIR, `${name}.wav`);
  writeFileSync(file, toWav(recipe()));
  console.log(`efectos/${name}.wav`);
}
