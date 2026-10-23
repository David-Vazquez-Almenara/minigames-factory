import type * as ThreeModule from 'three';
import { MiiRig } from './mii-rig';

type Three = typeof ThreeModule;

// Caras del crupier (imagenes locales en public/assets/dealer). Normalmente lleva la cara normal y, con un 30 % de
// probabilidad, una de las otras al azar. Cualquier minijuego con crupier debe crearlo con createDealerRig para que
// esta regla se cumpla siempre.
export const DEALER_FACE_NORMAL = 'assets/dealer/cara-normal.png';
export const DEALER_FACES_RARE = ['assets/dealer/cara-rara-1.png', 'assets/dealer/cara-rara-2.png', 'assets/dealer/cara-rara-3.png'];
export const DEALER_RARE_CHANCE = 0.3;

// Mismo tono de piel que la cabeza de los Mii.
const SKIN = '#f3cfa8';
const TEXTURE_SIZE = 512;

/** Numero entre 0 y 1 a partir de un texto (FNV-1a): el mismo texto da el mismo numero en todos los clientes. */
function seededRandom(seed: string, salt: number): number {
  let hash = (2166136261 ^ salt) >>> 0;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  return hash / 4294967296;
}

/**
 * Cara del crupier para una ronda. La semilla (sala + ronda) hace que todos los jugadores vean la misma cara y que
 * cambie de una partida o ronda a otra.
 */
export function pickDealerFace(seed: string): string {
  if (seededRandom(seed, 1) >= DEALER_RARE_CHANCE) {
    return DEALER_FACE_NORMAL;
  }

  return DEALER_FACES_RARE[Math.floor(seededRandom(seed, 2) * DEALER_FACES_RARE.length)];
}

/** El crupier de los minijuegos: un Mii vestido de negro, con pajarita y una de sus caras. */
export function createDealerRig(THREE: Three, seed: string): MiiRig {
  const rig = new MiiRig(THREE, '#1d1d1f', { pantsColor: '#121214', bowTie: true });

  void createDealerFaceTexture(THREE, pickDealerFace(seed)).then((texture) => {
    if (texture) {
      rig.setFaceTexture(texture);
    }
  });

  return rig;
}

/**
 * Las caras son dibujos en negro sobre fondo claro: se pintan "multiplicando" sobre la piel, asi el fondo blanco
 * desaparece y solo quedan los rasgos. La imagen se encaja entera (sin recortar) en el centro de la cara.
 */
async function createDealerFaceTexture(THREE: Three, url: string): Promise<ThreeModule.Texture | null> {
  const image = await loadImage(url);

  if (!image) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext('2d')!;
  context.fillStyle = SKIN;
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const scale = Math.min((TEXTURE_SIZE * 0.92) / image.naturalWidth, (TEXTURE_SIZE * 0.92) / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  context.globalCompositeOperation = 'multiply';
  context.drawImage(image, (TEXTURE_SIZE - width) / 2, (TEXTURE_SIZE - height) / 2, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth ? image : null);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
