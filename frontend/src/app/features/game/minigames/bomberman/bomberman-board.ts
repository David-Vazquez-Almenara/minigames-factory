import { FlameShape } from './bomberman-rules';

// Todo se dibuja en pixel art: cada sprite mide 16x16 "pixeles" y se escala a la casilla sin suavizado.
const SPRITE = 16;
const FLAME_MS = 650;
// Punta de la llama: a partir de este pixel (desde la base) se redondea a lo largo de TIP_LENGTH pixeles.
const TIP_START = 8;
const TIP_LENGTH = 7.5;
const DEATH_MS = 900;

export interface BoardPlayer {
  playerId: string;
  name: string;
  color: string;
  /** Posicion en casillas (con decimales mientras camina de una a otra). */
  x: number;
  y: number;
  mine: boolean;
  alive: boolean;
  /** Momento (performance.now) en que cayo. */
  diedAt: number | null;
  moving: boolean;
}

export interface BoardFrame {
  size: number;
  cells: ArrayLike<string>;
  /** explodeAt en el reloj local (performance.now), para el parpadeo de los ultimos instantes. */
  bombs: Array<{ x: number; y: number; explodeAt: number; fuseMs: number }>;
  flames: Array<{ index: number; shape: FlameShape; startedAt: number }>;
  powerups: Array<{ x: number; y: number; type: 'radius' | 'bombs' }>;
  /** Piedras rompiendose (animacion de escombros). */
  rubble: Array<{ index: number; startedAt: number }>;
  players: BoardPlayer[];
}

type Painter = (px: (x: number, y: number, color: string, w?: number, h?: number) => void) => void;

/** Sprite de 16x16 pintado pixel a pixel. */
function sprite(paint: Painter): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SPRITE;
  canvas.height = SPRITE;
  const context = canvas.getContext('2d')!;
  paint((x, y, color, w = 1, h = 1) => {
    context.fillStyle = color;
    context.fillRect(x, y, w, h);
  });
  return canvas;
}

/** Ruido determinista (mismas manchas en cada partida). */
function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * Tablero del Bomberman en un canvas 2D con estetica pixel art: arena vista desde arriba con una cuadricula
 * exacta (casillas cuadradas de tamano entero), y encima mejoras, bombas, llamas y jugadores.
 */
