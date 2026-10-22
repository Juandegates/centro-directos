// Ajustes que cambian mientras el Centro funciona (se guardan en ajustes.json, nunca se suben a GitHub).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const ARCHIVO = new URL('./ajustes.json', import.meta.url);

const base = () => ({
  temaAvisos: 'centro-' + randomBytes(8).toString('hex'), // tema privado de ntfy
  secretoSesion: randomBytes(24).toString('hex'),          // firma de la sesión de la app
  botPausado: { twitch: false, youtube: false },
  envioYoutube: true,
  youtube: { streamId: null },
  clipsPublicados: [],
});

let datos = base();
if (existsSync(ARCHIVO)) {
  try { datos = { ...base(), ...JSON.parse(readFileSync(ARCHIVO, 'utf8')) }; } catch { /* archivo dañado: se rehace */ }
}
writeFileSync(ARCHIVO, JSON.stringify(datos, null, 2));

export const ajustes = () => datos;
export function guardarAjustes(cambios = {}) {
  datos = { ...datos, ...cambios };
  writeFileSync(ARCHIVO, JSON.stringify(datos, null, 2));
  return datos;
}
