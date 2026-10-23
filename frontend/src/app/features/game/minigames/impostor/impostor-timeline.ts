// Linea temporal comun de la resolucion de una votacion de El Impostor (en ms desde stageStartedAt).
export const VOTE_REVEAL_MS = 3200;
export const EJECTION_MS = 7000;
export const RESULTS_AT_MS = VOTE_REVEAL_MS + EJECTION_MS;

export interface ImpostorParticipantView {
  id: string;
  name: string;
  color: string;
  active: boolean;
}
