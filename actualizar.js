// Actualización desde GitHub con un botón en la app: baja la versión nueva, conserva tus claves,
// sesiones y ajustes, y reinicia el Centro.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION, log } from './estado.js';

const REPO = () => process.env.GITHUB_REPO || 'Juandegates/centro-directos';
const AQUI = fileURLToPath(new URL('./', import.meta.url));
// Nunca se sobrescriben: tus claves, sesiones, memoria, clips y grabaciones.
const PROTEGIDOS = ['claves.txt', 'tokens.json', 'google-tokens.json', 'ajustes.json', 'memoria.json', 'conocidos.json', 'bandeja.json', 'config.json', 'estadisticas.json', 'busquedas.json', 'grabacion', 'clips'];

const cabeceras = (extra = {}) => ({
  'User-Agent': 'centro-directos',
  ...(process.env.GITHUB_TOKEN && !process.env.GITHUB_TOKEN.startsWith('pega_aqui') ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  ...extra,
});

const comparar = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

let ultimaRevision = { hora: 0, version: null, error: null };

export async function revisarVersion(forzar = false) {
  if (!forzar && Date.now() - ultimaRevision.hora < 30 * 60_000) return ultimaRevision;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO()}/contents/package.json?ref=main`, {
      headers: cabeceras({ Accept: 'application/vnd.github.raw+json' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) throw new Error('No tengo acceso al repositorio de GitHub (si es privado, falta GITHUB_TOKEN en claves.txt)');
    if (!res.ok) throw new Error(`GitHub respondió ${res.status}`);
    const version = JSON.parse(await res.text()).version;
    ultimaRevision = { hora: Date.now(), version, hayNueva: comparar(version, VERSION) > 0, error: null };
  } catch (e) {
    ultimaRevision = { hora: Date.now(), version: null, hayNueva: false, error: e.message };
  }
  return ultimaRevision;
}

// Agrega a tu config.json las opciones nuevas, sin tocar lo que ya cambiaste.
function mezclar(tuyo, nuevo) {
  if (typeof tuyo !== 'object' || tuyo === null || Array.isArray(tuyo)) return tuyo;
  const r = { ...tuyo };
  for (const [k, v] of Object.entries(nuevo)) {
    if (!(k in r)) r[k] = v;
    else if (typeof v === 'object' && v !== null && !Array.isArray(v)) r[k] = mezclar(r[k], v);
  }
  return r;
}

export async function actualizar() {
  const res = await fetch(`https://api.github.com/repos/${REPO()}/zipball/main`, { headers: cabeceras(), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`No pude bajar la actualización (GitHub ${res.status})`);
  const temporal = mkdtempSync(join(tmpdir(), 'centro-'));
  const zip = join(temporal, 'nuevo.zip');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const t = spawnSync('tar', ['-xf', zip, '-C', temporal], { windowsHide: true });
  if (t.status !== 0) throw new Error('No pude descomprimir la actualización: ' + (t.stderr?.toString() ?? t.error?.message));
  const carpeta = readdirSync(temporal, { withFileTypes: true }).find((d) => d.isDirectory());
  if (!carpeta) throw new Error('La actualización vino vacía');
  const origen = join(temporal, carpeta.name);

  cpSync(origen, AQUI, {
    recursive: true,
    force: true,
    filter: (ruta) => {
      const rel = relative(origen, ruta);
      return !PROTEGIDOS.includes(rel.split(sep)[0]);
    },
  });

  const configNueva = join(origen, 'config.json');
  const configTuya = join(AQUI, 'config.json');
  if (existsSync(configNueva)) {
    const nueva = JSON.parse(readFileSync(configNueva, 'utf8'));
    const tuya = existsSync(configTuya) ? JSON.parse(readFileSync(configTuya, 'utf8')) : {};
    writeFileSync(configTuya, JSON.stringify(mezclar(tuya, nueva), null, 2) + '\n');
  }
  rmSync(temporal, { recursive: true, force: true });
  const version = JSON.parse(readFileSync(join(AQUI, 'package.json'), 'utf8')).version;
  log(`⬆️ Actualizado a la versión ${version}; reiniciando…`);
  return version;
}
