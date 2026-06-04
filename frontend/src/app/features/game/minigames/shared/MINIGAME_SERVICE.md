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

## Patron recomendado para un nuevo minijuego

```ts
const info = this.minigameService.receiveGameData();
const payload = info?.payload as MyMinigamePayload;

await this.minigameService.submitProgress({
  answeredCount: 1,
  correctCount: 1,
  completed: true,
  finishedAt: Date.now(),
});
```

El componente visual solo deberia conocer su `payload`, su estado local y cuando reportar progreso o puntos.
