// Rutas de Streamlink y FFmpeg, y una "fuente" que trae tu directo de Twitch.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { golpe } from './red.js';

export function rutaFfmpeg(config) {
  if (config.herramientas?.ffmpeg) return config.herramientas.ffmpeg;
  const candidatos = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap((base) => [join(base, 'Streamlink', 'ffmpeg', 'ffmpeg.exe'), join(base, 'Programs', 'Streamlink', 'ffmpeg', 'ffmpeg.exe')]);
  return candidatos.find((r) => existsSync(r)) ?? 'ffmpeg';
}

export const rutaStreamlink = (config) => config.herramientas?.streamlink || 'streamlink';

// ---------- Una sola descarga de tu directo de Twitch, repartida a todos ----------
// Antes cada parte (grabación, YouTube, Kick) bajaba su propia copia del directo: 3 descargas a la vez
// saturaban el Wi-Fi. Ahora Streamlink baja UNA copia y el Centro se la reparte a cada FFmpeg.
const fuentes = new Map(); // "canal|calidad" → fuente compartida

// Paquetes de video MPEG-TS (188 bytes). Alguien nuevo se engancha justo en el inicio de un tramo:
// la tabla "PAT" seguida de una imagen completa (cuadro clave), para que no salga imagen rota al empezar.
const esPaquete = (b, i) => b[i] === 0x47 && (i + 188 >= b.length || b[i + 188] === 0x47);
const esPAT = (b, i) => esPaquete(b, i) && (b[i + 1] & 0x40) && (((b[i + 1] & 0x1f) << 8) | b[i + 2]) === 0;
const esCuadroClave = (b, i) => esPaquete(b, i) && (b[i + 1] & 0x40) && (b[i + 3] & 0x20) && b[i + 4] > 0 && (b[i + 5] & 0x40);

function inicioDeTramo(b, cualquierPAT = false) {
  let pat = -1;
  for (let i = 0; i + 6 < b.length; i++) {
    if (b[i] !== 0x47) continue;
    if (esPAT(b, i)) { if (cualquierPAT) return i; pat = i; i += 187; continue; }
    if (pat >= 0 && esCuadroClave(b, i)) return pat;
    if (esPaquete(b, i)) i += 187;
  }
  return -1;
}

function soltar(f, cliente) {
  f.clientes.delete(cliente);
  if (f.clientes.size || f.cerrada) return;
  // Nadie la usa: se apaga en 20 s (si alguien se reconecta antes, la reaprovecha sin volver a descargar).
  clearTimeout(f.apagar);
  f.apagar = setTimeout(() => { if (!f.clientes.size) { f.porNosotros = true; f.proc.kill(); } }, 20_000);
}

function fuenteCompartida(config, canal, calidad) {
  const clave = `${canal}|${calidad}`;
  const viva = fuentes.get(clave);
  if (viva && !viva.cerrada) { clearTimeout(viva.apagar); return viva; }
  const f = { clientes: new Set(), errores: '', cerrada: false, porNosotros: false, apagar: null };
  f.proc = spawn(rutaStreamlink(config), ['--stdout', '--twitch-disable-ads', '--loglevel', 'error',
    '--stream-segment-attempts', '5', '--stream-segment-timeout', '20', `https://twitch.tv/${canal}`, calidad], { windowsHide: true });
  f.proc.stdout.on('error', () => {});
  f.proc.stderr.on('data', (d) => { f.errores = (f.errores + d.toString()).slice(-1500); });
  f.proc.on('error', (e) => { for (const c of f.clientes) c.alError?.(`No pude abrir Streamlink (${e.code})`, e.code); });
  f.proc.stdout.on('data', (trozo) => {
    for (const c of f.clientes) {
      if (c.stdin.destroyed || !c.stdin.writable) continue;
      let parte = trozo;
      if (!c.enganchado) {
        // Si en 8 s no hubo un cuadro clave marcado, se engancha en cualquier inicio de tabla.
        const i = inicioDeTramo(trozo, Date.now() - c.desde > 8000);
        if (i < 0) continue;
        c.enganchado = true;
        parte = trozo.subarray(i);
      }
      // Si alguien se atora (p. ej. su subida a YouTube no avanza), no acumulamos memoria: se reinicia solo él.
      if (c.stdin.writableLength > 32 * 1024 * 1024) { c.atorado(); continue; }
      c.stdin.write(parte);
    }
  });
  f.proc.on('close', (codigo) => {
    f.cerrada = true;
    clearTimeout(f.apagar);
    if (fuentes.get(clave) === f) fuentes.delete(clave);
    if (!f.porNosotros && f.clientes.size) golpe('twitch');
    for (const c of [...f.clientes]) c.alCorte(codigo, f.errores.trim());
    f.clientes.clear();
  });
  fuentes.set(clave, f);
  return f;
}

