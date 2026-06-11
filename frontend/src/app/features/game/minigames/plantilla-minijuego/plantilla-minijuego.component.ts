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
  readonly score = signal<number>(0);











  // ==========================================
  // 4. ZONA DE LÓGICA DEL MINIJUEGO
  // ==========================================
  // Aquí va toda la interacción del HTML y la comunicación al MinigameService.

  /**
   * Incrementa la puntuación y reporta el progreso en tiempo real al servicio.
   */
  incrementScore(): void {
    // 1. Lógica interna: sumamos 1 punto local
    this.score.update(s => s + 1);

    // 2. Reportamos el progreso al servicio para sincronizar con la sala/servidor.
    // Usamos la estructura definida en MinigameProgress.
    const progress: MinigameProgress = {
      answeredCount: this.score(), // Respuestas o clics realizados
      correctCount: this.score(),  // Respuestas o clics válidos/correctos
      completed: false,            // ¿Ha terminado el minijuego para este jugador?
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
   * Finaliza el minijuego de forma manual o al expirar los 60 segundos
   * y envía los puntos definitivos para el Scoreboard.
   */
  finishGame(): void {
    const finalPoints = [{
      playerId: this.currentPlayerId,
      points: this.score() // Ejemplo: cada clic vale 10 puntos en el Scoreboard
    }];

    // Enviamos los puntos finales usando submitPoints / sendPoints
    this.minigameService.submitPoints(finalPoints)
      .then(res => {
        console.log('Puntos definitivos enviados:', res);
      });
  }
}
