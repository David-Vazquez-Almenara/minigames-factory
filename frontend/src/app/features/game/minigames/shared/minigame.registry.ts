import { Type } from '@angular/core';
import { MathOperationsComponent } from '../math-operations/math-operations.component';
import { PaintComponent } from '../paint/paint.component';
import { PlantillaMinijuegoComponent } from '../plantilla-minijuego/plantilla-minijuego.component';
import { SimonSaysComponent } from '../simon-says/simon-says.component';
import { LowerHigherMinijuegoComponent } from '../lower-higher/lower-higher-minijuego.component';


/*
 ⚠️  Los minijuegos 'math-operations' y 'paint' tienen lógica especial
      en el service (legada). No borrar sus entradas del registry.
 */
export const MINIGAME_COMPONENTS: Record<string, Type<any>> = {
  // ── Legacy (no modificar su lógica en minigame.service.ts) ──
  'math-operations': MathOperationsComponent,
  'paint': PaintComponent,

  // ── Minijuegos genéricos (añadir aquí los nuevos) ──────────
  'plantilla': PlantillaMinijuegoComponent,
  "simon-says": SimonSaysComponent,
  "lower-higher": LowerHigherMinijuegoComponent,
};