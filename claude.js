// Claude (con tu plan Max) desde la PC: usa Claude Code en modo "sin ventana" (-p) para revisar
// los videos antes de publicarlos. Claude ve las imágenes del clip (archivos .jpg) y responde en JSON.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { marcar, log } from './estado.js';

let rutaCache = null;
function rutaClaude(config) {
  if (config.herramientas?.claude) return config.herramientas.claude;
  if (rutaCache) return rutaCache;
  const casa = process.env.USERPROFILE || process.env.HOME || '';
  const candidatos = [
    join(casa, '.local', 'bin', 'claude.exe'),
    join(casa, '.local', 'bin', 'claude'),
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'claude.cmd'),
  ].filter(Boolean);
  rutaCache = candidatos.find((r) => existsSync(r)) ?? null;
  if (!rutaCache) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { windowsHide: true });
    const lineas = r.status === 0 ? r.stdout.toString().split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
    rutaCache = process.platform === 'win32' ? lineas.find((x) => /\.(exe|cmd)$/i.test(x)) ?? null : lineas[0] ?? null;
  }
  return rutaCache;
}

export const claudeDisponible = (config) => Boolean(rutaClaude(config));

function correr(exe, args, prompt, { carpeta, ms }) {
  return new Promise((ok, mal) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // que use tu plan Max, nunca una clave de API con cobro
    delete env.ANTHROPIC_AUTH_TOKEN;
    const esCmd = /\.(cmd|bat)$/i.test(exe);
    const q = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    const p = esCmd
      ? spawn(q(exe), args.map(q), { cwd: carpeta, windowsHide: true, env, shell: true })
      : spawn(exe, args, { cwd: carpeta, windowsHide: true, env });
    let out = '';
    let err = '';
    const reloj = setTimeout(() => {
      // En Windows hay que cerrar también lo que Claude abrió (si no, sigue gastando tu plan).
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
      else p.kill();
      mal(new Error(`Claude tardó más de ${Math.round(ms / 60_000)} min`));
    }, ms);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => { clearTimeout(reloj); mal(e); });
    p.on('close', (c) => {
      clearTimeout(reloj);
      if (c !== 0 && !out.trim()) return mal(Object.assign(new Error(`Claude terminó con código ${c}: ${err.trim() || out.trim()}`), { salida: err }));
      ok(out);
    });
    p.stdin.on('error', () => {});
    p.stdin.end(prompt);
  });
}

// Le pide algo a Claude. `carpeta`: donde están las imágenes que debe ver. Devuelve el JSON que contesta.
export async function preguntarClaude({ prompt, carpeta, config, minutos = 12 }) {
  const exe = rutaClaude(config);
  if (!exe) throw new Error('No encontré Claude Code en esta PC (instálalo e inicia sesión con "claude")');
  const completos = ['-p', '--output-format', 'json', '--allowedTools', 'Read', '--permission-mode', 'dontAsk', '--max-turns', '60', '--add-dir', carpeta];
  const minimos = ['-p', '--output-format', 'json', '--allowedTools', 'Read', '--add-dir', carpeta];
  let salida;
  try {
    salida = await correr(exe, config.claude?.argumentos ?? completos, prompt, { carpeta, ms: minutos * 60_000 });
  } catch (e) {
    // Versiones viejas de Claude Code no conocen algunas opciones: probamos con las básicas.
    if (!/unknown option|unrecognized|invalid value|error: option/i.test(e.message)) throw e;
    salida = await correr(exe, minimos, prompt, { carpeta, ms: minutos * 60_000 });
  }
  let r;
  try { r = JSON.parse(salida.slice(salida.indexOf('{'), salida.lastIndexOf('}') + 1)); } catch { throw new Error('Claude no devolvió una respuesta legible: ' + salida.slice(0, 300)); }
  if (r.is_error || r.subtype && r.subtype !== 'success') {
    const msg = (r.errors ?? []).join(' ') || r.result || r.subtype;
    if (/limit|usage|rate/i.test(String(msg))) marcar('claude', 'aviso', 'Claude llegó a su límite de uso por ahora', String(msg).slice(0, 300));
    throw new Error('Claude no terminó: ' + String(msg).slice(0, 300));
  }
  const texto = String(r.result ?? '');
  const inicio = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (inicio < 0 || fin < inicio) throw new Error('Claude no contestó en JSON: ' + texto.slice(0, 300));
  const json = JSON.parse(texto.slice(inicio, fin + 1));
  marcar('claude', 'ok', 'Revisando tus videos con tu plan Max');
  log(`🤖 Claude respondió (${Math.round((r.duration_ms ?? 0) / 1000)} s)`);
  return json;
}
