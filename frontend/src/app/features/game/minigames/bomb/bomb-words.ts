// Reglas de las palabras encadenadas de Patata caliente (las mismas que comprueba el servidor).

export type BombWordProblem = 'format' | 'chain' | 'used';

/** Minusculas y sin tildes (la ñ se mantiene). */
export function normalizeBombWord(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ñ/g, '\u0001')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'ñ');
}

/** Finales de la palabra anterior por los que puede empezar la siguiente: las 3, 2 o 1 ultimas letras. */
export function chainEndings(previous: string): string[] {
  return [3, 2, 1].filter((size) => size <= previous.length).map((size) => previous.slice(-size));
}

/** null si la palabra vale; si no, el motivo. */
export function bombWordProblem(word: string, previous: string, used: ReadonlySet<string>, minLength = 3, maxLength = 24): BombWordProblem | null {
  if (!/^[a-zñ]+$/.test(word) || word.length < minLength || word.length > maxLength || !/[aeiou]/.test(word) || /(.)\1\1/.test(word)) {
    return 'format';
  }

  // Empieza por uno de los finales (vale aunque sea solo eso: "rio" despues de "armario").
  const chains = chainEndings(previous).some((ending) => word.startsWith(ending));

  if (!chains) {
    return 'chain';
  }

  return used.has(word) ? 'used' : null;
}

export function bombProblemText(problem: BombWordProblem, previous: string): string {
  switch (problem) {
    case 'chain': {
      const endings = chainEndings(previous).map((ending) => `«${ending.toUpperCase()}»`);
      return `Tiene que empezar por ${endings.join(', ')}.`;
    }
    case 'used':
      return '¡Esa palabra ya ha salido!';
    default:
      return 'Solo letras: mínimo 3 y una palabra de verdad.';
  }
}
