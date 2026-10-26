// Tablero del Snake en un canvas 2D con los colores del Snake de Google: cuadros verdes claros, marco verde
// oscuro, manzanas rojas con hoja y serpientes gruesas y redondeadas con ojos.

const LIGHT = '#aad751';
const DARK = '#a2d149';
const FRAME = '#578a34';
const DEAD_BLINK_MS = 900;
const DEAD_FADE_MS = 700;

export interface BoardSnake {
  playerId: string;
  name: string;
  color: string;
  /** Casillas de la cabeza a la cola ahora y en el paso anterior, y cuanto va del uno al otro (0..1). */
  body: Array<[number, number]>;
  previous: Array<[number, number]>;
  progress: number;
  dir: [number, number];
  alive: boolean;
  /** Momento (performance.now) en que choco. */
  diedAt: number | null;
  mine: boolean;
}

export interface SnakeFrame {
  size: number;
  snakes: BoardSnake[];
  fruits: Array<{ id: number; x: number; y: number }>;
}

/** Color mas claro u oscuro (para el brillo y la sombra del cuerpo). */
function shade(hex: string, amount: number): string {
  const value = parseInt(hex.replace('#', ''), 16);
  const channel = (shift: number) => {
    const base = (value >> shift) & 255;
    return Math.max(0, Math.min(255, Math.round(amount > 0 ? base + (255 - base) * amount : base * (1 + amount))));
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

export class SnakeBoard {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly images = new Map<string, HTMLImageElement>();
  private width = 1;
  private height = 1;
  private tile = 20;
  private originX = 0;
  private originY = 0;
  private insets = { top: 70, right: 12, bottom: 12, left: 12 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
  ) {
    this.context = canvas.getContext('2d')!;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  setInsets(insets: { top: number; right: number; bottom: number; left: number }): void {
    this.insets = insets;
  }

  setAvatar(playerId: string, url: string): void {
    if (!url || this.images.has(playerId)) {
      return;
    }

    const image = new Image();
    image.src = url;
    this.images.set(playerId, image);
  }

  /** Casilla bajo un punto de la pantalla (para deslizar el dedo). */
  get tileSize(): number {
    return this.tile;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
  }

  draw(frame: SnakeFrame, now: number): void {
    const context = this.context;
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.layout(frame.size);
    const { size } = frame;
    const tile = this.tile;
    const border = Math.max(6, Math.round(tile * 0.6));

    context.fillStyle = '#4a752c';
    context.fillRect(0, 0, this.width, this.height);
    // Marco verde oscuro y tablero a cuadros.
    context.fillStyle = FRAME;
    context.fillRect(this.originX - border, this.originY - border, size * tile + border * 2, size * tile + border * 2);

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        context.fillStyle = (x + y) % 2 ? DARK : LIGHT;
        context.fillRect(this.originX + x * tile, this.originY + y * tile, tile, tile);
      }
    }

    for (const fruit of frame.fruits) {
      this.drawApple(fruit.x, fruit.y, now, fruit.id);
    }

    // Primero las de los demas y encima la propia; las caidas parpadean en gris y se desvanecen.
    const snakes = [...frame.snakes].sort((first, second) => Number(first.mine) - Number(second.mine));

    for (const snake of snakes) {
      this.drawSnake(snake, now);
    }

    for (const snake of snakes) {
      if (snake.alive && snake.body.length) {
        this.drawTag(snake);
      }
    }
  }

  /**
   * Puntos del cuerpo (en pixeles): la cabeza se desliza desde la casilla anterior y la cola se va recogiendo; el
   * resto son los centros de las casillas. Las esquinas se redondean al dibujar.
   */
  private snakePoints(snake: BoardSnake): Array<[number, number]> {
    const { body, previous } = snake;
    const progress = Math.min(1, Math.max(0, snake.progress));
    // Solo se desliza si el paso anterior es el mismo cuerpo desplazado una casilla.
    const shifted = body.length > 1 && previous.length > 0 && previous[0][0] === body[1][0] && previous[0][1] === body[1][1];
    let cells: Array<[number, number]> = body;

    if (shifted && progress < 1) {
      const lerp = (from: [number, number], to: [number, number]): [number, number] => [from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress];
      cells = [lerp(body[1], body[0]), ...body.slice(1)];

      // Sin crecer, la cola se recoge desde la casilla que acaba de dejar.
      if (previous.length >= body.length) {
        cells.push(lerp(previous[previous.length - 1], body[body.length - 1]));
      }
    }

    const points = cells.map(([x, y]) => this.center(x, y));
    // Fuera puntos repetidos (segmentos de longitud cero).
    return points.filter((point, index) => index === 0 || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 0.01);
  }

  /** Recorre el cuerpo con las esquinas redondeadas (un cuarto de circulo de media casilla de radio). */
  private traceRounded(points: Array<[number, number]>): void {
    const context = this.context;
    const radius = this.tile / 2;
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);

    if (points.length === 1) {
      context.lineTo(points[0][0] + 0.01, points[0][1]);
      return;
    }

    for (let index = 1; index < points.length - 1; index += 1) {
      const [px, py] = points[index - 1];
      const [cx, cy] = points[index];
      const [nx, ny] = points[index + 1];
      const before = Math.hypot(cx - px, cy - py);
      const after = Math.hypot(nx - cx, ny - cy);
      // Un tramo entre dos esquinas se reparte entre las dos; los extremos (cabeza, cola) se pueden usar enteros.
      const limit = Math.min(radius, index === 1 ? before : before / 2, index === points.length - 2 ? after : after / 2);
      context.arcTo(cx, cy, nx, ny, Math.max(0, limit));
    }

    const [lx, ly] = points[points.length - 1];
    context.lineTo(lx, ly);
  }

  /* --------------------------------- Dibujo --------------------------------- */

  private center(x: number, y: number): [number, number] {
    return [this.originX + (x + 0.5) * this.tile, this.originY + (y + 0.5) * this.tile];
  }

  private drawApple(x: number, y: number, now: number, id: number): void {
    const context = this.context;
    const tile = this.tile;
    const [cx, cy] = this.center(x, y);
    const pulse = 1 + Math.sin(now / 260 + id) * 0.05;
    const radius = tile * 0.4 * pulse;
    context.fillStyle = 'rgba(0, 0, 0, 0.15)';
    context.beginPath();
    context.ellipse(cx, cy + radius * 0.85, radius * 0.8, radius * 0.25, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#e7471d';
    context.beginPath();
    context.arc(cx, cy + tile * 0.04, radius, 0, Math.PI * 2);
    context.fill();
    // Brillo.
    context.fillStyle = 'rgba(255, 255, 255, 0.45)';
    context.beginPath();
    context.ellipse(cx - radius * 0.38, cy - radius * 0.25, radius * 0.22, radius * 0.14, -0.6, 0, Math.PI * 2);
    context.fill();
    // Rabito y hoja.
    context.strokeStyle = '#7a4a1e';
    context.lineWidth = Math.max(1.5, tile * 0.07);
    context.beginPath();
    context.moveTo(cx, cy - radius * 0.75);
    context.lineTo(cx + tile * 0.04, cy - radius * 1.2);
    context.stroke();
    context.fillStyle = '#4caf31';
    context.beginPath();
    context.ellipse(cx + tile * 0.17, cy - radius * 1.15, tile * 0.15, tile * 0.07, -0.4, 0, Math.PI * 2);
    context.fill();
  }

  private drawSnake(snake: BoardSnake, now: number): void {
    if (!snake.body.length) {
      return;
    }

    const context = this.context;
    const tile = this.tile;
    let alpha = 1;
    let color = snake.color;

    if (!snake.alive) {
      const age = snake.diedAt === null ? Infinity : now - snake.diedAt;

      if (age > DEAD_BLINK_MS + DEAD_FADE_MS) {
        return;
      }

      color = '#9e9e9e';
      alpha = age < DEAD_BLINK_MS ? (Math.floor(age / 120) % 2 ? 0.35 : 1) : 1 - (age - DEAD_BLINK_MS) / DEAD_FADE_MS;
    }

    const points = this.snakePoints(snake);
    context.save();
    context.globalAlpha = alpha;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const trace = () => this.traceRounded(points);

    // Sombra, cuerpo, borde un poco mas oscuro y brillo encima (como un tubo).
    context.translate(0, tile * 0.12);
    context.strokeStyle = 'rgba(0, 0, 0, 0.16)';
    context.lineWidth = tile * 0.92;
    trace();
    context.stroke();
    context.translate(0, -tile * 0.12);
    context.strokeStyle = shade(color, -0.25);
    context.lineWidth = tile * 0.92;
    trace();
    context.stroke();
    context.strokeStyle = color;
    context.lineWidth = tile * 0.78;
    trace();
    context.stroke();
    // Cabeza un poco mas ancha que el cuerpo.
    context.fillStyle = shade(color, -0.25);
    context.beginPath();
    context.arc(points[0][0], points[0][1], tile * 0.52, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = color;
    context.beginPath();
    context.arc(points[0][0], points[0][1], tile * 0.45, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = shade(color, 0.35);
    context.lineWidth = tile * 0.18;
    context.globalAlpha = alpha * 0.55;
    context.translate(-tile * 0.06, -tile * 0.1);
    trace();
    context.stroke();
    context.translate(tile * 0.06, tile * 0.1);
    context.globalAlpha = alpha;

    // Cabeza con ojos mirando hacia donde va (cruces si ha chocado).
    const [hx, hy] = points[0];
    const [dx, dy] = snake.dir;
    const side: [number, number] = [-dy, dx];
    const eyeForward = tile * 0.14;
    const eyeSide = tile * 0.22;

    for (const sign of [-1, 1]) {
      const ex = hx + dx * eyeForward + side[0] * eyeSide * sign;
      const ey = hy + dy * eyeForward + side[1] * eyeSide * sign;
      context.fillStyle = '#fff';
      context.beginPath();
      context.arc(ex, ey, tile * 0.16, 0, Math.PI * 2);
      context.fill();

      if (snake.alive) {
        context.fillStyle = '#1b2a4a';
        context.beginPath();
        context.arc(ex + dx * tile * 0.05, ey + dy * tile * 0.05, tile * 0.08, 0, Math.PI * 2);
        context.fill();
      } else {
        context.strokeStyle = '#1b2a4a';
        context.lineWidth = Math.max(1, tile * 0.05);
        const r = tile * 0.08;
        context.beginPath();
        context.moveTo(ex - r, ey - r);
        context.lineTo(ex + r, ey + r);
        context.moveTo(ex + r, ey - r);
        context.lineTo(ex - r, ey + r);
        context.stroke();
      }
    }

    context.restore();
  }

  /** Foto redonda del jugador y su nombre, flotando junto a la cabeza. */
  private drawTag(snake: BoardSnake): void {
    const context = this.context;
    const tile = this.tile;
    const [hx, hy] = this.snakePoints(snake)[0];
    const radius = Math.max(8, tile * 0.48);
    const x = hx;
    const y = hy - tile * 0.95;
    const image = this.images.get(snake.playerId);
    context.save();
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
    context.lineWidth = Math.max(2, radius * 0.22);
    context.strokeStyle = snake.mine ? '#ffe14d' : snake.color;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();

    const label = snake.mine ? 'Tú' : snake.name;
    const font = Math.max(9, Math.min(13, Math.round(tile * 0.5)));
    context.font = `800 ${font}px system-ui, sans-serif`;
    const width = Math.min(tile * 5, context.measureText(label).width + 8);
    context.fillStyle = snake.mine ? 'rgba(255, 225, 77, 0.95)' : 'rgba(0, 0, 0, 0.55)';
    context.beginPath();
    context.roundRect(x - width / 2, y - radius - font - 6, width, font + 4, 6);
    context.fill();
    context.fillStyle = snake.mine ? '#000' : '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText(label, x, y - radius - font - 4, width - 4);
  }

  /* --------------------------------- Medidas -------------------------------- */

  private layout(size: number): void {
    const margin = 10;
    const usableWidth = Math.max(80, this.width - this.insets.left - this.insets.right - margin * 2);
    const usableHeight = Math.max(80, this.height - this.insets.top - this.insets.bottom - margin * 2);
    this.tile = Math.max(6, Math.floor(Math.min(usableWidth / size, usableHeight / size)));
    this.originX = Math.round(this.insets.left + margin + (usableWidth - this.tile * size) / 2);
    this.originY = Math.round(this.insets.top + margin + (usableHeight - this.tile * size) / 2);
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
