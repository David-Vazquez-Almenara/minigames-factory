import { MathOperationsComponent } from '../math-operations/math-operations.component';
import { PaintComponent } from '../paint/paint.component';
import { MinigameDefinition } from './minigame.models';

export const MINIGAME_DEFINITIONS: MinigameDefinition[] = [
  {
    id: 'math-operations',
    title: 'Operaciones matematicas',
    description:
      'Resuelve las mismas operaciones que el resto. Cuantas mas aciertes y mas rapido termines, mas puntos podras ganar.',
    durationSeconds: 60,
    component: MathOperationsComponent,
  },
  {
    id: 'paint',
    title: 'A Pintar',
    description:
      'Dibuja el objeto secreto y vota despues por la obra que mas se parezca. El mas votado gana mas puntos.',
    durationSeconds: 60,
    component: PaintComponent,
  },
];

export function getMinigameDefinition(minigameId: string | null | undefined): MinigameDefinition | null {
  return MINIGAME_DEFINITIONS.find((definition) => definition.id === minigameId) || null;
}
