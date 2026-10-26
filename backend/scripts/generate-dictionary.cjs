// Genera la lista de palabras en espanol de Patata caliente (backend/data/palabras-es.txt.gz) a partir del
// diccionario Hunspell de LibreOffice (proyecto RLA-ES: es_ES.aff y es_ES.dic, licencia GPL/LGPL/MPL).
// Expande las reglas de prefijos y sufijos (plurales, femeninos, conjugaciones...) y guarda cada forma sin tildes
// y en minusculas (la ñ se mantiene), una por linea y ordenadas, para buscarlas con busqueda binaria.
// Los nombres propios (empiezan por mayuscula) no se incluyen.
//
// Uso: node scripts/generate-dictionary.cjs ruta/es_ES.aff ruta/es_ES.dic
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [affPath, dicPath] = process.argv.slice(2);

if (!affPath || !dicPath) {
  console.error('Uso: node scripts/generate-dictionary.cjs es_ES.aff es_ES.dic');
  process.exit(1);
}

/** Igual que en el juego: minusculas, sin tildes (la ñ se mantiene, la ü pasa a u). */
function normalize(word) {
  return word.toLowerCase().replace(/ñ/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\u0001/g, 'ñ');
}

// Reglas de afijos: { flag: { type, cross, rules: [{ strip, add, contFlags, test }] } }.
const affixes = new Map();

for (const line of fs.readFileSync(affPath, 'utf8').split(/\r?\n/)) {
  const parts = line.trim().split(/\s+/);

  if ((parts[0] !== 'SFX' && parts[0] !== 'PFX') || parts.length < 4) {
    continue;
  }

  const [type, flag] = parts;

  if (!affixes.has(flag) && /^[YN]$/.test(parts[2])) {
    affixes.set(flag, { type, cross: parts[2] === 'Y', rules: [] });
    continue;
  }

  const affix = affixes.get(flag);

  if (!affix || parts.length < 5) {
    continue;
  }

  const strip = parts[2] === '0' ? '' : parts[2];
  const [addText, contText = ''] = parts[3].split('/');
  const add = addText === '0' ? '' : addText;
  const condition = parts[4] === '.' ? '' : parts[4];
  const test = condition ? new RegExp(type === 'SFX' ? `${condition}$` : `^${condition}`, 'u') : null;
  affix.rules.push({ strip, add, contFlags: [...contText], test });
}

/** Aplica un afijo a una palabra: las formas que salen, con las banderas de continuacion de cada regla. */
function apply(word, flag) {
  const affix = affixes.get(flag);
  const out = [];

  if (!affix) {
    return out;
  }

  for (const rule of affix.rules) {
    if (rule.test && !rule.test.test(word)) {
      continue;
    }

    if (affix.type === 'SFX') {
      if (rule.strip && !word.endsWith(rule.strip)) {
        continue;
      }

      out.push({ word: word.slice(0, word.length - rule.strip.length) + rule.add, contFlags: rule.contFlags, cross: affix.cross });
    } else {
      if (rule.strip && !word.startsWith(rule.strip)) {
        continue;
      }

      out.push({ word: rule.add + word.slice(rule.strip.length), contFlags: rule.contFlags, cross: affix.cross });
    }
  }

  return out;
}

const words = new Set();
const add = (word) => {
  const normalized = normalize(word);

  if (/^[a-zñ]{2,}$/.test(normalized)) {
    words.add(normalized);
  }
};

const dicLines = fs.readFileSync(dicPath, 'utf8').split(/\r?\n/).slice(1);

for (const line of dicLines) {
  const entry = line.trim().split(/\s+/)[0];

  if (!entry) {
    continue;
  }

  const slash = entry.indexOf('/');
  const stem = slash < 0 ? entry : entry.slice(0, slash);
  const flags = slash < 0 ? [] : [...entry.slice(slash + 1)];

  // Nombres propios y siglas fuera.
  if (stem[0] !== stem[0].toLowerCase()) {
    continue;
  }

  add(stem);
  const suffixFlags = flags.filter((flag) => affixes.get(flag)?.type === 'SFX');
  const prefixFlags = flags.filter((flag) => affixes.get(flag)?.type === 'PFX');
  // Formas con sufijo (y un segundo nivel con las banderas de continuacion).
  const suffixed = [];

  for (const flag of suffixFlags) {
    for (const form of apply(stem, flag)) {
      add(form.word);
      suffixed.push(form);

      for (const cont of form.contFlags.filter((item) => affixes.get(item)?.type === 'SFX')) {
        for (const second of apply(form.word, cont)) {
          add(second.word);
        }
      }
    }
  }

  // Prefijos sobre la raiz y, si ambos lo permiten, sobre las formas con sufijo.
  for (const flag of prefixFlags) {
    const prefix = affixes.get(flag);

    for (const form of apply(stem, flag)) {
      add(form.word);
    }

    if (prefix.cross) {
      for (const base of suffixed.filter((item) => item.cross)) {
        for (const form of apply(base.word, flag)) {
          add(form.word);
        }
      }
    }
  }
}

const sorted = [...words].sort();
const outDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'palabras-es.txt.gz');
fs.writeFileSync(outFile, zlib.gzipSync(sorted.join('\n'), { level: 9 }));
console.log(`${sorted.length} palabras -> ${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(2)} MB)`);
