import type * as ThreeModule from 'three';

type Three = typeof ThreeModule;

export const CARD_WIDTH = 0.46;
export const CARD_HEIGHT = 0.66;

const TEXTURE_WIDTH = 220;
const TEXTURE_HEIGHT = Math.round((TEXTURE_WIDTH * CARD_HEIGHT) / CARD_WIDTH);
const SUIT_SYMBOLS: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED = '#d0162e';
const BLACK = '#161616';
const FONT = '"Trebuchet MS", Arial, sans-serif';

// Posicion de los simbolos (x, y relativos al area central) de las cartas numericas.
const PIPS: Record<string, Array<[number, number]>> = {
  '2': [[0.5, 0], [0.5, 1]],
  '3': [[0.5, 0], [0.5, 0.5], [0.5, 1]],
  '4': [[0, 0], [1, 0], [0, 1], [1, 1]],
  '5': [[0, 0], [1, 0], [0.5, 0.5], [0, 1], [1, 1]],
  '6': [[0, 0], [1, 0], [0, 0.5], [1, 0.5], [0, 1], [1, 1]],
  '7': [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0, 1], [1, 1]],
  '8': [[0, 0], [1, 0], [0.5, 0.25], [0, 0.5], [1, 0.5], [0.5, 0.75], [0, 1], [1, 1]],
  '9': [[0, 0], [1, 0], [0, 1 / 3], [1, 1 / 3], [0.5, 0.5], [0, 2 / 3], [1, 2 / 3], [0, 1], [1, 1]],
  '10': [[0, 0], [1, 0], [0.5, 1 / 6], [0, 1 / 3], [1, 1 / 3], [0, 2 / 3], [1, 2 / 3], [0.5, 5 / 6], [0, 1], [1, 1]],
};

const FACE_COLORS: Record<string, string> = { J: '#a8e8ff', Q: '#ffc4dc', K: '#fff0a8' };

/** Una carta en la escena: el grupo exterior se coloca y orienta; el interior gira para voltearla. */
export interface CardMesh {
  group: ThreeModule.Group;
  flipper: ThreeModule.Group;
  face: ThreeModule.Mesh;
}

/**
 * Sistema de cartas compartido por toda la mesa: una sola geometria (rectangulo redondeado), un dorso y
 * una textura por carta distinta, creada la primera vez que aparece y reutilizada despues.
 */
export class CardFactory {
  readonly geometry: ThreeModule.ShapeGeometry;
  readonly backMaterial: ThreeModule.MeshStandardMaterial;
  private readonly faceMaterials = new Map<string, ThreeModule.MeshStandardMaterial>();
  private readonly textures: ThreeModule.Texture[] = [];

  constructor(
    private readonly THREE: Three,
    private readonly anisotropy: number,
  ) {
    const T = THREE;
    const shape = new T.Shape();
    const width = CARD_WIDTH;
    const height = CARD_HEIGHT;
    const radius = 0.05;
    const x = -width / 2;
    const y = -height / 2;
    shape.moveTo(x + radius, y);
    shape.lineTo(x + width - radius, y);
    shape.quadraticCurveTo(x + width, y, x + width, y + radius);
    shape.lineTo(x + width, y + height - radius);
    shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    shape.lineTo(x + radius, y + height);
    shape.quadraticCurveTo(x, y + height, x, y + height - radius);
    shape.lineTo(x, y + radius);
    shape.quadraticCurveTo(x, y, x + radius, y);
    this.geometry = new T.ShapeGeometry(shape, 6);

    // ShapeGeometry usa las coordenadas de la forma como UV: se normalizan a 0..1 para la textura.
    const position = this.geometry.attributes['position'];
    const uv = this.geometry.attributes['uv'];

    for (let index = 0; index < position.count; index += 1) {
      uv.setXY(index, (position.getX(index) - x) / width, (position.getY(index) - y) / height);
    }

    this.backMaterial = new T.MeshStandardMaterial({ map: this.texture(drawBack()), roughness: 0.55 });
  }

  createCard(): CardMesh {
    const T = this.THREE;
    const group = new T.Group();
    const flipper = new T.Group();
    // Cara hacia arriba (+Y) con la parte de arriba de la carta hacia -Z; el dorso, justo debajo.
    const face = new T.Mesh(this.geometry, this.backMaterial);
    face.rotation.x = -Math.PI / 2;
    face.position.y = 0.002;
    const back = new T.Mesh(this.geometry, this.backMaterial);
    back.rotation.x = Math.PI / 2;
    back.position.y = -0.002;
    flipper.add(face, back);
    group.add(flipper);
    return { group, flipper, face };
  }

