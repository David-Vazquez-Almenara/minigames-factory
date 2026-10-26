import { computed, effect, Injectable, inject, signal } from '@angular/core';
import {
  LobbyPlayer,
  LobbyState,
  MathOperationPayload,
  MinigameResultPayload,
  PaintTargetPayload,
  RoomResponse,
  ScoreboardCalculateRequest,
  ScoreboardPayload,
  SocketService,
} from './socket.service';

const LEGACY_MATCH_KEYS = ['matchData', 'questionRoundBackup', 'quien-soy-online-scoreboard'];
const HOST_RECONNECT_LOBBY_KEY = 'quien-soy-online-host-reconnect-lobby';
const BANNED_PLAYERS_KEY = 'quien-soy-online-banned-players';

@Injectable({ providedIn: 'root' })
export class MatchService {
  private readonly socketService = inject(SocketService);
  private readonly calculatedScoreboardKey = signal('');

  readonly match = this.socketService.match;
  readonly lobby = this.socketService.lobby;
  readonly privateState = this.socketService.privateState;
  readonly hostPauseDeadline = this.socketService.hostPauseDeadline;
  readonly scoreboard = this.socketService.scoreboard;
  readonly scoreboardCalculateRequest = this.socketService.scoreboardCalculateRequest;
  readonly currentPlayerId = this.socketService.playerId;
  readonly pinturilloFrame = this.socketService.pinturilloFrame;
  readonly lastPogoJump = this.socketService.lastPogoJump;
  readonly crossyPositions = this.socketService.crossyPositions;
  readonly bombermanMoves = this.socketService.bombermanMoves;
  readonly snakeMoves = this.socketService.snakeMoves;
  readonly raceSamples = this.socketService.raceSamples;

  readonly totalPlayers = computed(() => this.match()?.totalPlayers || 0);
  readonly hostPaused = computed(() => Boolean(this.match()?.hostPaused));
  readonly isHost = computed(() => this.socketService.isCurrentPlayerHost(this.lobby()));
  readonly playersById = computed(
    () => new Map<string, LobbyPlayer>((this.lobby()?.players || []).map((player) => [player.id, player])),
  );

  constructor() {
    effect(() => {
      const request = this.socketService.scoreboardCalculateRequest();
      const lobby = this.socketService.lobby();
      const match = this.socketService.match();

      if (
        !request ||
        !lobby ||
        !match ||
        request.lobbyId !== lobby.code ||
        request.roundNumber !== match.roundNumber ||
        match.phase !== 'scoreboard' ||
        match.scoreboard ||
        !this.socketService.isCurrentPlayerHost(lobby)
      ) {
        return;
      }

      // La clave evita recalcular (y volver a sumar) la misma ronda si llegan eventos duplicados.
      const scoreboardKey = `${request.lobbyId}:${request.roundNumber}:${(request.results || [])
        .map((result) => `${result.playerId}-${result.points ?? ''}-${result.correctCount}-${result.finishedAt}`)
        .join('|')}`;

      if (scoreboardKey === this.calculatedScoreboardKey()) {
        return;
      }

      this.calculatedScoreboardKey.set(scoreboardKey);
      const scoreboard = this.calculateOfficialMinigameScoreboard(lobby, request);
      this.saveOfficialScoreboard(scoreboard);
      void this.socketService.updateScoreboard(lobby.code, request.roundNumber, scoreboard.scores);
    });
  }

  async startMatch(lobby: LobbyState): Promise<RoomResponse> {
    if (this.socketService.isCurrentPlayerHost(lobby)) {
      this.cleanOldHostMatchStorage(lobby.code);
      this.socketService.saveHostForRoom(lobby.code);
      this.socketService.prepareHostReconnectSnapshot(lobby);
    }

    return this.socketService.startMatch(lobby.code);
  }

  playerName(playerId: string | null | undefined): string {
    return (playerId && this.playersById().get(playerId)?.name) || 'Jugador';
  }

  playerColor(playerId: string | null | undefined): string {
    return (playerId && this.playersById().get(playerId)?.color) || 'gray';
  }

  playerAvatar(playerId: string | null | undefined): string {
    return (playerId && this.playersById().get(playerId)?.avatarUrl) || '';
  }

  isPlayerActive(playerId: string | null | undefined): boolean {
    return Boolean(playerId && this.playersById().get(playerId)?.active);
  }

  continueFromScoreboard(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.continueFromScoreboard(lobbyId);
  }

  continueFromSpecialRound(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.continueFromSpecialRound(lobbyId);
  }

