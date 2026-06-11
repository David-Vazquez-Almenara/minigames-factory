import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MinigameService } from '../shared/minigame.service';
import { MinigameProgress } from '../shared/minigame.models';

@Component({
  selector: 'app-plantilla-minijuego',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './plantilla-minijuego.component.html',
  styleUrl: './plantilla-minijuego.component.css'
})
export class PlantillaMinijuegoComponent implements OnInit, OnDestroy {



  // ==========================================
  // 1. ZONA DE INYECCIONES Y SERVICIOS
  // ==========================================
  private readonly minigameService = inject(MinigameService);
  


  // ==========================================
  // 2. ZONA DE VARIABLES/ESTADO "ESTÁTICO"
  // ==========================================
  // Lógica y variables del contenedor o compartidas que se inician al cargar
  // el juego pero que no cambian en su estructura de control.
  readonly gameInfo = this.minigameService.receiveGameData();
  readonly currentPlayerId = this.minigameService.currentPlayerId;

  ngOnInit(): void {
    // Aquí puedes inicializar timers de cuenta atrás, música o configuraciones locales usando gameInfo.
    console.log('Minijuego cargado con datos:', this.gameInfo);
  }

  ngOnDestroy(): void {
    // Limpieza de suscripciones, intervalos o timeouts locales si los hay.
  }



  // ==========================================
  // 3. ZONA DE VARIABLES DE ESTADO (LOCAL)
  // ==========================================
  // Coloca aquí las variables específicas de la lógica de tu minijuego.
  points = 0;











  // ==========================================
  // 4. ZONA DE LÓGICA DEL MINIJUEGO
  // ==========================================
  // Aquí va toda la interacción del HTML y la comunicación al MinigameService.

  /**
   * Incrementa la puntuación y reporta el progreso en tiempo real al servicio.
   */


  pulsar(){
        this.points = this.points + 1;

    if(this.points >= 10){
      this.finishMinigame();
    }else{
      this.updateProgress();
    }
  }






  // ================================================
  // 5. ZONA de actualizaciones para el servicio (Maneja puntos )
  // ================================================

  updateProgress(completed?: boolean): void {
    const progress: MinigameProgress = {
      answeredCount: this.points, // Respuestas o clics realizados
      correctCount: this.points,  // Respuestas o clics válidos/correctos
      completed: completed || false,            // ¿Ha terminado el minijuego para este jugador?
      finishedAt: null             // Timestamp de cuándo terminó (si aplica)
    };

    this.minigameService.submitProgress(progress)
      .then(res => {
        if (!res.ok) {
          console.error('Error al reportar progreso:', res.reason);
        }
      });
  }









  // ================================================
  // 5. ZONA DE finalizacion DEL MINIJUEGO "ESTATICO"
  // ================================================

  /**
   *Funcion que al ejecutarse finaliza el minijuego para el jugador, reportando el progreso final y cualquier resultado necesario para parar el juego al resto de jugadores y en el caso de ser el host, obtener los datos de los jugadores.  
   */

  //Creo que con esto acaba para todo el mundo la ronda, pero asegurate con siguiedo el siguiente comentario:
   //Haz algo "simple", que con una fincion de "finishMinigame" o algo asi, vaya todo solo y mande al scoreboard y demás, sin necesidad de tener que programarlo todo a mano, para que sea más fácil de implementar y no se tenga que estar pendiente de cada fase del juego, sino que con esa función ya se encargue de todo el proceso de datos y finalización del minijuego.
  finishMinigame(): void {
    this.updateProgress(true); // Reporta el progreso final indicando que el minijuego ha terminado para este jugador.
    
    // Si el jugador es el host, recopila puntos, calcula scoreboard y manda al resto al scoreboard.
  if (this.minigameService.isHost()) {        
  }
}
}









