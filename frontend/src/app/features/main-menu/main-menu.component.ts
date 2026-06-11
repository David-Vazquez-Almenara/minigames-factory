import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule, NgIf } from '@angular/common';
import { BackendWakeService } from '../../core/services/backend-wake.service';
import { ConfigService } from '../../core/services/config.service';
import { SocketService, LobbyState, MatchState } from '../../core/services/socket.service';
import { BackendWakeOverlayComponent } from '../../shared/components/backend-wake-overlay/backend-wake-overlay.component';
import { GameScreenComponent } from '../game/game-screen/game-screen.component';
import { GameSetupFlowComponent } from '../game-setup/game-setup-flow.component';
import { SettingsModalComponent } from '../settings/settings-modal.component';

@Component({
  selector: 'app-main-menu',
  imports: [BackendWakeOverlayComponent, GameScreenComponent, GameSetupFlowComponent, SettingsModalComponent, NgIf],
  templateUrl: './main-menu.component.html',
  styleUrl: './main-menu.component.scss',
})
export class MainMenuComponent implements OnInit {
  private readonly backendWakeService = inject(BackendWakeService);
  private readonly configService = inject(ConfigService);
  private readonly socketService = inject(SocketService);

  readonly config = computed(() => this.configService.config());
  readonly backendStatus = this.backendWakeService.status;
  readonly backendSleeping = this.backendWakeService.sleeping;
  readonly socketConnected = this.socketService.connected;
  readonly serverMessage = this.socketService.serverMessage;
  readonly match = this.socketService.match;
  readonly showSettings = signal(false);
  readonly setupMode = signal<'create' | 'join' | null>(null);
  readonly setupRoomCode = signal('');
  readonly setupAutoJoin = signal(false);

  readonly youtubeUrl = 'https://www.youtube.com/';
  readonly githubUrl = 'https://github.com/David-Vazquez-Almenara/quien-es-quien_Angular_NodeJS';

  constructor() {
    effect(() => {
      if (this.backendWakeService.online()) {
        this.socketService.connect();
      }
    });
  }

  ngOnInit(): void {
    this.backendWakeService.startMonitoring();
    this.openLobbyFromUrl();
  }

  createRoom(): void {
    this.socketService.clearRoomNotices();
    this.setupRoomCode.set('');
    this.setupAutoJoin.set(false);
    this.setupMode.set('create');
  }

  joinRoom(): void {
    this.socketService.clearRoomNotices();
    this.setupRoomCode.set('');
    this.setupAutoJoin.set(false);
    this.setupMode.set('join');
  }

  openSettings(): void {
    this.showSettings.set(true);
  }

  closeSettings(): void {
    this.showSettings.set(false);
  }


  closeSetup(): void {
    this.setupMode.set(null);
    this.setupRoomCode.set('');
    this.setupAutoJoin.set(false);
  }

  openSocial(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }



  private openLobbyFromUrl(): void {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    const inLobby = params.get('lobby') === 'true';

    if (!roomCode || !inLobby) {
      return;
    }

    this.setupRoomCode.set(roomCode.toUpperCase());
    this.setupAutoJoin.set(true);
    this.setupMode.set('join');
  }





  showMinigameSelect = false;
  openMinigameSelect(bollean: boolean) {
    if (bollean == true) {
      this.showMinigameSelect = true;
    } else {
      this.showMinigameSelect = false;
    }
  }

  startPaintTest(): void {
    const userPlayerId = this.socketService.playerId;

    const mockLobby: LobbyState = {
      code: 'TEST_ROOM',
      hostId: userPlayerId,
      players: [
        { id: userPlayerId, name: 'Jugador (Tú)', joinedAt: new Date().toISOString(), active: true, ready: true },
        { id: 'sofia-ai', name: 'Sofia (AI)', joinedAt: new Date().toISOString(), active: true, ready: true },
        { id: 'mateo-ai', name: 'Mateo (AI)', joinedAt: new Date().toISOString(), active: true, ready: true }
      ],
      settings: {
        customQuestionsEnabled: false,
        randomThemePerPlayer: false,
        randomCharacterTypePerPlayer: false,
        questionDuration: 30,
        respondQuestionTime: 10,
        rounds: 5,
        specialRounds: [1],
        minigamesOnly: true,
        themeCategories: [],
        characterTypes: []
      },
      createdAt: new Date().toISOString()
    };

    const mockMatch: MatchState = {
      lobbyId: 'TEST_ROOM',
      phase: 'special-round',
      totalPlayers: 3,
      assignments: [],
      readySelections: [],
      readyCount: 3,
      hostPaused: false,
      hostPauseDeadline: null,
      countdownEndsAt: 0,
      imageSelectionEndsAt: 0,
      waitingPlayerIds: [],
      questionRoundNumber: 1,
      questionSelectionEndsAt: null,
      selectedQuestions: [],
      questionOptionsByPlayer: [],
      questionHistory: [],
      customQuestionEditingPlayerIds: [],
      customQuestionDeadlineByPlayer: [],
      currentAnswer: null,
      answerEndsAt: null,
      answerResults: [],
      waitingQuestionBatchPlayerIds: [],
      scoreboard: null,
      specialRounds: [1],
      specialRound: {
        roundNumber: 1,
        minigameId: 'paint',
        title: 'A Pintar',
        description: 'Dibuja el objeto secreto y vota despues por la obra que mas se parezca. El mas votado gana mas puntos.',
        preparedByHost: false,
        paintTarget: null,
        paintPhase: 'preparing',
        paintEndsAt: null,
        paintVoteEndsAt: null,
        paintSubmissions: [],
        paintVotes: [],
        progress: [],
        results: []
      }
    };

    this.socketService.lobby.set(mockLobby);
    this.socketService.match.set(mockMatch);
    this.showMinigameSelect = false;
  }