  returnToLobby(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.returnToLobby(lobbyId);
  }

  prepareMinigame(lobbyId: string, operations: MathOperationPayload[]): Promise<RoomResponse> {
    return this.socketService.prepareMinigame(lobbyId, operations);
  }

  submitMinigameProgress(
    lobbyId: string,
    progress: { answeredCount: number; correctCount: number; completed: boolean; finishedAt: number | null },
  ): Promise<RoomResponse> {
    return this.socketService.submitMinigameProgress(lobbyId, progress);
  }

  preparePaintMinigame(lobbyId: string, paintTarget: PaintTargetPayload): Promise<RoomResponse> {
    return this.socketService.preparePaintMinigame(lobbyId, paintTarget);
  }

  submitPaintDrawing(lobbyId: string, imageDataUrl: string): Promise<RoomResponse> {
    return this.socketService.submitPaintDrawing(lobbyId, imageDataUrl);
  }

  submitPaintVote(lobbyId: string, targetPlayerId: string): Promise<RoomResponse> {
    return this.socketService.submitPaintVote(lobbyId, targetPlayerId);
  }

  advanceImpostorTurn(lobbyId: string, turnIndex: number): Promise<RoomResponse> {
    return this.socketService.advanceImpostorTurn(lobbyId, turnIndex);
  }

  voteImpostor(lobbyId: string, targetId: string): Promise<RoomResponse> {
    return this.socketService.voteImpostor(lobbyId, targetId);
  }

  spinTenBut(lobbyId: string): Promise<RoomResponse> {
    return this.socketService.spinTenBut(lobbyId);
  }

  answerTenBut(lobbyId: string, answer: number): Promise<RoomResponse> {
    return this.socketService.answerTenBut(lobbyId, answer);
  }

  sendPinturilloFrame(lobbyId: string, imageDataUrl: string): void {
    this.socketService.sendPinturilloFrame(lobbyId, imageDataUrl);
  }

  requestPinturilloFrame(lobbyId: string): Promise<void> {
    return this.socketService.requestPinturilloFrame(lobbyId);
  }

  guessPinturillo(lobbyId: string, text: string) {
    return this.socketService.guessPinturillo(lobbyId, text);
  }

  pogoJump(lobbyId: string, gain: number) {
    return this.socketService.pogoJump(lobbyId, gain);
  }

  betBlackjack(lobbyId: string, handNumber: number, amount: number) {
    return this.socketService.betBlackjack(lobbyId, handNumber, amount);
  }

  blackjackAction(lobbyId: string, action: 'hit' | 'stand', turnToken: string) {
    return this.socketService.blackjackAction(lobbyId, action, turnToken);
  }

  stopBarrel(lobbyId: string, roundId: string, elapsedMs: number) {
    return this.socketService.stopBarrel(lobbyId, roundId, elapsedMs);
  }

  pumpBalloon(lobbyId: string, turnToken: string) {
    return this.socketService.pumpBalloon(lobbyId, turnToken);
  }

  passBalloon(lobbyId: string, turnNumber: number) {
    return this.socketService.passBalloon(lobbyId, turnNumber);
  }

  voteCup(lobbyId: string, round: number, slot: number) {
    return this.socketService.voteCup(lobbyId, round, slot);
  }

  chooseLane(lobbyId: string, round: number, lane: number) {
    return this.socketService.chooseLane(lobbyId, round, lane);
  }

  answerCount(lobbyId: string, value: number) {
    return this.socketService.answerCount(lobbyId, value);
  }

  duelShot(lobbyId: string, round: number, shot: { reactionMs: number } | { foul: true }) {
    return this.socketService.duelShot(lobbyId, round, shot);
  }

  towerProgress(lobbyId: string, level: number, state: { lost?: boolean; finished?: boolean } = {}) {
    return this.socketService.towerProgress(lobbyId, level, state);
  }

  golfShot(lobbyId: string, round: number, shot: { angle: number; power: number; holed: boolean; distance: number; rollMs: number }) {
    return this.socketService.golfShot(lobbyId, round, shot);
  }

  reportOrder(lobbyId: string, round: number, success: boolean, ms: number) {
    return this.socketService.reportOrder(lobbyId, round, success, ms);
  }

  bowlingThrow(lobbyId: string, pins: number, aim: number, spin: number) {
    return this.socketService.bowlingThrow(lobbyId, pins, aim, spin);
  }

  whoVote(lobbyId: string, round: number, targetId: string) {
    return this.socketService.whoVote(lobbyId, round, targetId);
  }

