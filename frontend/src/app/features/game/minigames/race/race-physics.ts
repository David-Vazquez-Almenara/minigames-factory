// Fisica sencilla de los coches de la Carrera (vista desde arriba): acelerar, frenar, girar con algo de inercia
// (la velocidad tarda un poco en seguir al morro: un pelin de derrape), cesped mas lento, barandillas en los
// puentes y conteo de vueltas siguiendo la linea central (sin saltar de tramo en los cruces).
import { RACE_LAPS, Track, distanceToCenter, trackIndexNear } from './race-tracks';

export const CAR = {
  maxRoad: 640,
  maxGrass: 230,
  accel: 360,
  brake: 950,
  reverse: 180,
  drag: 160,
  steer: 2.5,
  gripRoad: 7,
  gripGrass: 3.4,
  /** Fuera de la pista (lejos) durante este tiempo: vuelve a la carretera. */
  respawnAfterMs: 3000,
  length: 46,
  width: 26,
};

export interface CarInput {
  throttle: boolean;
  brake: boolean;
  /** -1 izquierda, 0 recto, 1 derecha. */
  steer: number;
}

export interface CarState {
  x: number;
  y: number;
  /** Hacia donde mira el morro (radianes, 0 = +x). */
  angle: number;
  /** Velocidad hacia delante (negativa marcha atras). */
  speed: number;
  vx: number;
  vy: number;
  /** Punto de la linea central que sigue. */
  index: number;
  /** Vueltas completadas (-1 en la parrilla, que esta detras de la meta). */
  lap: number;
  /** Siguiente punto de control de la vuelta (track.checkpoints.length: todos pasados, ya puede cruzar la meta). */
  checkpoint: number;
  offRoadMs: number;
  onRoad: boolean;
  finished: boolean;
}

export function createCar(track: Track, x: number, y: number, angle: number, index: number): CarState {
  return { x, y, angle, speed: 0, vx: 0, vy: 0, index, lap: -1, checkpoint: 0, offRoadMs: 0, onRoad: true, finished: false };
}

/**
 * Lo recorrido en total (vueltas * largo + punto de la vuelta actual), sin pasar del siguiente punto de control:
 * atajar o saltarse uno no adelanta a nadie.
 */
export function carProgress(track: Track, car: CarState): number {
  const distance = track.distances[car.index];

  if (car.lap < 0 || car.checkpoint >= track.checkpoints.length) {
    return car.lap * track.length + distance;
  }

  return car.lap * track.length + Math.min(distance, track.distances[track.checkpoints[car.checkpoint]]);
}

export interface StepEvents {
  lap?: number;
  finished?: boolean;
  respawned?: boolean;
  rail?: boolean;
  /** Punto de control pasado (su numero, desde 0). */
  checkpoint?: number;
  /** Ha cruzado un punto de control que no tocaba (se ha saltado el que indica). */
  missedCheckpoint?: number;
  /** Ha cruzado la meta sin pasar por todos los puntos de control: la vuelta no cuenta. */
  lapRejected?: boolean;
  wrongWay: boolean;
}

/** El coche cuenta como dentro del punto de control si alguna parte de el pasa por el arco (sobre la carretera). */
function insideGate(track: Track, car: CarState): boolean {
  return distanceToCenter(track, car.x, car.y, car.index) <= track.width / 2 + CAR.width / 2;
}

