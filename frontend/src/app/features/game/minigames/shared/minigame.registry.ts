import { Type } from '@angular/core';
import { MathOperationsComponent } from '../math-operations/math-operations.component';
import { PaintComponent } from '../paint/paint.component';
import { PlantillaMinijuegoComponent } from '../plantilla-minijuego/plantilla-minijuego.component';

export const MINIGAME_COMPONENTS: Record<string, Type<any>> = {
  'math-operations': MathOperationsComponent,
  'paint': PaintComponent,
  'plantilla': PlantillaMinijuegoComponent,
};
