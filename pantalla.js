// "Ojos" del bot: mientras estás en vivo, toma una imagen de tu directo cada 2 segundos
// (desde Twitch, la misma señal que ve tu gente) y guarda las últimas en memoria.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

function rutaFfmpeg(config) {
  if (config.herramientas?.ffmpeg) return config.herramientas.ffmpeg;
  const candidatos = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(Boolean)
    .flatMap((base) => [join(base, 'Streamlink', 'ffmpeg', 'ffmpeg.exe'), join(base, 'Programs', 'Streamlink', 'ffmpeg', 'ffmpeg.exe')]);
  return candidatos.find((r) => existsSync(r)) ?? 'ffmpeg';
}

export function crearPantalla({ canal, leerConfig, estaEnVivo, log }) {
  let fotos = []; // { jpg: Buffer, hora: number }
  let procesos = null;
  let faltaHerramienta = false; // para avisar una sola vez

  function detener() {
    if (!procesos) return;
    for (const p of procesos) p.kill();
    procesos = null;
  }

  function arrancar() {
    const config = leerConfig();
    const sl = config.herramientas?.streamlink ?? 'streamlink';
    const ff = rutaFfmpeg(config);
    const cada = config.pantalla?.segundosEntreImagenes ?? 2;

    const fuente = spawn(sl, ['--stdout', '--twitch-disable-ads', '--loglevel', 'error',
      `https://twitch.tv/${canal}`, '480p,360p,worst']);
    const convertidor = spawn(ff, ['-loglevel', 'error', '-i', 'pipe:0',
      '-vf', `fps=1/${cada},scale=640:-2`, '-q:v', '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    procesos = [fuente, convertidor];

    fuente.stdout.pipe(convertidor.stdin);
    convertidor.stdin.on('error', () => {});

    let resto = Buffer.alloc(0);
    convertidor.stdout.on('data', (trozo) => {
      resto = Buffer.concat([resto, trozo]);
      for (;;) {
        const ini = resto.indexOf(SOI);
        const fin = ini < 0 ? -1 : resto.indexOf(EOI, ini + 2);
        if (fin < 0) break;
        fotos.push({ jpg: resto.subarray(ini, fin + 2), hora: Date.now() });
        if (fotos.length > 5) fotos.shift();
        resto = resto.subarray(fin + 2);
      }
    });

    for (const p of procesos) {
      p.on('error', (e) => {
        if (faltaHerramienta) return;
        faltaHerramienta = true;
        log(`👁️ No pude abrir ${p === fuente ? 'Streamlink' : 'FFmpeg'} (${e.code}). ¿Está instalado Streamlink?`);
      });
      p.stderr.on('data', (d) => {
        const t = d.toString().trim();
        if (t && !faltaHerramienta) log('👁️ ' + t.slice(0, 200));
      });
    }
    convertidor.on('close', () => {
      if (procesos?.includes(convertidor)) {
        procesos = null;
        fuente.kill();
        if (!faltaHerramienta) log('👁️ Dejé de ver tu directo.');
      }
    });
    log('👁️ Viendo tu directo para entender lo que pasa en el juego.');
  }

  // Cada 30 s revisa si estás en vivo para encender o apagar la vista.
  async function revisar() {
    const config = leerConfig();
    if (config.pantalla?.activa === false) return detener();
    const vivo = await estaEnVivo().catch(() => false);
    if (vivo && !procesos) arrancar();
    if (!vivo && procesos) {
      detener();
      log('👁️ Terminó el directo; dejo de ver la pantalla.');
    }
  }
  revisar();
  setInterval(revisar, 30_000);

  return {
    // Últimas imágenes recientes (máx. 15 s de antigüedad), de la más vieja a la más nueva.
    recientes(cuantas = 3) {
      const limite = Date.now() - 15_000;
      return fotos.filter((f) => f.hora >= limite).slice(-cuantas)
        .map((f) => ({ mime: 'image/jpeg', base64: f.jpg.toString('base64') }));
    },
  };
}
