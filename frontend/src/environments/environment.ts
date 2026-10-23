import { generatedEnv } from './env.generated';

// Los valores salen del .env del frontend (o de las variables de entorno de Netlify).
// env.generated.ts lo crea scripts/generate-env.mjs automaticamente antes de arrancar o compilar.
export const environment = {
  production: generatedEnv.production,
  apiUrl: generatedEnv.apiUrl,
  socketUrl: generatedEnv.socketUrl,
};
