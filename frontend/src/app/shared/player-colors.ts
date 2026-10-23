export interface PlayerColor {
  name: string;
  body: string;
  shadow: string;
}

// Los ids coinciden con los que asigna el servidor (PLAYER_COLORS en backend/src/server.js).
export const PLAYER_COLORS: Record<string, PlayerColor> = {
  red: { name: 'Rojo', body: '#c51111', shadow: '#7a0838' },
  blue: { name: 'Azul', body: '#132ed1', shadow: '#09158e' },
  green: { name: 'Verde', body: '#117f2d', shadow: '#0a4d2e' },
  pink: { name: 'Rosa', body: '#ed54ba', shadow: '#ab2bad' },
  orange: { name: 'Naranja', body: '#ef7d0d', shadow: '#b33e15' },
  yellow: { name: 'Amarillo', body: '#f5f557', shadow: '#c38823' },
  black: { name: 'Negro', body: '#3f474e', shadow: '#1e1f26' },
  white: { name: 'Blanco', body: '#d6e0f0', shadow: '#8394bf' },
  purple: { name: 'Morado', body: '#6b2fbb', shadow: '#3b177c' },
  brown: { name: 'Marron', body: '#71491e', shadow: '#5e2615' },
  cyan: { name: 'Cian', body: '#38fedc', shadow: '#24a8be' },
  lime: { name: 'Lima', body: '#50ef39', shadow: '#15a742' },
  maroon: { name: 'Granate', body: '#6b2b3c', shadow: '#41202e' },
  rose: { name: 'Rosado', body: '#ecc0d3', shadow: '#de92b3' },
  banana: { name: 'Platano', body: '#fffebe', shadow: '#d2bc89' },
  gray: { name: 'Gris', body: '#758593', shadow: '#46565f' },
  tan: { name: 'Beige', body: '#928776', shadow: '#51413e' },
  coral: { name: 'Coral', body: '#ec7578', shadow: '#b4435a' },
};

export function getPlayerColor(colorId: string | null | undefined): PlayerColor {
  return PLAYER_COLORS[colorId || ''] || PLAYER_COLORS['gray'];
}
