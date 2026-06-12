import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MinigameService } from '../shared/minigame.service';
import { MinigameProgress } from '../shared/minigame.models';
import { MinigameFullscreenDirective } from '../shared/minigame-fullscreen.directive';

// ============================================================
// PLANTILLA DE MINIJUEGO
// ============================================================
//   1. Copia la carpeta `plantilla-minijuego/` entera.
//   2. Renombra los archivos, la clase y el selector.
//   3. Añade el componente a minigame.registry.ts:
//   4. ¡Listo! El service lo detecta automáticamente.
// ----------------------------------------------------------------


@Component({
  selector: 'app-plantilla-minijuego',
  standalone: true,
  imports: [CommonModule, MinigameFullscreenDirective],
  templateUrl: './plantilla-minijuego.component.html',
  styleUrls: ['./plantilla-minijuego.component.css', './config-css-minijuego.component.css.css']
})
export class PlantillaMinijuegoComponent implements OnInit, OnDestroy {




  //=========================================================
  //            DATOS ESTATICOS DEL MINIJUEGO
  //=========================================================

  // DATOS DEL MINIJUEGO (solo lectura, llegan del servidor)  // ⚠️ NO TOCAR

  private readonly minigameService = inject(MinigameService);
  readonly gameInfo = this.minigameService.receiveGameData();
  readonly currentPlayerId = this.minigameService.currentPlayerId;
  get payload() {
    return this.gameInfo?.payload as {
      roundNumber: number;
      minigameId: string;
      title: string;
      description: string;
      preparedByHost: boolean;
      progress: unknown[];
      results: unknown[];
      time: number;
    } | undefined;
  }


  // VARIABLES ESTATICAS // ⚠️ NO TOCAR
  points = 0;
  readonly finished = signal(false);
  roundTime = this.payload?.time ?? 60;
  //=========================================================




  //                     [ ZONA EDITABLE ]
  // ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️







  //=========================================================
  //                LÓGICA DEL MINIJUEGO
  //=========================================================

  /**  FUNCIONES PRINCIPALES MINIJUEGO
  * 
  *   sumarPuntos(cantidad: number)
  * 
  *   finishMinigame()
  * 
  */
  ngOnInit(): void {
  }





  pulsar(): void {
    if (this.finished()) return;

    this.sumarPuntos(1);

    if (this.points >= 10) {
      this.finishMinigame();
    } else {
      this.updateProgress();
    }
  }

















  //  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  
  //                     [ ZONA EDITABLE ]


  //=========================================================
  //        LÓGICA DE PROGRESO Y PUNTUACIÓN ESTATICA
  //=========================================================
  ngOnDestroy(): void {
  }


  sumarPuntos(cantidad: number): void {
    this.points += cantidad;
    this.updateProgress();
  }


  updateProgress(completed = false): void {
    const progress: MinigameProgress = {
      answeredCount: this.points,
      correctCount: this.points,
      completed,
      finishedAt: completed ? Date.now() : null,
    };

    this.minigameService.submitProgress(progress).then((res) => {
      if (!res.ok) console.error('Error al reportar progreso:', res.reason);
    });
  }

  // Llamar a finishMinigame() cuando el jugador termina

  finishMinigame(): void {
    if (this.finished()) return;
    this.finished.set(true);

    this.updateProgress(true); //finishedAt = true

    if (this.minigameService.isHost()) {
      void this.minigameService.submitPoints([
        { playerId: this.minigameService.currentPlayerId, points: this.points * 3 },
      ]);
    }
  }

}