  crossyMove(lobbyId: string, move: { row: number; col: number; dead?: boolean }) {
    return this.socketService.crossyMove(lobbyId, move);
  }

  javelinThrow(lobbyId: string, shot: { angle: number; power: number; landX: number }) {
    return this.socketService.javelinThrow(lobbyId, shot);
  }

  russianAction(lobbyId: string, turnNumber: number, action: 'shoot' | 'skip') {
    return this.socketService.russianAction(lobbyId, turnNumber, action);
  }

  bombWord(lobbyId: string, turn: number, word: string, usedMs: number) {
    return this.socketService.bombWord(lobbyId, turn, word, usedMs);
  }

  bombBoom(lobbyId: string, turn: number) {
    return this.socketService.bombBoom(lobbyId, turn);
  }

  cannonPick(lobbyId: string, round: number, zone: number) {
    return this.socketService.cannonPick(lobbyId, round, zone);
  }

  racePosition(lobbyId: string, x: number, y: number, a: number, p: number, i: number, c: number, s: number) {
    this.socketService.racePosition(lobbyId, x, y, a, p, i, c, s);
  }

  raceFinish(lobbyId: string, timeMs: number) {
    return this.socketService.raceFinish(lobbyId, timeMs);
  }

  snakeMove(lobbyId: string, x: number, y: number, s: number) {
    this.socketService.snakeMove(lobbyId, x, y, s);
  }

  snakeDead(lobbyId: string) {
    return this.socketService.snakeDead(lobbyId);
  }

  bombermanMove(lobbyId: string, x: number, y: number, s: number) {
    this.socketService.bombermanMove(lobbyId, x, y, s);
  }

  bombermanBomb(lobbyId: string, x: number, y: number, placedAt: number) {
    return this.socketService.bombermanBomb(lobbyId, x, y, placedAt);
  }

  bombermanDead(lobbyId: string, at: number) {
    return this.socketService.bombermanDead(lobbyId, at);
  }

  quizAnswer(lobbyId: string, round: number, choice: number) {
    return this.socketService.quizAnswer(lobbyId, round, choice);
  }

  pushAim(lobbyId: string, round: number, vx: number, vy: number, confirm: boolean) {
    return this.socketService.pushAim(lobbyId, round, vx, vy, confirm);
  }

  pushResult(lobbyId: string, result: Parameters<SocketService['pushResult']>[1]) {
    return this.socketService.pushResult(lobbyId, result);
  }

  reportChop(lobbyId: string, veggies: number) {
    return this.socketService.reportChop(lobbyId, veggies);
  }

  releaseSwing(lobbyId: string, turnIndex: number, angle: number, dir: 1 | -1) {
    return this.socketService.releaseSwing(lobbyId, turnIndex, angle, dir);
  }

  throwBeer(lobbyId: string, power: number, round: number) {
    return this.socketService.throwBeer(lobbyId, power, round);
  }

  stopStopwatch(lobbyId: string, round: number, elapsedMs: number) {
    return this.socketService.stopStopwatch(lobbyId, round, elapsedMs);
  }

  reportDance(lobbyId: string, round: number, result: 'done' | 'fail') {
    return this.socketService.reportDance(lobbyId, round, result);
  }

  serverNow(): number {
    return this.socketService.serverNow();
  }

  clearMatchState(): void {
    this.socketService.clearMatch();
    this.calculatedScoreboardKey.set('');
  }

