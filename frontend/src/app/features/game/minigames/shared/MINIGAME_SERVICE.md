# MinigameService

Servicio central para que los componentes de minijuego no dependan directamente de sockets, lobby, host/guest, scoreboard o modo test.

| Funcion | Que hace | Ejemplo breve |
| --- | --- | --- |
| `sendGameData(info)` | Envia al resto de jugadores la configuracion generada por el host. Usa los eventos legacy actuales por debajo. | `minigameService.sendGameData({ id: 'paint', time: 60, payload: target })` |
| `receiveGameData()` | Lee la configuracion sincronizada del minijuego activo. | `const info = minigameService.receiveGameData();` |
| `submitProgress(progress)` | Envia progreso generico del jugador actual. | `minigameService.submitProgress({ answeredCount: 3, correctCount: 2, completed: false, finishedAt: null })` |
| `submitPoints(points)` | Centraliza el envio o aplicacion de puntos. Si el host puede actualizar scoreboard, lo hace internamente. | `minigameService.submitPoints([{ playerId, points: 30 }])` |
| `sendPoints(points)` | Alias semantico de `submitPoints` para APIs que diferencian envio y envio final. | `minigameService.sendPoints([{ playerId, points: 10 }])` |
| `receivePoints()` | Devuelve los puntos enviados/registrados localmente por el servicio. | `const points = minigameService.receivePoints();` |
| `startMinigame(info)` | Arranca un minijuego local con jugadores mock para pruebas sin lobby real. | `minigameService.startMinigame({ id: 'math-operations', time: 60, payload: operations })` |
| `buildHostGameInfo()` | Genera la configuracion inicial del minijuego actual cuando el cliente es host. | `const info = minigameService.buildHostGameInfo();` |
| `calculateOfficialMinigameScoreboard(...)` | Calcula el scoreboard oficial de minijuegos manteniendo las reglas existentes. | `const board = minigameService.calculateOfficialMinigameScoreboard(lobby, round, results, previous)` |
| `getScoreboardPresentation()` | Devuelve ganadores o mensaje especial para la pantalla de resultados sin acoplarla a ids concretos. | `const { winners, noWinnerMessage } = minigameService.getScoreboardPresentation();` |
| `prepareMathOperationsMinigame(...)` | Adaptador legacy para preparar Operaciones Matematicas. | `minigameService.prepareMathOperationsMinigame(lobbyId)` |
| `preparePaintMinigame(...)` | Adaptador legacy para preparar A Pintar. | `minigameService.preparePaintMinigame(lobbyId)` |
| `submitPaintDrawing(...)` | Adaptador legacy para enviar un dibujo. | `minigameService.submitPaintDrawing(lobbyId, imageDataUrl)` |
| `submitPaintVote(...)` | Adaptador legacy para votar un dibujo. | `minigameService.submitPaintVote(lobbyId, targetPlayerId)` |

---

## Añadir un nuevo minijuego (solo 2 pasos)

### Paso 1 — Registrar el componente en `minigame.registry.ts`

```ts
// minigame.registry.ts
import { MiNuevoMinijuegoComponent } from '../mi-nuevo-minijuego/mi-nuevo-minijuego.component';

export const MINIGAME_COMPONENTS: Record<string, Type<any>> = {
  'math-operations': MathOperationsComponent, // legacy, no tocar
  'paint': PaintComponent,                    // legacy, no tocar
  'mi-nuevo': MiNuevoMinijuegoComponent,      // <-- añadir aqui
};
```

### Paso 2 — Copiar la plantilla

Copia la carpeta `plantilla-minijuego/` entera, renombra los archivos y la clase,
y personaliza la logica. El service detectara automaticamente el nuevo minijuego por su ID.

---

## Payload que recibe cada minijuego del registry

```ts
// Lo que llega a info.payload en cualquier minijuego que NO sea paint/math-operations:
{
  roundNumber: number;     // Numero de ronda actual
  minigameId: string;      // ID del minijuego
  title: string;           // Titulo para mostrar al jugador
  description: string;     // Descripcion / instrucciones
  preparedByHost: boolean; // true cuando el host ya ha preparado la ronda
  progress: any[];         // Progreso de los jugadores (el host lo ve completo)
  results: any[];          // Resultados finales (el host los ve completo)
}
```

---

## Patron recomendado para un nuevo minijuego

```ts
// En ngOnInit o directamente como propiedad:
readonly gameInfo = this.minigameService.receiveGameData();

// Reportar progreso en tiempo real:
await this.minigameService.submitProgress({
  answeredCount: 1,
  correctCount: 1,
  completed: false,
  finishedAt: null,
});

// Finalizar y enviar puntos (solo el host los calcula):
await this.minigameService.submitProgress({ ..., completed: true, finishedAt: Date.now() });

if (this.minigameService.isHost()) {
  await this.minigameService.submitPoints([{ playerId, points: 30 }]);
}
```

El componente visual solo deberia conocer su `payload`, su estado local y cuando reportar progreso o puntos.

---

## Minijuegos legacy (paint, math-operations)

Estos dos minijuegos tienen logica especial de preparacion en el host (generacion de operaciones
matematicas, seleccion aleatoria de objeto a dibujar, fases de votacion, etc.).
**No tocar** su logica en `minigame.service.ts` sin revisar bien el impacto.
