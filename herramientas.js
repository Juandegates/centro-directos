// Rutas de Streamlink y FFmpeg, y una "fuente" que trae tu directo de Twitch.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function rutaFfmpeg(config) {
  if (config.herramientas?.ffmpeg) return config.herramientas.ffmpeg;
  const candidatos = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap((base) => [join(base, 'Streamlink', 'ffmpeg', 'ffmpeg.exe'), join(base, 'Programs', 'Streamlink', 'ffmpeg', 'ffmpeg.exe')]);
  return candidatos.find((r) => existsSync(r)) ?? 'ffmpeg';
}

export const rutaStreamlink = (config) => config.herramientas?.streamlink || 'streamlink';

// Lanza streamlink → ffmpeg con los argumentos de salida dados. Devuelve { procesos, ffmpeg }.
export function lanzarDesdeTwitch({ config, canal, calidad = 'best', argsSalida, alError, alTerminar }) {
  const fuente = spawn(rutaStreamlink(config), ['--stdout', '--twitch-disable-ads', '--loglevel', 'error',
    '--stream-segment-attempts', '5', `https://twitch.tv/${canal}`, calidad], { windowsHide: true });
  const ff = spawn(rutaFfmpeg(config), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', ...argsSalida], { windowsHide: true });
  fuente.stdout.pipe(ff.stdin);
  ff.stdin.on('error', () => {});
  fuente.stdout.on('error', () => {});

  let errores = '';
  for (const p of [fuente, ff]) {
    p.on('error', (e) => alError?.(`No pude abrir ${p === fuente ? 'Streamlink' : 'FFmpeg'} (${e.code})`, e.code));
    p.stderr.on('data', (d) => { errores = (errores + d.toString()).slice(-1500); });
  }
  let cerrado = false;
  const cerrar = (codigo) => {
    if (cerrado) return;
    cerrado = true;
    fuente.kill();
    ff.kill();
    alTerminar?.(codigo, errores.trim());
  };
  ff.on('close', cerrar);
  fuente.on('close', () => setTimeout(() => cerrar(null), 3000));

  return { detener: () => { cerrado = true; fuente.kill(); ff.kill(); }, salida: ff.stdout };
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
