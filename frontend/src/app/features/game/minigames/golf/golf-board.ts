import { BALL_RADIUS, GOLF_HEIGHT, GOLF_WIDTH, GolfMap, GolfSimulation, HOLE_RADIUS } from './golf-course';

// Arrastre maximo (unidades del campo) que equivale a la fuerza maxima.
const MAX_DRAG = 170;
// Se puede empezar a apuntar tocando cerca de la bola.
const GRAB_RADIUS = 70;

export interface GolfBall {
  playerId: string;
  mine: boolean;
  color: string;
  image: HTMLImageElement | null;
  simulation: GolfSimulation | null;
  /** Momento (performance.now) en que empieza a rodar. */
  startedAt: number;
}

/**
 * Tablero 2D del Mini golf: dibuja el hoyo, las bolas (la propia blanca; las demas semitransparentes con la foto
 * de su jugador) y gestiona el apuntado arrastrando hacia atras desde la bola, como un tirachinas.
 */
export class GolfBoard {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private frameHandle = 0;
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private map: GolfMap;
  private balls: GolfBall[] = [];
  private drag: { x: number; y: number } | null = null;
  private aiming = false;
  /** Margenes (px) que tapa el HUD arriba y abajo. */
  private insets = { top: 70, bottom: 120 };

  /** Disparo (angulo en radianes y fuerza 0-1) al soltar el arrastre. */
  onShoot?: (angle: number, power: number) => void;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    map: GolfMap,
  ) {
    this.context = canvas.getContext('2d')!;
    this.map = map;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    canvas.addEventListener('pointerdown', this.pointerDown);
    window.addEventListener('pointermove', this.pointerMove);
    window.addEventListener('pointerup', this.pointerUp);
    this.loop();
  }

  setMap(map: GolfMap): void {
    this.map = map;
  }

  setBalls(balls: GolfBall[]): void {
    this.balls = balls;
  }

  setAiming(aiming: boolean): void {
    this.aiming = aiming;

    if (!aiming) {
      this.drag = null;
    }
  }

  setInsets(top: number, bottom: number): void {
    this.insets = { top, bottom };
    this.resize();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.pointerDown);
    window.removeEventListener('pointermove', this.pointerMove);
    window.removeEventListener('pointerup', this.pointerUp);
  }

  /* --------------------------------- Apuntar -------------------------------- */

  private toWorld(event: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left - this.offsetX) / this.scale, y: (event.clientY - rect.top - this.offsetY) / this.scale };
  }

  private readonly pointerDown = (event: PointerEvent) => {
    if (!this.aiming) {
      return;
    }

    const point = this.toWorld(event);

    if (Math.hypot(point.x - this.map.tee.x, point.y - this.map.tee.y) <= GRAB_RADIUS) {
      this.drag = point;
      event.preventDefault();
    }
  };

  private readonly pointerMove = (event: PointerEvent) => {
    if (this.drag) {
      this.drag = this.toWorld(event);
    }
  };

  private readonly pointerUp = () => {
    const shot = this.currentShot();
    this.drag = null;

    if (shot && this.aiming && shot.power > 0.03) {
      this.onShoot?.(shot.angle, shot.power);
    }
  };

  /** Tiro segun el arrastre: hacia el lado contrario y con fuerza proporcional a la distancia. */
  private currentShot(): { angle: number; power: number } | null {
    if (!this.drag) {
      return null;
    }

    const dx = this.map.tee.x - this.drag.x;
    const dy = this.map.tee.y - this.drag.y;
    return { angle: Math.atan2(dy, dx), power: Math.min(1, Math.hypot(dx, dy) / MAX_DRAG) };
  }

  /* --------------------------------- Dibujo --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    this.draw(performance.now());
  }

  private draw(now: number): void {
    const context = this.context;
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#6fbf73';
    context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.setTransform(this.scale * ratio, 0, 0, this.scale * ratio, this.offsetX * ratio, this.offsetY * ratio);

    // Cesped a franjas y borde de madera.
    for (let y = 0; y < GOLF_HEIGHT; y += 40) {
      context.fillStyle = (y / 40) % 2 ? '#7fd17f' : '#74c874';
      context.fillRect(0, y, GOLF_WIDTH, 40);
    }

    context.lineWidth = 10;
    context.strokeStyle = '#8a5a32';
    context.strokeRect(-5, -5, GOLF_WIDTH + 10, GOLF_HEIGHT + 10);

    for (const sand of this.map.sand) {
      this.roundedRect(sand.x, sand.y, sand.w, sand.h, 14, '#ecd9a0', '#c9b27a');
    }

    for (const water of this.map.water) {
      this.roundedRect(water.x, water.y, water.w, water.h, 10, '#4aa3df', '#2f7bb0');
    }

    for (const wall of this.map.walls) {
      this.roundedRect(wall.x, wall.y, wall.w, wall.h, 4, '#a0683a', '#5b3a1e');
    }

    for (const bumper of this.map.bumpers) {
      context.beginPath();
      context.arc(bumper.x, bumper.y, bumper.r, 0, Math.PI * 2);
      context.fillStyle = '#ff5a5f';
      context.fill();
      context.lineWidth = 4;
      context.strokeStyle = '#7a1f22';
      context.stroke();
      context.beginPath();
      context.arc(bumper.x, bumper.y, bumper.r * 0.45, 0, Math.PI * 2);
      context.fillStyle = '#ffd1d2';
      context.fill();
    }

    // Hoyo con banderita y salida.
    context.beginPath();
    context.arc(this.map.hole.x, this.map.hole.y, HOLE_RADIUS, 0, Math.PI * 2);
    context.fillStyle = '#1b1b1b';
    context.fill();
    context.fillStyle = '#5b3a1e';
    context.fillRect(this.map.hole.x - 1.5, this.map.hole.y - 46, 3, 46);
    context.beginPath();
    context.moveTo(this.map.hole.x + 1.5, this.map.hole.y - 46);
    context.lineTo(this.map.hole.x + 28, this.map.hole.y - 38);
    context.lineTo(this.map.hole.x + 1.5, this.map.hole.y - 30);
    context.fillStyle = '#e8262b';
    context.fill();
    context.beginPath();
    context.arc(this.map.tee.x, this.map.tee.y, 16, 0, Math.PI * 2);
    context.fillStyle = 'rgba(255,255,255,0.35)';
    context.fill();

    this.drawAim();

    // Primero las bolas de los demas y encima la propia.
    for (const ball of [...this.balls].sort((first, second) => Number(first.mine) - Number(second.mine))) {
      this.drawBall(ball, now);
    }
  }

  private drawAim(): void {
    const shot = this.currentShot();

    if (!shot || !this.aiming) {
      return;
    }

    const context = this.context;
    const length = 40 + shot.power * 150;
    const endX = this.map.tee.x + Math.cos(shot.angle) * length;
    const endY = this.map.tee.y + Math.sin(shot.angle) * length;
    // Flecha de direccion (de blanco a rojo segun la fuerza) y la goma hasta el dedo.
    context.setLineDash([8, 6]);
    context.lineWidth = 2;
    context.strokeStyle = 'rgba(0,0,0,0.45)';
    context.beginPath();
    context.moveTo(this.map.tee.x, this.map.tee.y);
    context.lineTo(this.drag!.x, this.drag!.y);
    context.stroke();
    context.setLineDash([]);
    context.lineWidth = 6;
    context.strokeStyle = `hsl(${120 - shot.power * 120}, 85%, 50%)`;
    context.beginPath();
    context.moveTo(this.map.tee.x, this.map.tee.y);
    context.lineTo(endX, endY);
    context.stroke();
    context.beginPath();
    context.arc(endX, endY, 7, 0, Math.PI * 2);
    context.fillStyle = context.strokeStyle;
    context.fill();
  }

  private drawBall(ball: GolfBall, now: number): void {
    const context = this.context;
    let position = this.map.tee;
    let sunk = false;

    if (ball.simulation) {
      const index = Math.max(0, Math.min(ball.simulation.path.length - 1, Math.floor((now - ball.startedAt) / ball.simulation.stepMs)));
      position = ball.simulation.path[index];
      const done = index >= ball.simulation.path.length - 1;
      sunk = done && (ball.simulation.holed || ball.simulation.water);
    }

    if (sunk) {
      return;
    }

    const radius = BALL_RADIUS * (ball.mine ? 1.25 : 1.6);
    context.save();
    context.globalAlpha = ball.mine ? 1 : 0.6;
    context.beginPath();
    context.arc(position.x, position.y, radius, 0, Math.PI * 2);
    context.fillStyle = ball.mine ? '#ffffff' : ball.color;
    context.fill();

    // Foto del jugador dentro de su bola (las de los demas).
    if (!ball.mine && ball.image?.complete && ball.image.naturalWidth) {
      context.save();
      context.clip();
      context.globalAlpha = 0.85;
      context.drawImage(ball.image, position.x - radius, position.y - radius, radius * 2, radius * 2);
      context.restore();
    }

    context.lineWidth = ball.mine ? 3 : 2.5;
    context.strokeStyle = ball.mine ? '#000' : ball.color;
    context.stroke();
    context.restore();
  }

  private roundedRect(x: number, y: number, width: number, height: number, radius: number, fill: string, stroke: string): void {
    const context = this.context;
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
    context.fillStyle = fill;
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = stroke;
    context.stroke();
  }

  /** Encaja el campo entero en el hueco libre entre el HUD de arriba y el de abajo. */
  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    const available = Math.max(200, height - this.insets.top - this.insets.bottom);
    this.scale = Math.min((width - 24) / GOLF_WIDTH, available / GOLF_HEIGHT);
    this.offsetX = (width - GOLF_WIDTH * this.scale) / 2;
    this.offsetY = this.insets.top + (available - GOLF_HEIGHT * this.scale) / 2;
  }
}