  /** Material de la cara de una carta (rango + palo), compartido por todas las cartas iguales. */
  faceMaterial(rank: string, suit: string): ThreeModule.MeshStandardMaterial {
    const key = `${rank}${suit}`;
    let material = this.faceMaterials.get(key);

    if (!material) {
      material = new this.THREE.MeshStandardMaterial({ map: this.texture(drawFace(rank, suit)), roughness: 0.5 });
      this.faceMaterials.set(key, material);
    }

    return material;
  }

  dispose(): void {
    this.geometry.dispose();
    this.backMaterial.dispose();

    for (const material of this.faceMaterials.values()) {
      material.dispose();
    }

    for (const texture of this.textures) {
      texture.dispose();
    }

    this.faceMaterials.clear();
  }

  private texture(canvas: HTMLCanvasElement): ThreeModule.Texture {
    const texture = new this.THREE.CanvasTexture(canvas);
    texture.colorSpace = this.THREE.SRGBColorSpace;
    texture.anisotropy = this.anisotropy;
    this.textures.push(texture);
    return texture;
  }
}

function createCanvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_WIDTH;
  canvas.height = TEXTURE_HEIGHT;
  return [canvas, canvas.getContext('2d')!];
}

function drawFace(rank: string, suit: string): HTMLCanvasElement {
  const [canvas, context] = createCanvas();
  const width = TEXTURE_WIDTH;
  const height = TEXTURE_HEIGHT;
  const color = suit === 'H' || suit === 'D' ? RED : BLACK;
  const symbol = SUIT_SYMBOLS[suit] || '?';

  context.fillStyle = '#fffdf8';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#d8cfc0';
  context.lineWidth = 6;
  context.strokeRect(3, 3, width - 6, height - 6);
  context.fillStyle = color;
  context.textAlign = 'center';
  context.textBaseline = 'middle';

  // Indices de las esquinas (el de abajo, girado), grandes para leerse desde lejos.
  const drawIndex = () => {
    context.font = `900 ${rank === '10' ? 50 : 60}px ${FONT}`;
    context.fillText(rank, 36, 44);
    context.font = `48px ${FONT}`;
    context.fillText(symbol, 36, 92);
  };
  drawIndex();
  context.save();
  context.translate(width, height);
  context.rotate(Math.PI);
  drawIndex();
  context.restore();

  if (FACE_COLORS[rank]) {
    // Figuras: marco de color con la letra grande y el palo.
    context.fillStyle = FACE_COLORS[rank];
    context.fillRect(64, 58, width - 128, height - 116);
    context.strokeStyle = '#000';
    context.lineWidth = 4;
    context.strokeRect(64, 58, width - 128, height - 116);
    context.fillStyle = color;
    context.font = `900 110px ${FONT}`;
    context.fillText(rank, width / 2, height / 2 - 26);
    context.font = `76px ${FONT}`;
    context.fillText(symbol, width / 2, height / 2 + 64);
  } else if (rank === 'A') {
    context.font = `150px ${FONT}`;
    context.fillText(symbol, width / 2, height / 2 + 6);
  } else {
    const pips = PIPS[rank] || [];
    const left = 76;
    const right = width - 76;
    const top = 66;
    const bottom = height - 66;
    context.font = `56px ${FONT}`;

    for (const [px, py] of pips) {
      const cx = left + (right - left) * px;
      const cy = top + (bottom - top) * py;

      // Los simbolos de la mitad inferior van girados, como en una baraja real.
      if (py > 0.5) {
        context.save();
        context.translate(cx, cy);
        context.rotate(Math.PI);
        context.fillText(symbol, 0, 0);
        context.restore();
      } else {
        context.fillText(symbol, cx, cy);
      }
    }
  }

  return canvas;
}

function drawBack(): HTMLCanvasElement {
  const [canvas, context] = createCanvas();
  const width = TEXTURE_WIDTH;
  const height = TEXTURE_HEIGHT;

  context.fillStyle = '#fffdf8';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#ff6f9f';
  context.fillRect(14, 14, width - 28, height - 28);

  // Rejilla de rombos en tono claro.
  context.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  context.lineWidth = 4;

  for (let offset = -height; offset < width + height; offset += 26) {
    context.beginPath();
    context.moveTo(offset, 14);
    context.lineTo(offset + height, height + 14);
    context.moveTo(offset, height + 14);
    context.lineTo(offset + height, 14);
    context.stroke();
  }

  context.strokeStyle = '#fffdf8';
  context.lineWidth = 8;
  context.strokeRect(26, 26, width - 52, height - 52);
  context.fillStyle = '#fffdf8';
  context.beginPath();
  context.arc(width / 2, height / 2, 44, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#ff6f9f';
  context.font = `900 54px ${FONT}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('★', width / 2, height / 2 + 2);
  return canvas;
}