  startMathTest(): void {
    const userPlayerId = this.socketService.playerId;

    const mockLobby: LobbyState = {
      code: 'TEST_ROOM',
      hostId: userPlayerId,
      players: [
        { id: userPlayerId, name: 'Jugador (Tú)', joinedAt: new Date().toISOString(), active: true, ready: true },
        { id: 'sofia-ai', name: 'Sofia (AI)', joinedAt: new Date().toISOString(), active: true, ready: true },
        { id: 'mateo-ai', name: 'Mateo (AI)', joinedAt: new Date().toISOString(), active: true, ready: true }
      ],
      settings: {
        customQuestionsEnabled: false,
        randomThemePerPlayer: false,
        randomCharacterTypePerPlayer: false,
        questionDuration: 30,
        respondQuestionTime: 10,
        rounds: 5,
        specialRounds: [1],
        minigamesOnly: true,
        themeCategories: [],
        characterTypes: []
      },
      createdAt: new Date().toISOString()
    };

    const mockMatch: MatchState = {
      lobbyId: 'TEST_ROOM',
      phase: 'special-round',
      totalPlayers: 3,
      assignments: [],
      readySelections: [],
      readyCount: 3,
      hostPaused: false,
      hostPauseDeadline: null,
      countdownEndsAt: 0,
      imageSelectionEndsAt: 0,
      waitingPlayerIds: [],
      questionRoundNumber: 1,
      questionSelectionEndsAt: null,
      selectedQuestions: [],
      questionOptionsByPlayer: [],
      questionHistory: [],
      customQuestionEditingPlayerIds: [],
      customQuestionDeadlineByPlayer: [],
      currentAnswer: null,
      answerEndsAt: null,
      answerResults: [],
      waitingQuestionBatchPlayerIds: [],
      scoreboard: null,
      specialRounds: [1],
      specialRound: {
        roundNumber: 1,
        minigameId: 'math-operations',
        title: 'Operaciones matematicas',
        description: 'Resuelve las mismas operaciones que el resto. Cuantas mas aciertes y mas rapido termines, mas puntos podras ganar.',
        preparedByHost: false,
        paintTarget: null,
        paintPhase: null,
        paintEndsAt: null,
        paintVoteEndsAt: null,
        paintSubmissions: [],
        paintVotes: [],
        progress: [],
        results: []
      }
    };

    this.socketService.lobby.set(mockLobby);
    this.socketService.match.set(mockMatch);
    this.showMinigameSelect = false;
  }

  startTemplateTest(): void {
    const userPlayerId = this.socketService.playerId;

    const mockLobby: LobbyState = {
      code: 'TEST_ROOM',
      hostId: userPlayerId,
      players: [
        { id: userPlayerId, name: 'Jugador (Tú)', joinedAt: new Date().toISOString(), active: true, ready: true },
        { id: 'sofia-ai', name: 'Sofia (AI)', joinedAt: new Date().toISOString(), active: true, ready: true },
        { id: 'mateo-ai', name: 'Mateo (AI)', joinedAt: new Date().toISOString(), active: true, ready: true }
      ],
      settings: {
        customQuestionsEnabled: false,
        randomThemePerPlayer: false,
        randomCharacterTypePerPlayer: false,
        questionDuration: 30,
        respondQuestionTime: 10,
        rounds: 5,
        specialRounds: [1],
        minigamesOnly: true,
        themeCategories: [],
        characterTypes: []
      },
      createdAt: new Date().toISOString()
    };

    const mockMatch: MatchState = {
      lobbyId: 'TEST_ROOM',
      phase: 'special-round',
      totalPlayers: 3,
      assignments: [],
      readySelections: [],
      readyCount: 3,
      hostPaused: false,
      hostPauseDeadline: null,
      countdownEndsAt: 0,
      imageSelectionEndsAt: 0,
      waitingPlayerIds: [],
      questionRoundNumber: 1,
      questionSelectionEndsAt: null,
      selectedQuestions: [],
      questionOptionsByPlayer: [],
      questionHistory: [],
      customQuestionEditingPlayerIds: [],
      customQuestionDeadlineByPlayer: [],
      currentAnswer: null,
      answerEndsAt: null,
      answerResults: [],
      waitingQuestionBatchPlayerIds: [],
      scoreboard: null,
      specialRounds: [1],
      specialRound: {
        roundNumber: 1,
        minigameId: 'plantilla',
        title: 'Plantilla de Minijuego',
        description: 'Pulsa el boton en el centro para sumar puntos y probar la plantilla.',
        preparedByHost: false,
        paintTarget: null,
        paintPhase: null,
        paintEndsAt: null,
        paintVoteEndsAt: null,
        paintSubmissions: [],
        paintVotes: [],
        progress: [],
        results: []
      }
    };

    this.socketService.lobby.set(mockLobby);
    this.socketService.match.set(mockMatch);
    this.showMinigameSelect = false;
  }
}