  private calculateOfficialMinigameScoreboard(lobby: LobbyState, request: ScoreboardCalculateRequest): ScoreboardPayload {
    const results = request.results || [];
    const previousScores = new Map((request.previousScores || []).map((score) => [score.playerId, score.score]));
    const lobbyOrder = new Map(lobby.players.map((player, index) => [player.id, index]));
    const roundPoints = this.calculateMinigamePoints(results);
    const resultMap = new Map(results.map((result) => [result.playerId, result]));
    const usesExplicitPoints = results.some((result) => result.points !== undefined);

    const scores = lobby.players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      score: (previousScores.get(player.id) || 0) + (roundPoints.get(player.id) || 0),
      roundPoints: roundPoints.get(player.id) || 0,
      position: 0,
      minigameCorrectCount: usesExplicitPoints ? undefined : resultMap.get(player.id)?.correctCount || 0,
      minigameAnsweredCount: usesExplicitPoints ? undefined : resultMap.get(player.id)?.answeredCount || 0,
      minigameVoteCount: usesExplicitPoints ? undefined : resultMap.get(player.id)?.votesReceived,
    }));

    scores.sort((firstPlayer, secondPlayer) => {
      if (secondPlayer.score !== firstPlayer.score) {
        return secondPlayer.score - firstPlayer.score;
      }

      return (lobbyOrder.get(firstPlayer.playerId) || 0) - (lobbyOrder.get(secondPlayer.playerId) || 0);
    });

    return {
      lobbyId: lobby.code,
      roundNumber: request.roundNumber,
      scores: scores.map((score, index) => ({
        ...score,
        position: index + 1,
      })),
    };
  }

  private calculateMinigamePoints(results: MinigameResultPayload[]): Map<string, number> {
    // Los minijuegos con reglas propias (El Impostor, Es un 10) llegan ya puntuados desde el servidor.
    if (results.some((result) => result.points !== undefined)) {
      return new Map(results.map((result) => [result.playerId, Number(result.points || 0)]));
    }

    if (results.some((result) => result.votesReceived !== undefined)) {
      return this.calculatePaintWinnerBonusPoints(results);
    }

    return this.calculateMathBonusPoints(results);
  }

  private calculateMathBonusPoints(results: MinigameResultPayload[]): Map<string, number> {
    const points = new Map<string, number>();
    const submittedResults = results.filter((result) => result.submitted || (result.answeredCount || 0) > 0);

    if (!submittedResults.length || Math.max(...submittedResults.map((result) => result.correctCount || 0)) <= 0) {
      return points;
    }

    const completedResults = submittedResults.filter((result) => result.finishedAt);
    completedResults.sort((firstResult, secondResult) => {
      const timeDifference = Number(firstResult.finishedAt || 0) - Number(secondResult.finishedAt || 0);

      if (timeDifference !== 0) {
        return timeDifference;
      }

      return secondResult.correctCount - firstResult.correctCount;
    });

    const winner = completedResults[0];

    if (winner) {
      points.set(winner.playerId, 30);
    }

    const remainingResults = submittedResults
      .filter((result) => result.playerId !== winner?.playerId)
      .sort((firstResult, secondResult) => secondResult.correctCount - firstResult.correctCount);
    const rankPoints = [20, 10];
    let currentIndex = 0;

    for (const rankPoint of rankPoints) {
      if (currentIndex >= remainingResults.length) {
        break;
      }

      const correctCount = remainingResults[currentIndex].correctCount;
      const tiedResults = remainingResults.filter((result, index) => index >= currentIndex && result.correctCount === correctCount);
      const playerPoint = tiedResults.length === 1 ? rankPoint : tiedResults.length === 2 ? Math.max(5, rankPoint / 2) : 5;

      for (const result of tiedResults) {
        points.set(result.playerId, Math.trunc(playerPoint));
      }

      currentIndex += tiedResults.length;
    }

    return points;
  }

  private calculatePaintWinnerBonusPoints(results: MinigameResultPayload[]): Map<string, number> {
    const points = new Map<string, number>();
    const submittedResults = results.filter((result) => result.submitted && result.votesReceived !== undefined);

    if (!submittedResults.length) {
      return points;
    }

    const maxVotes = Math.max(...submittedResults.map((result) => result.votesReceived || 0));
    const winners = submittedResults.filter((result) => (result.votesReceived || 0) === maxVotes);
    const winnerPoints = winners.length === 1 ? 30 : winners.length === 2 ? 15 : 10;

    for (const winner of winners) {
      points.set(winner.playerId, winnerPoints);
    }

    return points;
  }

  private saveOfficialScoreboard(scoreboard: ScoreboardPayload): void {
    localStorage.setItem(
      HOST_RECONNECT_LOBBY_KEY,
      JSON.stringify({
        lobbyId: scoreboard.lobbyId,
        players: scoreboard.scores.map((score) => ({
          playerId: score.playerId,
          score: score.score,
          position: score.position,
        })),
      }),
    );
  }

  private cleanOldHostMatchStorage(currentLobbyId: string): void {
    for (const key of LEGACY_MATCH_KEYS) {
      localStorage.removeItem(key);
    }

    try {
      const parsedValue = JSON.parse(localStorage.getItem(BANNED_PLAYERS_KEY) || 'null') as { lobbyId?: string } | null;

      if (parsedValue?.lobbyId && parsedValue.lobbyId !== currentLobbyId) {
        localStorage.removeItem(BANNED_PLAYERS_KEY);
      }
    } catch {
      localStorage.removeItem(BANNED_PLAYERS_KEY);
    }
  }
}
