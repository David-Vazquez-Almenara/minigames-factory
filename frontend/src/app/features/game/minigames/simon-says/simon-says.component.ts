import { Component, OnInit, OnDestroy, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MinigameService } from '../shared/minigame.service';
import { MinigameProgress } from '../shared/minigame.models';
import { MinigameFullscreenDirective } from '../shared/minigame-fullscreen.directive';

// ============================================================
// PLANTILLA DE MINIJUEGO
// ============================================================
//   1. Copia la carpeta `simon-says/` entera.
//   2. Renombra los archivos, la clase y el selector.
//   3. Añade el componente a minigame.registry.ts:
//   4. ¡Listo! El service lo detecta automáticamente.
// ----------------------------------------------------------------


@Component({
  selector: 'app-simon-says',
  standalone: true,
  imports: [CommonModule, MinigameFullscreenDirective],
  templateUrl: './simon-says.component.html',
  styleUrls: ['./simon-says.component.css', './config-simon-says.component.css']
})
export class SimonSaysComponent implements OnInit, OnDestroy {




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


    setTimeout(() => {
      this.animatedSequence();
      this.countdownTimer();
      setTimeout(() => {
        this.disableButtons = false;
      }, 2000);
    }, 8000);
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



  //=========================================================
  //              CONFIGURACIÓN DEL MINIJUEGO
  //=========================================================



  minigamesDataPrepare() {
    let data: {
      colorsSequence: number[];
    };

    let selectedColors: number[] = [];

    for (let i = 0; i < 50; i++) {
      selectedColors.push(Math.floor(Math.random() * 4 + 1));
    }

    this.colorsSequence = selectedColors;

    data = {
      colorsSequence: selectedColors
    }
    console.log('Data preparada:', data);


    this.hostPrepareMinigame(data)
  }


  maxScoreGet = 0;
  colorsSequence: number[] = [];
  actualInterval = 0;

  disableButtons = true;

  userCheckIndex: number = 0;






  simoSayTry(buttonAction: number) {
    if (!buttonAction) {
      console.error('Boton no encontrado');
      return;
    }

    const expectedColor = this.colorsSequence[this.userCheckIndex];

    if (buttonAction === expectedColor) {
      this.userCheckIndex++;

      if (this.userCheckIndex > this.actualInterval) {
        console.log("¡Ronda completada con éxito!");

        this.actualInterval++;

        if (this.actualInterval > this.maxScoreGet) {
          this.maxScoreGet = this.actualInterval;
          this.sumarPuntos(1);
        }

        this.userCheckIndex = 0;

        this.startNextRound();
      }
    } else {
      console.log("¡Te equivocaste! Juego reiniciado.");
      this.actualInterval = 0;
      this.userCheckIndex = 0;

      this.failAnimation();

      setTimeout(() => {
        this.startNextRound();
      }, 1150);
    }

    console.log("Puntos: " + this.maxScoreGet);
    console.log("Ronda Actual (Interval): " + this.actualInterval);
  }

  // 3. Función auxiliar para bloquear botones y mostrar la secuencia limpiamente
  async startNextRound() {
    this.disableButtons = true;
    await this.animatedSequence();
    this.disableButtons = false;
    console.log('Botones habilitados para el usuario');
  }


  activarColor: string | null = null;
  async animatedSequence() {
    const colorSequenceForInterval = this.colorsSequence.slice(0, this.actualInterval + 1);

    for (let i = 0; i < colorSequenceForInterval.length; i++) {

      if (i === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }


      let color = '';

      switch (colorSequenceForInterval[i]) {
        case 1:
          color = 'red';
          break;
        case 2:
          color = 'green';
          break;
        case 3:
          color = 'yellow';
          break;
        case 4:
          color = 'blue';
          break;
      }

      this.activarColor = color;

      await new Promise(resolve => setTimeout(resolve, 500));

      this.activarColor = null;

    }
  }


  pressButton(event: Event) {
    const buttonElement = event.currentTarget as HTMLElement;

    buttonElement.classList.add('button-active');

    // Se levanta de forma casi instantánea (60ms)
    setTimeout(() => {
      buttonElement.classList.remove('button-active');
    }, 150);
  }


  failAnimation() {
    console.log('Fail animation');
    const buttons = document.querySelectorAll('.action-btn');

    buttons.forEach((button) => {
      const element = button as HTMLElement;
      element.classList.add('fail-animation');

      setTimeout(() => {
        element.classList.remove('fail-animation');
      }, 500);
    });
  }



















  //  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆   ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  ⬆  
  //                   [ ZONA EDITABLE ]





















  //=========================================================
  //        LÓGICA DE PROGRESO Y PUNTUACIÓN ESTATICA
  //=========================================================
  ngOnDestroy(): void {
  }

  //timer con roundTime y ejecuta finishMinigame al llegar a 0 sin interrumpir el resto de funciones

  countdownTimer() {
    const timerInterval = setInterval(() => {
      this.roundTime--;

      if (this.roundTime <= 0) {
        clearInterval(timerInterval);
        this.finishMinigame();
      }
      console.log("Time: " + this.roundTime);
    }, 1000);
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