/** Avanza el coche `dt` segundos. */
export function stepCar(track: Track, car: CarState, input: CarInput, dt: number): StepEvents {
  const events: StepEvents = { wrongWay: false };
  const n = track.xs.length;
  const half = track.width / 2;
  const distance = distanceToCenter(track, car.x, car.y, car.index);
  car.onRoad = distance <= half;
  const maxSpeed = car.onRoad ? CAR.maxRoad : CAR.maxGrass;

  if (input.throttle && !car.finished) {
    car.speed += (car.speed < 0 ? CAR.brake : CAR.accel * (car.onRoad ? 1 : 0.6)) * dt;
  } else if (input.brake && !car.finished) {
    car.speed -= (car.speed > 0 ? CAR.brake : CAR.accel * 0.6) * dt;
  } else {
    // Sin pedales se para poco a poco.
    const drag = CAR.drag * dt * (car.onRoad ? 1 : 2.2);
    car.speed = Math.abs(car.speed) <= drag ? 0 : car.speed - Math.sign(car.speed) * drag;
  }

  // Pasado el maximo (p. ej. al entrar en el cesped) frena rapido, sin pararse de golpe.
  if (car.speed > maxSpeed) {
    car.speed = Math.max(maxSpeed, car.speed - 900 * dt);
  }

  car.speed = Math.max(-CAR.reverse, car.speed);
  // Giro: hace falta velocidad para girar, y a tope gira algo menos.
  const speedFactor = Math.min(1, Math.abs(car.speed) / 180) * (1 - 0.35 * Math.min(1, Math.abs(car.speed) / CAR.maxRoad));
  car.angle += input.steer * CAR.steer * speedFactor * Math.sign(car.speed || 1) * dt;
  // La velocidad real sigue al morro con algo de retraso (agarre): un poquito de derrape.
  const grip = Math.min(1, (car.onRoad ? CAR.gripRoad : CAR.gripGrass) * dt);
  car.vx += (Math.cos(car.angle) * car.speed - car.vx) * grip;
  car.vy += (Math.sin(car.angle) * car.speed - car.vy) * grip;
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  // Sigue su tramo de la linea central (con mas margen hacia delante si se ha ido lejos).
  const previous = car.index;
  car.index = trackIndexNear(track, car.x, car.y, car.index, 30, distance > track.width ? 150 : 60);

  // Puente: barandillas a los lados (no se puede salir de el).
  if (track.upper[car.index]) {
    const offset = distanceToCenter(track, car.x, car.y, car.index);

    if (offset > half - CAR.width / 2) {
      const angle = track.angles[car.index];
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      // Coordenadas respecto al centro: a lo largo (se conserva) y de lado (se limita al borde).
      const dx = car.x - track.xs[car.index];
      const dy = car.y - track.ys[car.index];
      const side = dx * nx + dy * ny;
      const forward = dx * Math.cos(angle) + dy * Math.sin(angle);
      const limit = half - CAR.width / 2;
      car.x = track.xs[car.index] + nx * Math.sign(side) * limit + Math.cos(angle) * forward;
      car.y = track.ys[car.index] + ny * Math.sign(side) * limit + Math.sin(angle) * forward;
      // Pierde la velocidad hacia el lado y algo de la de delante.
      const lateral = car.vx * nx + car.vy * ny;
      car.vx -= nx * lateral;
      car.vy -= ny * lateral;
      car.speed *= 0.97;
      events.rail = true;
    }
  }

  // Vueltas: pasar del final al principio de la linea (hacia delante) es cruzar la meta.
  const wrapped = previous > n * 0.9 && car.index < n * 0.1 ? 1 : previous < n * 0.1 && car.index > n * 0.9 ? -1 : 0;
  const total = track.checkpoints.length;

  if (!wrapped && car.index > previous && car.lap >= 0) {
    // Puntos de control cruzados en este paso (hacia delante): solo vale el que toca y pasando por la carretera.
    for (let k = 0; k < total; k += 1) {
      const at = track.checkpoints[k];

      if (previous < at && car.index >= at) {
        if (k === car.checkpoint && insideGate(track, car)) {
          car.checkpoint += 1;
          events.checkpoint = k;
        } else if (k > car.checkpoint) {
          events.missedCheckpoint = car.checkpoint;
        }
      }
    }
  }

  if (wrapped > 0) {
    // Desde la parrilla la primera vez no hace falta nada; despues, hay que haber pasado todos en orden.
    if (car.lap < 0 || car.checkpoint >= total) {
      car.lap += 1;
      car.checkpoint = 0;

      if (car.lap >= RACE_LAPS && !car.finished) {
        car.finished = true;
        events.finished = true;
      } else {
        events.lap = car.lap;
      }
    } else {
      events.lapRejected = true;
    }
  } else if (wrapped < 0 && car.checkpoint === 0) {
    // Marcha atras por la meta: vuelve a la vuelta anterior (que ya tenia todos sus puntos de control).
    car.lap -= 1;
    car.checkpoint = car.lap < 0 ? 0 : total;
  }

  // Sentido contrario: avanzando hacia atras respecto a la carretera.
  const along = car.vx * Math.cos(track.angles[car.index]) + car.vy * Math.sin(track.angles[car.index]);
  events.wrongWay = along < -60;

  // Muy lejos de la pista un buen rato: vuelve a la carretera (parado y mirando hacia delante).
  const far = distanceToCenter(track, car.x, car.y, car.index) > track.width * 1.3;
  car.offRoadMs = far ? car.offRoadMs + dt * 1000 : 0;

  if (car.offRoadMs >= CAR.respawnAfterMs) {
    car.x = track.xs[car.index];
    car.y = track.ys[car.index];
    car.angle = track.angles[car.index];
    car.speed = 0;
    car.vx = 0;
    car.vy = 0;
    car.offRoadMs = 0;
    events.respawned = true;
  }

  return events;
}
