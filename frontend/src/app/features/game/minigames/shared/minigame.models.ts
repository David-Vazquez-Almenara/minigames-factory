import { Type } from '@angular/core';
import {
  LobbyState,
  MinigameResultPayload,
  RoomResponse,
  ScoreboardPayload,
  SpecialRoundPayload,
} from '../../../../core/services/socket.service';

export type MinigameId = 'math-operations' | 'paint' | string;
export type MinigamePhase = 'preparing' | 'intro' | 'explanation' | 'playing' | 'voting' | 'finished' | 'scoreboard';

export interface MinigameInfo<TPayload = unknown, TMetadata = unknown> {
  id: MinigameId;
  time: number;
  payload?: TPayload;
  metadata?: TMetadata;
}

export interface MinigameProgress {
  answeredCount: number;
  correctCount: number;
  completed: boolean;
  finishedAt: number | null;
}

export interface MinigamePoints {
  playerId: string;
  points: number;
}

export interface MinigameResult extends MinigameResultPayload {}

export interface MinigameWinner {
  playerId: string;
  playerName: string;
  metricLabel: string;
  imageDataUrl?: string;
}

export interface MinigameScoreboardPresentation {
  winners: MinigameWinner[];
  noWinnerMessage: string;
}

export interface MinigameDefinition<TPayload = unknown, TMetadata = unknown> {
  id: MinigameId;
  title: string;
  description: string;
  durationSeconds: number;
  component: Type<unknown>;
  buildGameInfo?: (context: {
    lobby: LobbyState;
    specialRound: SpecialRoundPayload;
  }) => MinigameInfo<TPayload, TMetadata>;
  calculatePoints?: (
    results: MinigameResultPayload[],
    previousScoreboard: ScoreboardPayload | null,
    lobby: LobbyState,
  ) => MinigamePoints[];
  prepare?: (lobbyId: string, info: MinigameInfo<TPayload, TMetadata>) => Promise<RoomResponse>;
}
