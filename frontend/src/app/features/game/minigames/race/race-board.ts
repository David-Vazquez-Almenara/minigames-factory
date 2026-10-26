import { CAR } from './race-physics';
import { Surface, Track } from './race-tracks';

// Unidades del mundo que se ven en vertical (el coche va abajo, centrado, y se ve la carretera por delante).
const VIEW_HEIGHT = 820;
const CAR_Y = 0.7;

export interface BoardCar {
  playerId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  angle: number;
  mine: boolean;
  /** Va por encima de un puente (se dibuja por encima de el). */
  upper: boolean;
  /** Ya ha terminado (se ve medio transparente). */
  finished: boolean;
}

interface SurfaceStyle {
  edge: string;
  road: string;
  marks: string;
}

const SURFACES: Record<Surface, SurfaceStyle> = {
  dirt: { edge: '#6e4a26', road: '#b98a52', marks: 'rgba(90, 60, 30, 0.35)' },
  asphalt: { edge: '#2f3237', road: '#5d6168', marks: 'rgba(255, 255, 255, 0.85)' },
  clay: { edge: '#7c3a1c', road: '#c46a3c', marks: 'rgba(110, 45, 20, 0.35)' },
};

/** Numero pseudoaleatorio estable (el mismo decorado en todas las pantallas). */
function noise(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

export class RaceBoard {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly center: Path2D;
  private readonly offsets: Path2D[];
  private readonly bridgeDecks: Path2D[];
  private readonly bridgeShadows: Path2D[];
  private readonly decor: Array<{ x: number; y: number; kind: 'tree' | 'bush' | 'rock'; size: number; tint: number }> = [];
  private readonly grass: CanvasPattern | null;
  private readonly style: SurfaceStyle;
  private width = 1;
  private height = 1;
  private camera = { x: 0, y: 0, angle: 0, ready: false };
  private miniTransform = { scale: 1, x: 0, y: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly track: Track,
  ) {
    this.context = canvas.getContext('2d')!;
    this.style = SURFACES[track.definition.surface];
    const n = track.xs.length;
    // Linea central completa y las lineas paralelas (bordes, rodadas) como trazados ya preparados.
    this.center = this.polyline(0, n, 0, true);
    const w = track.width;
    this.offsets = track.definition.surface === 'asphalt' ? [this.polyline(0, n, w / 2 - 9, true), this.polyline(0, n, -(w / 2 - 9), true)] : [this.polyline(0, n, w * 0.22, true), this.polyline(0, n, -w * 0.22, true)];
    this.bridgeDecks = track.bridges.map((bridge) => this.polyline(bridge.from, bridge.to, 0, false));
    this.bridgeShadows = track.bridges.map((bridge) => this.polyline(bridge.from, bridge.to, 0, false));
    this.grass = this.grassPattern();
    this.placeDecor();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  setAvatar(playerId: string, url: string): void {
    if (url && !this.images.has(playerId)) {
      const image = new Image();
      image.src = url;
      this.images.set(playerId, image);
    }
  }

  dispose(): void {
    this.resizeObserver.disconnect();
  }

  /* ------------------------------- Preparacion ------------------------------ */

  /** Trazado de la linea central (o paralela, a `offset` unidades a la izquierda) entre dos indices. */
  private polyline(from: number, to: number, offset: number, closed: boolean): Path2D {
    const { xs, ys, angles } = this.track;
    const n = xs.length;
    const path = new Path2D();
    const count = closed ? n : (to - from + n) % n;

    for (let step = 0; step <= count; step += 1) {
      const index = (from + step) % n;
      const x = xs[index] - Math.sin(angles[index]) * offset;
      const y = ys[index] + Math.cos(angles[index]) * offset;

      if (step === 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }

    if (closed) {
      path.closePath();
    }

    return path;
  }

  /** Cesped con manchas de distintos verdes (patron que se repite y se mueve con el mundo). */
  private grassPattern(): CanvasPattern | null {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#6cbf4a';
    context.fillRect(0, 0, 256, 256);

    for (let index = 0; index < 260; index += 1) {
      context.fillStyle = noise(index) > 0.5 ? 'rgba(85, 160, 55, 0.55)' : 'rgba(140, 210, 100, 0.45)';
      const x = noise(index * 3.1) * 256;
      const y = noise(index * 7.7) * 256;
      const r = 2 + noise(index * 1.7) * 6;
      context.beginPath();
      context.ellipse(x, y, r, r * 0.6, noise(index) * Math.PI, 0, Math.PI * 2);
      context.fill();
    }

    return this.context.createPattern(canvas, 'repeat');
  }

  /** Arboles, arbustos y piedras repartidos fuera de la carretera (siempre en el mismo sitio). */
  private placeDecor(): void {
    const { minX, minY, maxX, maxY } = this.track.bounds;
    const margin = 900;
    const clearance = this.track.width / 2 + 70;
    const cell = 260;

    for (let gx = minX - margin; gx < maxX + margin; gx += cell) {
      for (let gy = minY - margin; gy < maxY + margin; gy += cell) {
        const seed = gx * 0.13 + gy * 7.31;

        if (noise(seed) < 0.45) {
          continue;
        }

        const x = gx + noise(seed + 1) * cell;
        const y = gy + noise(seed + 2) * cell;
        let near = Infinity;

        for (let index = 0; index < this.track.xs.length; index += 4) {
          near = Math.min(near, (this.track.xs[index] - x) ** 2 + (this.track.ys[index] - y) ** 2);
        }

        if (Math.sqrt(near) < clearance) {
          continue;
        }

        const roll = noise(seed + 3);
        this.decor.push({ x, y, kind: roll < 0.55 ? 'tree' : roll < 0.85 ? 'bush' : 'rock', size: 0.7 + noise(seed + 4) * 0.7, tint: noise(seed + 5) });
      }
    }
  }

  /* --------------------------------- Dibujo --------------------------------- */

  /**
   * Dibuja el mundo visto desde detras del coche que sigue la camara (con el morro siempre hacia arriba).
   * `gates`: siguiente punto de control de ese coche (null: se pintan todos iguales) y si hay que senalar hacia el
   * (cuando se lo ha saltado).
   */
  draw(cars: BoardCar[], follow: { x: number; y: number; angle: number }, dt: number, gates: { next: number | null; guide: boolean } = { next: null, guide: false }): void {
    const context = this.context;
    const ratio = window.devicePixelRatio || 1;
    const camera = this.camera;

    if (!camera.ready) {
      Object.assign(camera, { x: follow.x, y: follow.y, angle: follow.angle, ready: true });
    }

    // La camara sigue con suavidad (sobre todo el giro, para que no maree).
    const ease = Math.min(1, dt * 10);
    camera.x += (follow.x - camera.x) * ease;
    camera.y += (follow.y - camera.y) * ease;
    let turn = follow.angle - camera.angle;
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    camera.angle += turn * Math.min(1, dt * 6);

    const scale = Math.min(this.height / VIEW_HEIGHT, this.width / (VIEW_HEIGHT * 0.62)) * 1.0;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.translate(this.width / 2, this.height * CAR_Y);
    context.rotate(-camera.angle - Math.PI / 2);
    context.scale(scale, scale);
    context.translate(-camera.x, -camera.y);
    const view = Math.hypot(this.width, this.height) / scale;

    // Cesped.
    context.fillStyle = this.grass || '#6cbf4a';
    context.fillRect(camera.x - view, camera.y - view, view * 2, view * 2);

    // Carretera: borde, firme, marcas y linea de meta.
    this.drawRoad(context, this.center, this.offsets, true);
    this.drawStart(context);
    this.drawGates(context, gates.next, 'ground');

    for (const car of cars.filter((item) => !item.upper)) {
      this.drawCar(context, car);
    }

    // Puentes encima (con su sombra y barandillas) y los coches que van por ellos.
    this.track.bridges.forEach((_bridge, index) => {
      context.save();
      context.translate(14, 18);
      context.strokeStyle = 'rgba(0, 0, 0, 0.3)';
      context.lineWidth = this.track.width + 30;
      context.lineCap = 'butt';
      context.stroke(this.bridgeShadows[index]);
      context.restore();
      context.lineCap = 'butt';
      context.lineJoin = 'round';
      context.strokeStyle = '#d9d9d9';
      context.lineWidth = this.track.width + 34;
      context.stroke(this.bridgeDecks[index]);
      context.strokeStyle = '#4a4a4a';
      context.lineWidth = this.track.width + 18;
      context.stroke(this.bridgeDecks[index]);
      this.drawRoad(context, this.bridgeDecks[index], [], false);
    });

    for (const car of cars.filter((item) => item.upper)) {
      this.drawCar(context, car);
    }

    // Arcos de los puntos de control (por encima de los coches que pasan por debajo).
    this.drawGates(context, gates.next, 'arch');

    // Decorado por encima (las copas tapan si se pasa por debajo).
    for (const item of this.decor) {
      if (Math.abs(item.x - camera.x) < view && Math.abs(item.y - camera.y) < view) {
        this.drawDecor(context, item);
      }
    }

    // Nombres en pantalla (sin girar con el mundo).
    const matrix = context.getTransform();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    for (const car of cars) {
      if (car.mine) {
        continue;
      }

      const point = matrix.transformPoint(new DOMPoint(car.x, car.y));
      this.drawTag(context, car, point.x / ratio, point.y / ratio - 34);
    }

    // Numero de cada punto de control, siempre derecho.
    const { xs, ys, checkpoints } = this.track;
    checkpoints.forEach((at, k) => {
      const point = matrix.transformPoint(new DOMPoint(xs[at], ys[at]));
      this.drawGateNumber(context, k, this.gateState(k, gates.next), point.x / ratio, point.y / ratio);
    });

    // Saltado: una flecha encima del coche apunta hacia el punto de control que falta.
    if (gates.guide && gates.next !== null && gates.next < checkpoints.length) {
      const at = checkpoints[gates.next];
      const from = matrix.transformPoint(new DOMPoint(follow.x, follow.y));
      const to = matrix.transformPoint(new DOMPoint(xs[at], ys[at]));
      this.drawGuide(context, from.x / ratio, from.y / ratio - 70, Math.atan2(to.y - from.y, to.x - from.x));
    }
  }

  /* ---------------------------- Puntos de control --------------------------- */

  private gateState(k: number, next: number | null): 'next' | 'done' | 'idle' {
    return next === null ? 'idle' : k < next ? 'done' : k === next ? 'next' : 'idle';
  }

  /**
   * Punto de control: franja en el suelo de lado a lado y dos postes a los lados ('ground'), y el arco que los une
   * por encima ('arch'). El siguiente que toca, amarillo y latiendo; los ya pasados, verdes y apagados.
   */
  private drawGates(context: CanvasRenderingContext2D, next: number | null, layer: 'ground' | 'arch'): void {
    const { xs, ys, angles, width, checkpoints } = this.track;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
    const reach = width / 2 + 18;

    checkpoints.forEach((at, k) => {
      const state = this.gateState(k, next);
      const color = state === 'next' ? '#ffd23f' : state === 'done' ? '#43a047' : '#f5f5f5';
      context.save();
      context.translate(xs[at], ys[at]);
      context.rotate(angles[at]);

      if (layer === 'ground') {
        // Franja a rayas (como una linea de salida pequena).
        context.globalAlpha = state === 'next' ? 0.55 + pulse * 0.35 : state === 'done' ? 0.3 : 0.5;
        const stripes = 8;
        const size = width / stripes;

        for (let column = 0; column < stripes; column += 1) {
          context.fillStyle = column % 2 ? color : 'rgba(0, 0, 0, 0.55)';
          context.fillRect(-6, -width / 2 + column * size, 12, size);
        }

        // Postes con su sombra.
        context.globalAlpha = state === 'done' ? 0.55 : 1;

        for (const side of [-1, 1]) {
          context.fillStyle = 'rgba(0, 0, 0, 0.3)';
          context.beginPath();
          context.arc(5, side * reach + 6, 12, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = color;
          context.strokeStyle = '#111';
          context.lineWidth = 3;
          context.beginPath();
          context.arc(0, side * reach, 11, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      } else {
        // Arco por encima: una barra de poste a poste, algo transparente para ver el coche debajo.
        context.globalAlpha = state === 'next' ? 0.9 : state === 'done' ? 0.35 : 0.6;
        context.lineCap = 'round';
        context.strokeStyle = '#111';
        context.lineWidth = 14;
        context.beginPath();
        context.moveTo(0, -reach);
        context.lineTo(0, reach);
        context.stroke();
        context.strokeStyle = color;
        context.lineWidth = 8;
        context.stroke();

        if (state === 'next') {
          context.globalAlpha = 0.25 + pulse * 0.3;
          context.strokeStyle = '#fff3b0';
          context.lineWidth = 26;
          context.stroke();
        }
      }

      context.restore();
    });
  }

  /** Numero del punto de control en un circulo sobre el arco (en coordenadas de pantalla). */
  private drawGateNumber(context: CanvasRenderingContext2D, k: number, state: 'next' | 'done' | 'idle', x: number, y: number): void {
    if (x < -30 || y < -30 || x > this.width + 30 || y > this.height + 30) {
      return;
    }

    const radius = state === 'next' ? 15 : 12;
    context.save();
    context.globalAlpha = state === 'done' ? 0.5 : state === 'idle' ? 0.8 : 1;
    context.fillStyle = state === 'next' ? '#ffd23f' : state === 'done' ? '#43a047' : '#f5f5f5';
    context.strokeStyle = '#111';
    context.lineWidth = 3;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = state === 'done' ? '#fff' : '#111';
    context.font = `900 ${state === 'next' ? 15 : 12}px system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(state === 'done' ? '✓' : String(k + 1), x, y + 1);
    context.restore();
  }

  /** Flecha amarilla que gira para senalar un punto. */
  private drawGuide(context: CanvasRenderingContext2D, x: number, y: number, angle: number): void {
    const bob = Math.sin(performance.now() / 150) * 4;
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.translate(bob, 0);
    context.fillStyle = '#ffd23f';
    context.strokeStyle = '#111';
    context.lineWidth = 4;
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(30, 0);
    context.lineTo(4, -20);
    context.lineTo(4, -8);
    context.lineTo(-24, -8);
    context.lineTo(-24, 8);
    context.lineTo(4, 8);
    context.lineTo(4, 20);
    context.closePath();
    context.fill();
    context.stroke();
    context.restore();
  }

  private drawRoad(context: CanvasRenderingContext2D, path: Path2D, marks: Path2D[], full: boolean): void {
    const width = this.track.width;
    const surface = this.track.definition.surface;
    context.lineJoin = 'round';
    context.lineCap = full ? 'round' : 'butt';

    if (full) {
      context.strokeStyle = this.style.edge;
      context.lineWidth = width + 16;
      context.stroke(path);

      // Bordillos rojos y blancos en el asfalto.
      if (surface === 'asphalt') {
        context.lineWidth = width + 14;
        context.setLineDash([36, 36]);
        context.strokeStyle = '#e53935';
        context.stroke(path);
        context.lineDashOffset = 36;
        context.strokeStyle = '#ffffff';
        context.stroke(path);
        context.setLineDash([]);
        context.lineDashOffset = 0;
      }
    }

    context.strokeStyle = this.style.road;
    context.lineWidth = width;
    context.stroke(path);

    // Rodadas (tierra) o lineas de los bordes (asfalto) y la linea discontinua del centro.
    context.strokeStyle = this.style.marks;
    context.lineWidth = surface === 'asphalt' ? 4 : 9;

    for (const mark of marks) {
      context.stroke(mark);
    }

    context.setLineDash(surface === 'asphalt' ? [40, 40] : [26, 34]);
    context.lineWidth = surface === 'asphalt' ? 5 : 3;
    context.strokeStyle = surface === 'asphalt' ? 'rgba(255, 255, 255, 0.75)' : 'rgba(255, 245, 220, 0.35)';
    context.stroke(path);
    context.setLineDash([]);
  }

  /** Meta: franja a cuadros blancos y negros de lado a lado. */
  private drawStart(context: CanvasRenderingContext2D): void {
    const { xs, ys, angles, width } = this.track;
    context.save();
    context.translate(xs[0], ys[0]);
    context.rotate(angles[0]);
    const squares = 8;
    const size = width / squares;

    for (let row = 0; row < 2; row += 1) {
      for (let column = 0; column < squares; column += 1) {
        context.fillStyle = (row + column) % 2 ? '#111' : '#fff';
        context.fillRect(-size + row * size, -width / 2 + column * size, size, size);
      }
    }

    context.restore();
  }

  /** Coche visto desde arriba: carroceria del color del jugador, cristales, ruedas y faros. */
  private drawCar(context: CanvasRenderingContext2D, car: BoardCar): void {
    const length = CAR.length;
    const width = CAR.width;
    context.save();
    context.translate(car.x, car.y);
    context.rotate(car.angle);
    context.globalAlpha = car.finished && !car.mine ? 0.5 : car.mine ? 1 : 0.92;
    // Sombra.
    context.fillStyle = 'rgba(0, 0, 0, 0.3)';
    context.beginPath();
    context.roundRect(-length / 2 + 4, -width / 2 + 5, length, width, 9);
    context.fill();
    // Ruedas.
    context.fillStyle = '#151515';

    for (const [wx, wy] of [
      [length * 0.28, -width / 2 - 2],
      [length * 0.28, width / 2 - 4],
      [-length * 0.3, -width / 2 - 2],
      [-length * 0.3, width / 2 - 4],
    ]) {
      context.fillRect(wx - 6, wy, 12, 6);
    }

    // Carroceria con borde oscuro.
    context.fillStyle = car.color;
    context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    context.lineWidth = 2.5;
    context.beginPath();
    context.roundRect(-length / 2, -width / 2, length, width, 9);
    context.fill();
    context.stroke();
    // Franja central (de carreras).
    context.fillStyle = 'rgba(255, 255, 255, 0.35)';
    context.fillRect(-length / 2 + 3, -2.5, length - 6, 5);
    // Parabrisas y luna trasera.
    context.fillStyle = '#9fd8ff';
    context.beginPath();
    context.roundRect(length * 0.05, -width / 2 + 4, length * 0.2, width - 8, 4);
    context.fill();
    context.fillStyle = '#6fa8cc';
    context.beginPath();
    context.roundRect(-length * 0.32, -width / 2 + 5, length * 0.13, width - 10, 3);
    context.fill();
    // Faros.
    context.fillStyle = '#fff6b0';
    context.fillRect(length / 2 - 4, -width / 2 + 3, 3, 5);
    context.fillRect(length / 2 - 4, width / 2 - 8, 3, 5);
    context.restore();
  }

  private drawDecor(context: CanvasRenderingContext2D, item: { x: number; y: number; kind: 'tree' | 'bush' | 'rock'; size: number; tint: number }): void {
    const size = item.size;

    if (item.kind === 'rock') {
      context.fillStyle = 'rgba(0, 0, 0, 0.2)';
      context.beginPath();
      context.ellipse(item.x + 6, item.y + 8, 30 * size, 20 * size, 0.3, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = item.tint > 0.5 ? '#9e9e9e' : '#8d8478';
      context.beginPath();
      context.ellipse(item.x, item.y, 28 * size, 19 * size, item.tint * 3, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = 'rgba(255, 255, 255, 0.25)';
      context.beginPath();
      context.ellipse(item.x - 6 * size, item.y - 5 * size, 10 * size, 6 * size, 0.2, 0, Math.PI * 2);
      context.fill();
      return;
    }

    const radius = (item.kind === 'tree' ? 62 : 32) * size;
    const greens = item.kind === 'tree' ? ['#2e7d32', '#388e3c', '#43a047'] : ['#558b2f', '#689f38', '#7cb342'];
    context.fillStyle = 'rgba(0, 0, 0, 0.22)';
    context.beginPath();
    context.arc(item.x + radius * 0.25, item.y + radius * 0.3, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = greens[0];
    context.beginPath();
    context.arc(item.x, item.y, radius, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = greens[1];
    context.beginPath();
    context.arc(item.x - radius * 0.2, item.y - radius * 0.2, radius * 0.7, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = greens[2];
    context.beginPath();
    context.arc(item.x - radius * 0.35, item.y - radius * 0.35, radius * 0.35, 0, Math.PI * 2);
    context.fill();
  }

  /** Foto redonda y nombre encima de los coches de los demas. */
  private drawTag(context: CanvasRenderingContext2D, car: BoardCar, x: number, y: number): void {
    if (x < -50 || y < -50 || x > this.width + 50 || y > this.height + 50) {
      return;
    }

    const radius = 13;
    const image = this.images.get(car.playerId);
    context.save();
    context.globalAlpha = car.finished ? 0.6 : 1;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = '#fff';
    context.fill();

    if (image?.complete && image.naturalWidth) {
      context.clip();
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, x - radius, y - radius, radius * 2, radius * 2);
    }

    context.restore();
    context.save();
    context.globalAlpha = car.finished ? 0.6 : 1;
    context.lineWidth = 3;
    context.strokeStyle = car.color;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
    context.font = '800 12px system-ui, sans-serif';
    const width = Math.min(120, context.measureText(car.name).width + 10);
    context.fillStyle = 'rgba(0, 0, 0, 0.6)';
    context.beginPath();
    context.roundRect(x - width / 2, y - radius - 19, width, 16, 6);
    context.fill();
    context.fillStyle = '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(car.name, x, y - radius - 11, width - 6);
    context.restore();
  }

  /* -------------------------------- Minimapa -------------------------------- */

  /** Minimapa: el circuito entero medio transparente y un punto por coche (el propio, mas visible). */
  drawMinimap(canvas: HTMLCanvasElement, cars: BoardCar[], followId: string | null, nextGate: number | null = null): void {
    const context = canvas.getContext('2d')!;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }

    const { minX, minY, maxX, maxY } = this.track.bounds;
    const pad = this.track.width;
    const scale = Math.min((width - 12) / (maxX - minX + pad * 2), (height - 12) / (maxY - minY + pad * 2));
    this.miniTransform = { scale, x: (width - (maxX - minX) * scale) / 2 - minX * scale, y: (height - (maxY - minY) * scale) / 2 - minY * scale };
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(this.miniTransform.x, this.miniTransform.y);
    context.scale(scale, scale);
    context.lineJoin = 'round';
    context.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    context.lineWidth = Math.max(this.track.width, 3 / scale);
    context.stroke(this.center);
    context.restore();

    // Puntos de control: rayitas de lado a lado de la pista; el siguiente, un punto amarillo que late.
    const { xs, ys, angles, width: roadWidth, checkpoints } = this.track;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
    checkpoints.forEach((at, k) => {
      const state = this.gateState(k, nextGate);
      const x = this.miniTransform.x + xs[at] * scale;
      const y = this.miniTransform.y + ys[at] * scale;

      if (state === 'next') {
        context.fillStyle = '#ffd23f';
        context.strokeStyle = '#111';
        context.lineWidth = 1.5;
        context.beginPath();
        context.arc(x, y, 3.5 + pulse * 1.5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        return;
      }

      const half = Math.max(3, (roadWidth / 2) * scale + 1.5);
      const nx = -Math.sin(angles[at]) * half;
      const ny = Math.cos(angles[at]) * half;
      context.strokeStyle = state === 'done' ? 'rgba(67, 160, 71, 0.8)' : 'rgba(255, 255, 255, 0.85)';
      context.lineWidth = 1.5;
      context.beginPath();
      context.moveTo(x - nx, y - ny);
      context.lineTo(x + nx, y + ny);
      context.stroke();
    });

    for (const car of [...cars].sort((first, second) => Number(first.mine) - Number(second.mine))) {
      const x = this.miniTransform.x + car.x * scale;
      const y = this.miniTransform.y + car.y * scale;
      const followed = car.playerId === followId;
      context.globalAlpha = car.mine || followed ? 1 : 0.45;
      context.fillStyle = car.color;
      context.strokeStyle = car.mine ? '#fff' : 'rgba(0, 0, 0, 0.6)';
      context.lineWidth = car.mine ? 2 : 1;
      context.beginPath();
      context.arc(x, y, car.mine || followed ? 5 : 3.5, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    context.globalAlpha = 1;
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }
}
