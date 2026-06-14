import { Component, OnInit, OnDestroy, inject, signal, effect } from '@angular/core';
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
  //         ⚠️ DATOS ESTATICOS DEL MINIJUEGO ⚠️
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
      hostMinigameData: any;
    } | undefined;
  }

  ngOnInit(): void {
    if (this.minigameService.isHost()) {
      this.minigamesDataPrepare();
    }
  }


  // VARIABLES ESTATICAS // ⚠️ NO TOCAR
  points = 0;
  readonly finished = signal(false);
  roundTime = this.payload?.time ?? 60;
  hostMinigameData: any;


  // El guest espera a que preparedByHost sea true para leer hostMinigameData,
  private readonly _hostDataEffect = effect(() => {
    const round = this.minigameService.currentRound();
    if (!round?.preparedByHost) return;

    const data = (round as any).hostMinigameData ?? this.payload?.hostMinigameData ?? null;
    if (!this.minigameService.isHost()) {
      this.hostMinigameData = data;
    }
  });

  hostPrepareMinigame(reciveData: object) {
    if (this.minigameService.isHost()) {

      const data = reciveData

      // Lo guardamos localmente en la propiedad
      this.hostMinigameData = data;
      console.log('Host minigame data:', this.hostMinigameData);

      this.minigameService.prepareGenericMinigame(data).then((res) => { if (!res.ok) { console.error('Error al preparar minijuego:', res.reason); } });

      return data;
    }
    return null;
  }

  //=========================================================














  //                   [ ZONA EDITABLE ]
  // ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️ ⬇️










  //=========================================================
  //              CONFIGURACIÓN DEL MINIJUEGO
  //=========================================================

  minigamesDataPrepare() {
    let data: {
      array: number[];
      texto: string;
      objeto: { propiedad1: string; propiedad2: string };
      number: number;
    };

    data = {
      array: [1, 2, 3, 4, 5, 6],
      texto: "Ejemplo",
      objeto: { propiedad1: "valor1", propiedad2: "valor2" },
      number: 0
    }



    this.hostPrepareMinigame(data)
  }








  //=========================================================
  //                LÓGICA DEL MINIJUEGO
  //=========================================================

  /**  FUNCIONES PRINCIPALES MINIJUEGO
  * 
  *   "this.hostMinigameData.X" se usa para datos del minijuego
  * 
  *   sumarPuntos(cantidad: number)
  * 
  *   finishMinigame()
  * 
  */



  pulsar(): void {
    if (this.finished()) return;

    this.sumarPuntos(1);

    if (this.points >= 10) {
      this.finishMinigame();
    } else {
      this.updateProgress();
    }
  }

















  //  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  
  //                   [ ZONA EDITABLE ]





















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