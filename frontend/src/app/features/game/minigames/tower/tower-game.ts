// Motor 2D de "Torre de cajas" (canvas, sin 3D). Todo ocurre aqui: el movimiento de la caja, el corte al soltarla,
// las piezas que caen y la camara que sube con la torre. El componente solo le pasa las pulsaciones.

// Unidades del mundo (se escalan al tamano del canvas).
const VIEW_WIDTH = 460;
const VIEW_HEIGHT = 600;
const BASE_WIDTH = 210;
const BOX_HEIGHT = 28;
const SWING_RANGE = 230;
const BASE_SPEED = 150;
const SPEED_PER_LEVEL = 13;
const MAX_SPEED = 430;
// Margen para un "perfecto": la caja se recoloca exacta y no pierde ancho.
const PERFECT_TOLERANCE = 5;
const GRAVITY = 1400;

interface Block {
  x: number;
  width: number;
  hue: number;
}

interface FallingPiece extends Block {
  y: number;
  vy: number;
  vx: number;
  angle: number;
  spin: number;
}

export interface TowerCallbacks {
  onPlace: (level: number, perfect: boolean) => void;
  onLose: (level: number) => void;
}

export class TowerGame {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly stack: Block[] = [{ x: 0, width: BASE_WIDTH, hue: 200 }];
  private readonly falling: FallingPiece[] = [];
  private moving: (Block & { dir: 1 | -1 }) | null = null;
  private cameraY = 0;
  private frameHandle = 0;
  private lastFrame = performance.now();
  private scale = 1;
  private perfectFlashAt = -Infinity;
  /** Hueco (px CSS) que tapa el panel de abajo: el suelo de la torre se dibuja por encima. */
  private bottomInset = 190;
  private cssHeight = 1;
  private active = false;
  private lost = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    private readonly callbacks: TowerCallbacks,
  ) {
    this.context = canvas.getContext('2d')!;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    this.loop();
  }

  get level(): number {
    return this.stack.length - 1;
  }

  /** Empieza a moverse la caja (al acabar la cuenta atras). */
  start(): void {
    if (this.active || this.lost) {
      return;
    }

    this.active = true;
    this.spawnMoving();
  }

  /** Fin del tiempo: la caja que se movia desaparece y la torre se queda como esta. */
  stop(): void {
    this.active = false;
    this.moving = null;
  }

  /** Soltar la caja: el corte se calcula aqui mismo, al instante. */
  drop(): void {
    const moving = this.moving;

    if (!this.active || !moving) {
      return;
    }

    const top = this.stack[this.stack.length - 1];
    const offset = moving.x - top.x;
    const y = this.levelY(this.stack.length);

    if (Math.abs(offset) <= PERFECT_TOLERANCE) {
      this.stack.push({ x: top.x, width: top.width, hue: moving.hue });
      this.perfectFlashAt = performance.now();
      this.callbacks.onPlace(this.level, true);
      this.spawnMoving();
      return;
    }

    const overlap = top.width - Math.abs(offset);

    if (overlap <= 0) {
      // No toca la torre: se cae entera y se acabo.
      this.falling.push({ ...moving, y, vy: 0, vx: moving.dir * 60, angle: 0, spin: moving.dir * 2.5 });
      this.moving = null;
      this.active = false;
      this.lost = true;
      this.callbacks.onLose(this.level);
      return;
    }

    // Lo que sobresale se corta y cae girando por su lado.
    const side = Math.sign(offset);
    const keptX = top.x + offset / 2;
    const cutWidth = Math.abs(offset);
    const cutX = keptX + side * (overlap / 2 + cutWidth / 2);
    this.stack.push({ x: keptX, width: overlap, hue: moving.hue });
    this.falling.push({ x: cutX, width: cutWidth, hue: moving.hue, y, vy: 0, vx: side * 90, angle: 0, spin: side * 3 });
    this.callbacks.onPlace(this.level, false);
    this.spawnMoving();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
  }

  private spawnMoving(): void {
    const top = this.stack[this.stack.length - 1];
    // Sale por el lado contrario cada vez.
    const dir: 1 | -1 = this.stack.length % 2 ? 1 : -1;
    this.moving = { x: -dir * SWING_RANGE, width: top.width, hue: (this.stack.length * 27 + 200) % 360, dir };
  }

  /** Altura (unidades del mundo, hacia arriba) de la base de la caja numero `index`. */
  private levelY(index: number): number {
    return index * BOX_HEIGHT;
  }

  /* ---------------------------------- Bucle --------------------------------- */

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.moving) {
      const speed = Math.min(MAX_SPEED, BASE_SPEED + this.level * SPEED_PER_LEVEL);
      this.moving.x += this.moving.dir * speed * delta;

      if (Math.abs(this.moving.x) > SWING_RANGE) {
        this.moving.x = Math.sign(this.moving.x) * SWING_RANGE;
        this.moving.dir = (this.moving.dir * -1) as 1 | -1;
      }
    }

    for (const piece of this.falling) {
      piece.vy -= GRAVITY * delta;
      piece.y += piece.vy * delta;
      piece.x += piece.vx * delta;
      piece.angle += piece.spin * delta;
    }

    // Las piezas que ya han caido fuera de la vista se olvidan.
    for (let index = this.falling.length - 1; index >= 0; index -= 1) {
      if (this.falling[index].y < this.cameraY - VIEW_HEIGHT * 2) {
        this.falling.splice(index, 1);
      }
    }

    // La camara sube para que la cima quede a media altura del hueco libre (sin el panel de abajo).
    const visibleUnits = Math.max(200, (this.cssHeight - this.bottomInset) / this.scale);
    const target = Math.max(0, this.levelY(this.stack.length) - visibleUnits * 0.5);
    this.cameraY += (target - this.cameraY) * Math.min(1, delta * 4);
    this.draw(now);
  }

  private draw(now: number): void {
    const context = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    const ratio = window.devicePixelRatio || 1;

    // Cielo que se oscurece segun se sube (de dia a atardecer y noche).
    const altitude = Math.min(1, this.cameraY / 1400);
    const sky = context.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, `hsl(${210 - altitude * 40}, 75%, ${82 - altitude * 50}%)`);
    sky.addColorStop(1, `hsl(${200 - altitude * 30}, 80%, ${92 - altitude * 40}%)`);
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    context.save();
    // Origen en el centro de abajo; el eje y del mundo hacia arriba.
    context.translate(width / 2, height - this.bottomInset * ratio);
    context.scale(this.scale * ratio, -this.scale * ratio);
    context.translate(0, -this.cameraY);

    // Las piezas cortadas se dibujan antes que el suelo: al caer por debajo, la hierba las tapa.
    for (const piece of this.falling) {
      this.drawBlock(piece, piece.y, piece.angle, false);
    }

    // Suelo y marcas de altura cada 5 cajas.
    context.fillStyle = '#7bc96f';
    context.fillRect(-VIEW_WIDTH * 2, -600, VIEW_WIDTH * 4, 600);
    context.fillStyle = 'rgba(255,255,255,0.55)';

    for (let mark = 5; mark <= this.stack.length + 10; mark += 5) {
      context.fillRect(-VIEW_WIDTH, this.levelY(mark) - 1, 26, 2);
    }

    this.stack.forEach((block, index) => this.drawBlock(block, this.levelY(index), 0, index === 0));

    if (this.moving) {
      this.drawBlock(this.moving, this.levelY(this.stack.length), 0, false);
    }

    context.restore();

    // Destello al acertar de lleno.
    const flash = 1 - (now - this.perfectFlashAt) / 350;

    if (flash > 0) {
      context.fillStyle = `rgba(255, 255, 255, ${flash * 0.35})`;
      context.fillRect(0, 0, width, height);
    }
  }

  private drawBlock(block: Block, y: number, angle: number, isBase: boolean): void {
    const context = this.context;
    context.save();
    context.translate(block.x, y + BOX_HEIGHT / 2);
    context.rotate(angle);
    context.fillStyle = isBase ? '#5b4636' : `hsl(${block.hue}, 75%, 62%)`;
    context.strokeStyle = '#000';
    context.lineWidth = 3 / this.scale;
    context.fillRect(-block.width / 2, -BOX_HEIGHT / 2, block.width, BOX_HEIGHT);
    context.strokeRect(-block.width / 2, -BOX_HEIGHT / 2, block.width, BOX_HEIGHT);

    if (!isBase) {
      // Brillo en la parte de arriba de cada caja.
      context.fillStyle = 'rgba(255,255,255,0.35)';
      context.fillRect(-block.width / 2 + 3, BOX_HEIGHT / 2 - 8, Math.max(0, block.width - 6), 4);
    }

    context.restore();
  }

  private resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.cssHeight = height;
    this.bottomInset = Math.min(220, height * 0.32);
    // Cabe siempre el recorrido entero de la caja de lado a lado y una buena altura de torre.
    this.scale = Math.min(width / VIEW_WIDTH / 1.1, height / VIEW_HEIGHT);
  }
}