// Lanza un FFmpeg alimentado con tu directo de Twitch (de la descarga compartida). Devuelve { detener, salida }.
export function lanzarDesdeTwitch({ config, canal, calidad = 'best', argsSalida, alError, alTerminar }) {
  const ff = spawn(rutaFfmpeg(config), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...argsSalida], { windowsHide: true });
  ff.stdin.on('error', () => {});
  let errores = '';
  let erroresFuente = '';
  ff.stderr.on('data', (d) => { errores = (errores + d.toString()).slice(-1500); });
  ff.on('error', (e) => alError?.(`No pude abrir FFmpeg (${e.code})`, e.code));

  const f = fuenteCompartida(config, canal, calidad);
  const cliente = {
    stdin: ff.stdin,
    enganchado: false,
    desde: Date.now(),
    alError,
    // Se acabó la descarga: le cerramos la entrada para que FFmpeg termine limpio (y si no, se fuerza).
    alCorte: (_codigo, err) => { erroresFuente = err; try { ff.stdin.end(); } catch { /* ya cerrada */ } forzar(); },
    atorado: () => { erroresFuente = 'El envío se atoró (la subida no avanzaba)'; matar(); },
  };
  let terminado = false;
  const matar = () => { try { ff.kill(); } catch { /* ya no existe */ } forzar(); };
  const forzar = () => setTimeout(() => { if (!terminado) try { ff.kill('SIGKILL'); } catch { /* ya no existe */ } }, 4000);
  f.clientes.add(cliente);

  let cerrado = false;
  ff.on('close', (codigo) => {
    terminado = true;
    soltar(f, cliente);
    if (cerrado) return;
    cerrado = true;
    alTerminar?.(codigo, [erroresFuente, errores.trim()].filter(Boolean).join(' · '));
  });

  return {
    detener: () => { cerrado = true; soltar(f, cliente); matar(); },
    salida: ff.stdout,
  };
}

// Ejecuta ffmpeg y espera a que termine.
export function correrFfmpeg(config, args, { cwd } = {}) {
  return new Promise((ok, mal) => {
    const p = spawn(rutaFfmpeg(config), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, cwd });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    p.on('error', mal);
    p.on('close', (c) => (c === 0 ? ok() : mal(new Error(`FFmpeg terminó con código ${c}: ${err.trim()}`))));
  });
}

// Mide el volumen de un pedacito de video: { media, pico } en dB (0 = lo más fuerte).
export function medirVolumen(config, ruta) {
  return new Promise((ok, mal) => {
    const p = spawn(rutaFfmpeg(config), ['-hide_banner', '-nostats', '-i', ruta, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', mal);
    p.on('close', () => {
      const media = Number((err.match(/mean_volume:\s*(-?[\d.]+)/) ?? [])[1]);
      const pico = Number((err.match(/max_volume:\s*(-?[\d.]+)/) ?? [])[1]);
      if (Number.isNaN(media)) return mal(new Error('Sin audio en el pedacito'));
      ok({ media, pico: Number.isNaN(pico) ? media : pico });
    });
  });
}

// Letra para escribir encima de los clips (la primera que exista en la PC).
const WIN = (process.env.WINDIR || 'C:\\Windows').replace(/\\/g, '/');
const LETRAS = [`${WIN}/Fonts/arialbd.ttf`, `${WIN}/Fonts/segoeuib.ttf`, `${WIN}/Fonts/arial.ttf`,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf'];
export const letraParaTextos = () => LETRAS.find((f) => existsSync(f)) ?? null;

// Saca una imagen (JPG chiquito) de un pedacito grabado, en el segundo indicado.
export function cuadroDe(config, ruta, segundo, ancho = 384) {
  return new Promise((ok, mal) => {
    const p = spawn(rutaFfmpeg(config), ['-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, segundo)), '-i', ruta,
      '-frames:v', '1', '-vf', `scale=${ancho}:-2`, '-q:v', '7', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], { windowsHide: true });
    const partes = [];
    p.stdout.on('data', (d) => partes.push(d));
    p.on('error', mal);
    p.on('close', (c) => (c === 0 && partes.length ? ok(Buffer.concat(partes)) : mal(new Error('No pude sacar la imagen'))));
  });
}
