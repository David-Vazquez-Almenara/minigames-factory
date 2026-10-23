// Genera src/environments/env.generated.ts a partir de las variables de entorno.
//
// Prioridad: variables del sistema (p. ej. las del panel de Netlify) > archivo .env del frontend > valores locales.
// Se ejecuta solo antes de `npm start`, `npm run build`, `npm run watch` y `npm test` (scripts "pre*" de package.json).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, '.env');
const outputFile = resolve(root, 'src/environments/env.generated.ts');
const LOCAL_BACKEND_URL = 'http://localhost:3000';

function parseEnvFile(path) {
  if (!existsSync(path)) {
    return {};
  }

  const values = {};

  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#') || !line.includes('=')) {
      continue;
    }

    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

const isNetlify = process.env.NETLIFY === 'true';
// En Netlify solo cuentan las variables del panel: un .env subido por error nunca llega a produccion.
const fileValues = isNetlify ? {} : parseEnvFile(envFile);
const read = (key) => process.env[key] ?? fileValues[key] ?? '';
const backendUrl = read('BACKEND_URL').replace(/\/+$/, '');
const socketUrl = (read('SOCKET_URL') || backendUrl).replace(/\/+$/, '');

// En Netlify no se permite caer al valor local: desplegaria una web apuntando a localhost.
if (isNetlify && !backendUrl) {
  console.error('[generate-env] Falta BACKEND_URL. Definela en Netlify: Site configuration > Environment variables.');
  process.exit(1);
}

const config = {
  production: read('PRODUCTION') ? read('PRODUCTION') === 'true' : isNetlify,
  apiUrl: backendUrl || LOCAL_BACKEND_URL,
  socketUrl: socketUrl || backendUrl || LOCAL_BACKEND_URL,
};

writeFileSync(
  outputFile,
  `// Archivo generado por scripts/generate-env.mjs a partir del .env / variables de entorno. No editar a mano.\n` +
    `export const generatedEnv = ${JSON.stringify(config, null, 2)} as const;\n`,
);

console.log(`[generate-env] backend: ${config.apiUrl} | socket: ${config.socketUrl} | production: ${config.production}`);
