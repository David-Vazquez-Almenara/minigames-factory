import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MinigameService } from '../shared/minigame.service';
import { MinigameProgress } from '../shared/minigame.models';

// ============================================================
// PLANTILLA DE MINIJUEGO
// ============================================================
// Cómo usar esta plantilla para crear un nuevo minijuego:
//
//   1. Copia la carpeta `plantilla-minijuego/` entera.
//   2. Renombra los archivos, la clase y el selector.
//   3. Añade el componente a minigame.registry.ts:
//        import { MiNuevoComponent } from '../mi-nuevo/mi-nuevo.component';
//        export const MINIGAME_COMPONENTS = {
//          ...
//          'mi-nuevo': MiNuevoComponent,
//        };
//   4. ¡Listo! El service lo detecta automáticamente.
//      No hay que tocar minigame.service.ts para nada más.
//
// ----------------------------------------------------------------
// Qué llega a gameInfo (via minigameService.receiveGameData()):
// {
//   id: "plantilla",
//   time: 60,    // segundos totales del minijuego
//   payload: {
//     roundNumber: 1, // ronda del juego principal
//     minigameId: "plantilla",
//     title: "Plantilla de Minijuego",
//     description: "...",
//     preparedByHost: true | false,   // si el host ya preparó la ronda
//     progress: [],   // progreso de jugadores (completo solo para el host)
//     results: [],   // resultados finales  (completo solo para el host)
//   },
//   metadata: {
//     title: "Plantilla de Minijuego",
//     description: "...",
//     roundNumber: 1,
//     preparedByHost: true | false,
//   }
// }
// ============================================================


@Component({
  selector: 'app-plantilla-minijuego',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './plantilla-minijuego.component.html',
  styleUrl: './plantilla-minijuego.component.css',
})
export class PlantillaMinijuegoComponent implements OnInit, OnDestroy {



//=========================================================
//            DATOS ESTATICOS DEL MINIJUEGO
//=========================================================

  // SERVICIO // ⚠️ NO TOCAR
  private readonly minigameService = inject(MinigameService);



  // DATOS DEL MINIJUEGO (solo lectura, llegan del servidor)  // ⚠️ NO TOCAR
  
  /** Configuración completa del minijuego activo. */
  readonly gameInfo = this.minigameService.receiveGameData();

  /** ID del jugador actual; útil para calcular puntos propios. */
  readonly currentPlayerId = this.minigameService.currentPlayerId;

  /** Payload tipado con los datos específicos de este minijuego. */
  get payload() {
    return this.gameInfo?.payload as {
      roundNumber:    number;
      minigameId:     string;
      title:          string;
      description:    string;
      preparedByHost: boolean;
      progress:       unknown[];
      results:        unknown[];
      time:           number;
    } | undefined;
  }


    // VARIABLES ESTATICAS
    points = 0;
    readonly finished = signal(false);
    roundTime = this.payload?.time ?? 60;
 //=========================================================



 
//                     [ ZONA EDITABLE ]
// ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇  ⬇


















  //=========================================================
  //                LÓGICA DEL MINIJUEGO
  //=========================================================

  ngOnInit(): void {
    console.log('Minijuego cargado con datos:', JSON.parse(JSON.stringify(this.gameInfo)));
  
  
  }
  ngOnDestroy(): void {}




  pulsar(): void {
    if (this.finished()) return;

    this.points += 1;

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

  updateProgress(completed = false): void {
    const progress: MinigameProgress = {
      answeredCount: this.points,
      correctCount:  this.points,
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