export class BombermanBoard {
  private readonly context: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private width = 1;
  private height = 1;
  private tile = 32;
  private originX = 0;
  private originY = 0;
  private insets = { top: 70, right: 12, bottom: 12, left: 12 };
  private readonly sprites: Record<string, HTMLCanvasElement>;
  private readonly heads = new Map<string, { canvas: HTMLCanvasElement; color: string; ready: boolean }>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
  ) {
    this.context = canvas.getContext('2d')!;
    this.sprites = this.buildSprites();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  setInsets(insets: { top: number; right: number; bottom: number; left: number }): void {
    this.insets = insets;
    this.resize();
  }

  /** Cabeza del jugador en pixel art: su foto reducida a 10x10 dentro de un circulo con el borde de su color. */
  setPlayer(playerId: string, avatarUrl: string, color: string, name: string): void {
    if (this.heads.has(playerId)) {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 12;
    const entry = { canvas, color, ready: false };
    this.heads.set(playerId, entry);
    this.paintHead(canvas, color, null, name);

    if (avatarUrl) {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => {
        this.paintHead(canvas, color, image, name);
        entry.ready = true;
      };
      image.onerror = () => {
        // Sin CORS: se vuelve a intentar sin pedirlo (se puede dibujar igual, aunque no leer sus pixeles).
        const plain = new Image();
        plain.onload = () => this.paintHead(canvas, color, plain, name);
        plain.src = avatarUrl;
      };
      image.src = avatarUrl;
    }
  }

  dispose(): void {
    this.resizeObserver.disconnect();
  }

  /** Centro de una casilla en pixeles de la pantalla (para colocar cosas encima). */
  cellToScreen(x: number, y: number): { x: number; y: number; tile: number } {
    return { x: this.originX + (x + 0.5) * this.tile, y: this.originY + (y + 0.5) * this.tile, tile: this.tile };
  }

  draw(frame: BoardFrame, now: number): void {
    const context = this.context;
    const ratio = window.devicePixelRatio || 1;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.imageSmoothingEnabled = false;
    context.fillStyle = '#1d2b1f';
    context.fillRect(0, 0, this.width, this.height);
    this.layout(frame.size);
    const { size, cells } = frame;
    const tile = this.tile;

    // Casillas: suelo, paredes, columnas y piedras.
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = cells[y * size + x];
        const left = this.originX + x * tile;
        const top = this.originY + y * tile;
        const floor = this.sprites[(x + y) % 2 ? 'floorA' : 'floorB'];
        context.drawImage(floor, left, top, tile, tile);

        if (cell === 'W') {
          context.drawImage(this.sprites['wall'], left, top, tile, tile);
        } else if (cell === 'C') {
          context.drawImage(this.sprites['column'], left, top, tile, tile);
        } else if (cell === 'S') {
          context.drawImage(this.sprites['stone'], left, top, tile, tile);
        } else if (y > 0 && cells[(y - 1) * size + x] !== '.' ) {
          // Sombra del bloque de arriba sobre el suelo.
          context.fillStyle = 'rgba(0, 0, 0, 0.22)';
          context.fillRect(left, top, tile, Math.round(tile / 6));
        }
      }
    }

    // Piedras rompiendose: trozos que saltan.
    for (const rubble of frame.rubble) {
      this.drawRubble(rubble.index % size, Math.floor(rubble.index / size), (now - rubble.startedAt) / 500);
    }

    // Mejoras (parpadean un poco).
    for (const powerup of frame.powerups) {
      const left = this.originX + powerup.x * tile;
      const top = this.originY + powerup.y * tile;
      const bob = Math.round(Math.sin(now / 160) * (tile / 16));
      context.drawImage(this.sprites[powerup.type === 'radius' ? 'powerRadius' : 'powerBombs'], left, top + bob, tile, tile);
    }

    // Bombas: laten y, en el ultimo segundo, parpadean en rojo.
    for (const bomb of frame.bombs) {
      const left = this.originX + bomb.x * tile;
      const top = this.originY + bomb.y * tile;
      const remaining = bomb.explodeAt - now;
      const hurry = remaining < 1000;
      const pulse = Math.floor(now / (hurry ? 90 : 260)) % 2;
      const name = hurry && pulse ? 'bombRed' : pulse ? 'bombBig' : 'bomb';
      context.drawImage(this.sprites[name], left, top, tile, tile);
      // Chispa de la mecha.
      const spark = Math.floor(now / 70) % 3;
      const unit = tile / SPRITE;
      context.fillStyle = ['#fff6a8', '#ffb000', '#ff5a00'][spark];
      context.fillRect(left + Math.round(12 * unit), top + Math.round((1 - (spark % 2)) * unit), Math.ceil(unit * 2), Math.ceil(unit * 2));
    }

    // Llamas.
    for (const flame of frame.flames) {
      const age = (now - flame.startedAt) / FLAME_MS;

      if (age >= 0 && age < 1) {
        this.drawFlame(flame.index % size, Math.floor(flame.index / size), flame.shape, age);
      }
    }

    // Jugadores (los de abajo por encima) y sus nombres.
    const players = [...frame.players].sort((first, second) => first.y - second.y);

    for (const player of players) {
      this.drawPlayer(player, now);
    }

    for (const player of players) {
      if (player.alive) {
        this.drawName(player);
      }
    }
  }

  /* ------------------------------- Personajes ------------------------------- */

  private drawPlayer(player: BoardPlayer, now: number): void {
    const context = this.context;
    const tile = this.tile;
    const unit = tile / SPRITE;
    const left = this.originX + player.x * tile;
    const top = this.originY + player.y * tile;
    let alpha = 1;
    let rise = 0;
    let flash = false;

    if (!player.alive) {
      const age = player.diedAt === null ? 1 : (now - player.diedAt) / DEATH_MS;

      if (age >= 1) {
        // Queda una calavera pequena donde cayo.
        context.globalAlpha = 0.85;
        context.drawImage(this.sprites['skull'], left + tile * 0.25, top + tile * 0.3, tile * 0.5, tile * 0.5);
        context.globalAlpha = 1;
        return;
      }

      // Parpadea en blanco y sube como un fantasma mientras se desvanece.
      flash = Math.floor(age * 10) % 2 === 0;
      rise = age * tile * 0.8;
      alpha = 1 - age;
    }

    context.save();
    context.globalAlpha = alpha;
    const step = player.moving ? Math.floor(now / 110) % 2 : 0;
    const body = this.sprites[`body${step}`];
    const bounce = player.moving ? (step ? unit : 0) : 0;
    // Sombra.
    context.fillStyle = 'rgba(0, 0, 0, 0.28)';
    context.fillRect(left + 3 * unit, top + 14 * unit, 10 * unit, 2 * unit);
    // Cuerpo (camiseta del color del jugador encima de una base gris).
    context.drawImage(body, left, top - rise - bounce, tile, tile);
    context.fillStyle = flash ? '#ffffff' : player.color;
    context.fillRect(left + 5 * unit, top + 9 * unit - rise - bounce, 6 * unit, 3 * unit);
    // Cabeza pixelada (12x12) que asoma por encima de la casilla.
    const head = this.heads.get(player.playerId);

    if (head) {
      context.drawImage(head.canvas, left + 2 * unit, top - 3 * unit - rise - bounce, 12 * unit, 12 * unit);
    }

    if (flash) {
      context.globalCompositeOperation = 'source-atop';
      context.fillStyle = 'rgba(255, 255, 255, 0.85)';
      context.fillRect(left, top - 4 * unit - rise, tile, tile + 4 * unit);
    }

    context.restore();

    // Marca para encontrarse a uno mismo: flechita encima.
    if (player.mine && player.alive) {
      const bob = Math.round(Math.sin(now / 200) * unit);
      context.fillStyle = '#ffe14d';
      context.strokeStyle = '#000';
      context.beginPath();
      context.moveTo(left + tile / 2 - 3 * unit, top - 7 * unit + bob);
      context.lineTo(left + tile / 2 + 3 * unit, top - 7 * unit + bob);
      context.lineTo(left + tile / 2, top - 4 * unit + bob);
      context.closePath();
      context.fill();
      context.lineWidth = Math.max(1, unit / 2);
      context.stroke();
    }
  }

  private drawName(player: BoardPlayer): void {
    const context = this.context;
    const tile = this.tile;
    const text = player.mine ? 'Tú' : player.name;
    const size = Math.max(9, Math.min(13, Math.round(tile * 0.32)));
    context.font = `900 ${size}px monospace`;
    const width = Math.min(tile * 2.4, context.measureText(text).width + 6);
    const x = this.originX + (player.x + 0.5) * tile - width / 2;
    const y = this.originY + (player.y + 1) * tile + 1;
    context.fillStyle = player.mine ? 'rgba(255, 225, 77, 0.92)' : 'rgba(0, 0, 0, 0.6)';
    context.fillRect(Math.round(x), Math.round(y), Math.round(width), size + 3);
    context.fillStyle = player.mine ? '#000' : '#fff';
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillText(text, Math.round(x + width / 2), Math.round(y + 1), width - 4);
  }

  /** Foto reducida a 10x10 (pixelada) dentro de un circulo, con borde del color del jugador. */
  private paintHead(canvas: HTMLCanvasElement, color: string, image: HTMLImageElement | null, name: string): void {
    const context = canvas.getContext('2d')!;
    context.clearRect(0, 0, 12, 12);
    const face = document.createElement('canvas');
    face.width = 10;
    face.height = 10;
    const faceContext = face.getContext('2d')!;

    if (image && image.naturalWidth) {
      // Recorte cuadrado centrado y reducido con suavizado (para que la foto se reconozca en pocos pixeles).
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      faceContext.imageSmoothingEnabled = true;
      faceContext.imageSmoothingQuality = 'high';
      faceContext.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 10, 10);
    } else {
      faceContext.fillStyle = '#f3cfa8';
      faceContext.fillRect(0, 0, 10, 10);
      faceContext.fillStyle = '#000';
      faceContext.fillRect(3, 4, 1, 2);
      faceContext.fillRect(6, 4, 1, 2);
      faceContext.fillRect(3, 7, 4, 1);
    }

    // Mascara circular pixel a pixel (sin bordes suaves): se pinta aparte y se aplica de una vez (con
    // destination-in, cada relleno suelto borraria todo lo demas).
    const mask = document.createElement('canvas');
    mask.width = 10;
    mask.height = 10;
    const maskContext = mask.getContext('2d')!;
    maskContext.fillStyle = '#000';

    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        if ((x - 4.5) ** 2 + (y - 4.5) ** 2 <= 25.5) {
          maskContext.fillRect(x, y, 1, 1);
        }
      }
    }

    faceContext.globalCompositeOperation = 'destination-in';
    faceContext.drawImage(mask, 0, 0);

    // Borde de 1 pixel del color del jugador y contorno negro.
    for (let y = 0; y < 12; y += 1) {
      for (let x = 0; x < 12; x += 1) {
        const distance = Math.sqrt((x - 5.5) ** 2 + (y - 5.5) ** 2);

        if (distance > 4.9 && distance <= 5.9) {
          context.fillStyle = color;
          context.fillRect(x, y, 1, 1);
        } else if (distance > 5.9 && distance <= 6.6) {
          context.fillStyle = '#111';
          context.fillRect(x, y, 1, 1);
        }
      }
    }

    context.drawImage(face, 1, 1);

    if (!image) {
      context.fillStyle = '#000';
      context.font = '900 6px monospace';
      context.textAlign = 'center';
      context.fillText((name[0] || '?').toUpperCase(), 6, 3);
    }
  }

  /* --------------------------------- Llamas --------------------------------- */

  /** Brazo de llama pixel art: capas roja, naranja, amarilla y blanca que adelgazan al apagarse. */
  private drawFlame(x: number, y: number, shape: FlameShape, age: number): void {
    const context = this.context;
    const unit = this.tile / SPRITE;
    const left = this.originX + x * this.tile;
    const top = this.originY + y * this.tile;
    // Grosor (en pixeles del sprite) de cada capa: crece rapido y se va estrechando.
    const grow = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
    const layers: Array<[number, string]> = [
      [12, '#d6260c'],
      [9, '#ff7a00'],
      [6, '#ffd23f'],
      [3, '#fffbe0'],
    ];
    const flicker = Math.floor(age * 20) % 2;
    // Al final se desvanece (en vez de quedarse en un hilo fino).
    context.globalAlpha = Math.min(1, grow * 2.5);

    for (const [thickness, color] of layers) {
      // Las capas que ya se han apagado no se pintan (sin hilos sueltos al final).
      const width = Math.round(thickness * grow) - flicker;

      if (width <= 0) {
        continue;
      }

      const offset = (SPRITE - width) / 2;
      context.fillStyle = color;
      const rect = (rx: number, ry: number, rw: number, rh: number) =>
        context.fillRect(Math.floor(left + rx * unit), Math.floor(top + ry * unit), Math.ceil(rw * unit), Math.ceil(rh * unit));
      // Punta redondeada: el brazo mantiene su grosor y en los ultimos pixeles se estrecha en arco (pixel a pixel).
      const tip = (horizontal: boolean, reversed: boolean) => {
        for (let t = 0; t < SPRITE; t += 1) {
          const taper = t < TIP_START ? 1 : Math.sqrt(Math.max(0, 1 - ((t - TIP_START + 0.5) / TIP_LENGTH) ** 2));
          const size = Math.round(width * taper);

          if (size <= 0) {
            continue;
          }

          const along = reversed ? SPRITE - 1 - t : t;
          const across = (SPRITE - size) / 2;

          if (horizontal) {
            rect(along, across, 1, size);
          } else {
            rect(across, along, size, 1);
          }
        }
      };

      switch (shape) {
        case 'h':
          rect(0, offset, SPRITE, width);
          break;
        case 'v':
          rect(offset, 0, width, SPRITE);
          break;
        case 'center':
          rect(0, offset, SPRITE, width);
          rect(offset, 0, width, SPRITE);
          rect(offset - 1, offset - 1, width + 2, width + 2);
          break;
        case 'end-left':
          tip(true, true);
          break;
        case 'end-right':
          tip(true, false);
          break;
        case 'end-up':
          tip(false, true);
          break;
        case 'end-down':
          tip(false, false);
          break;
      }
    }

    context.globalAlpha = 1;
  }

  private drawRubble(x: number, y: number, age: number): void {
    if (age < 0 || age >= 1) {
      return;
    }

    const context = this.context;
    const unit = this.tile / SPRITE;
    const left = this.originX + x * this.tile;
    const top = this.originY + y * this.tile;

    for (let piece = 0; piece < 8; piece += 1) {
      const angle = (piece / 8) * Math.PI * 2 + noise(x * 31 + y * 17 + piece) * 0.6;
      const distance = age * 9 * unit;
      const px = left + 8 * unit + Math.cos(angle) * distance;
      const py = top + 8 * unit + Math.sin(angle) * distance - Math.sin(age * Math.PI) * 4 * unit;
      context.fillStyle = piece % 2 ? '#8a4f22' : '#c58a4c';
      context.globalAlpha = 1 - age;
      context.fillRect(Math.round(px), Math.round(py), Math.ceil(2 * unit), Math.ceil(2 * unit));
    }

    context.globalAlpha = 1;
  }

  /* --------------------------------- Sprites -------------------------------- */

  private buildSprites(): Record<string, HTMLCanvasElement> {
    const floor = (shade: string, other: string, seed: number) =>
      sprite((px) => {
        px(0, 0, shade, 16, 16);

        for (let index = 0; index < 18; index += 1) {
          px(Math.floor(noise(seed + index) * 16), Math.floor(noise(seed + index * 7.3) * 16), other);
        }

        // Matas de hierba.
        px(3, 4, '#4f9a37');
        px(4, 3, '#4f9a37');
        px(11, 11, '#4f9a37');
        px(12, 10, '#4f9a37');
      });

    const sprites: Record<string, HTMLCanvasElement> = {
      floorA: floor('#6cbf4a', '#7dcf59', 1),
      floorB: floor('#64b444', '#74c552', 9),
      // Pared exterior: ladrillos grises.
      wall: sprite((px) => {
        px(0, 0, '#7a7f8a', 16, 16);

        for (let row = 0; row < 4; row += 1) {
          px(0, row * 4 + 3, '#4b4f57', 16, 1);
          const shift = row % 2 ? 4 : 0;

          for (let column = shift; column < 16; column += 8) {
            px(column, row * 4, '#4b4f57', 1, 3);
          }

          px(0, row * 4, '#9aa0aa', 16, 1);
        }
      }),
      // Columna: bloque metalico con relieve.
      column: sprite((px) => {
        px(0, 0, '#3a3f48', 16, 16);
        px(0, 0, '#9ea6b6', 15, 1);
        px(0, 0, '#9ea6b6', 1, 15);
        px(1, 1, '#6a7282', 14, 14);
        px(1, 14, '#2c3038', 15, 1);
        px(14, 1, '#2c3038', 1, 14);
        px(4, 4, '#555d6c', 8, 8);
        px(4, 4, '#8a93a3', 8, 1);
        px(4, 4, '#8a93a3', 1, 8);
        px(3, 3, '#c8cfdb');
        px(12, 3, '#c8cfdb');
        px(3, 12, '#c8cfdb');
        px(12, 12, '#c8cfdb');
      }),
      // Piedra destructible: bloque de ladrillo marron con grietas.
      stone: sprite((px) => {
        px(0, 0, '#6b3d1a', 16, 16);
        const bricks: Array<[number, number, number]> = [
          [1, 1, 6],
          [8, 1, 7],
          [1, 5, 3],
          [5, 5, 6],
          [12, 5, 3],
          [1, 9, 6],
          [8, 9, 7],
          [1, 13, 3],
          [5, 13, 6],
          [12, 13, 3],
        ];

        for (const [x, y, w] of bricks) {
          px(x, y, '#b9783e', w, 3);
          px(x, y, '#d79a5c', w, 1);
          px(x + w - 1, y + 1, '#94592a', 1, 2);
        }

        px(9, 6, '#4a2810');
        px(10, 7, '#4a2810');
        px(10, 8, '#4a2810');
      }),
      skull: sprite((px) => {
        px(3, 2, '#f2f2f2', 10, 8);
        px(4, 10, '#f2f2f2', 8, 3);
        px(5, 5, '#111', 2, 3);
        px(9, 5, '#111', 2, 3);
        px(7, 9, '#111', 2, 1);
        px(5, 12, '#111', 1, 1);
        px(8, 12, '#111', 1, 1);
        px(10, 12, '#111', 1, 1);
      }),
    };

    // Bomba: bola negra con brillo y mecha; mas grande (latido) y en rojo (a punto de explotar).
    const bomb = (radius: number, fill: string) =>
      sprite((px) => {
        for (let y = 0; y < 16; y += 1) {
          for (let x = 0; x < 16; x += 1) {
            const distance = Math.sqrt((x - 7.5) ** 2 + (y - 9) ** 2);

            if (distance <= radius + 0.6) {
              px(x, y, distance > radius - 0.4 ? '#000' : fill);
            }
          }
        }

        px(5, 6, '#9aa2b4', 2, 1);
        px(4, 7, '#9aa2b4', 1, 2);
        px(8, 3, '#8a8f99', 2, 2);
        px(10, 2, '#c9a46a', 1, 1);
        px(11, 1, '#c9a46a', 1, 1);
        px(12, 2, '#c9a46a', 1, 1);
      });
    sprites['bomb'] = bomb(5.5, '#1f2230');
    sprites['bombBig'] = bomb(6.2, '#1f2230');
    sprites['bombRed'] = bomb(6.2, '#a3121c');

    // Mejoras: baldosa azul con el icono (llama = mas alcance; bomba = una bomba mas).
    const tileBase = (px: (x: number, y: number, color: string, w?: number, h?: number) => void) => {
      px(1, 1, '#111', 14, 14);
      px(2, 2, '#2b5fd9', 12, 12);
      px(2, 2, '#6f97f2', 12, 1);
      px(2, 2, '#6f97f2', 1, 12);
    };
    sprites['powerRadius'] = sprite((px) => {
      tileBase(px);
      px(7, 3, '#d6260c', 2, 1);
      px(6, 4, '#d6260c', 4, 2);
      px(5, 6, '#ff7a00', 6, 3);
      px(4, 9, '#ff7a00', 8, 2);
      px(5, 11, '#ff7a00', 6, 1);
      px(6, 7, '#ffd23f', 4, 3);
      px(7, 10, '#ffd23f', 2, 1);
      px(7, 8, '#fffbe0', 2, 2);
    });
    sprites['powerBombs'] = sprite((px) => {
      tileBase(px);

      for (let y = 5; y < 13; y += 1) {
        for (let x = 4; x < 12; x += 1) {
          if ((x - 7.5) ** 2 + (y - 8.5) ** 2 <= 12.5) {
            px(x, y, '#111');
          }
        }
      }

      px(6, 7, '#9aa2b4', 1, 1);
      px(9, 4, '#c9a46a', 1, 1);
      px(10, 3, '#ffd23f', 1, 1);
      px(11, 10, '#fff', 3, 1);
      px(12, 9, '#fff', 1, 3);
    });

    // Cuerpo (dos pasos de animacion): piernas y brazos; la camiseta se pinta encima con el color del jugador.
    const body = (stepLeft: boolean) =>
      sprite((px) => {
        px(5, 8, '#111', 6, 5);
        px(4, 9, '#111', 1, 3);
        px(11, 9, '#111', 1, 3);
        px(4, 9, '#f3cfa8', 1, 2);
        px(11, 9, '#f3cfa8', 1, 2);
        px(5, 12, '#3b4150', 6, 1);
        px(stepLeft ? 5 : 6, 13, '#2c313c', 2, 2);
        px(stepLeft ? 9 : 8, 13, '#2c313c', 2, 2);
        px(stepLeft ? 4 : 5, 15, '#111', 3, 1);
        px(stepLeft ? 9 : 8, 15, '#111', 3, 1);
      });
    sprites['body0'] = body(false);
    sprites['body1'] = body(true);
    return sprites;
  }

  /* --------------------------------- Medidas -------------------------------- */

  /** Casilla de tamano entero (cuadricula exacta) que quepa en el hueco libre, centrada. */
  private layout(size: number): void {
    const usableWidth = Math.max(80, this.width - this.insets.left - this.insets.right);
    const usableHeight = Math.max(80, this.height - this.insets.top - this.insets.bottom);
    this.tile = Math.max(8, Math.floor(Math.min(usableWidth / size, usableHeight / size)));
    this.originX = Math.round(this.insets.left + (usableWidth - this.tile * size) / 2);
    this.originY = Math.round(this.insets.top + (usableHeight - this.tile * size) / 2);
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
