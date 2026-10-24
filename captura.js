// Mientras estás en vivo: graba tu directo en pedacitos de 10 s (para los clips) y saca
// una imagen cada 2 s (para que el bot "vea"). Todo con una sola descarga de Twitch.
// Las imágenes viven solo en memoria; los pedacitos se borran solos a los 20 minutos.
import { mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanzarDesdeTwitch } from './herramientas.js';
import { marcar } from './estado.js';

export const CARPETA = fileURLToPath(new URL('./grabacion/', import.meta.url));
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const MINUTOS_GUARDADOS = 20;

export function crearCaptura({ canal, leerConfig }) {
  mkdirSync(CARPETA, { recursive: true });
  let fotos = [];
  let proceso = null;
  let activa = false;
  let reintento = null;
  let fallas = 0;

  function limpiarViejos(todo = false) {
    const limite = Date.now() - MINUTOS_GUARDADOS * 60_000;
    for (const f of readdirSync(CARPETA)) {
      const ruta = join(CARPETA, f);
      try {
        if (todo || statSync(ruta).mtimeMs < limite) rmSync(ruta, { force: true });
      } catch { /* archivo en uso: se borra después */ }
    }
  }
  setInterval(() => limpiarViejos(false), 60_000);

  function arrancar() {
    const config = leerConfig();
    const cada = config.pantalla?.segundosEntreImagenes ?? 2;
    proceso = lanzarDesdeTwitch({
      config,
      canal,
      calidad: 'best',
      argsSalida: [
        // 1) Grabación en pedacitos de 10 s, sin recomprimir (calidad original, casi sin CPU)
        '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-f', 'segment', '-segment_time', '10',
        '-reset_timestamps', '1', '-strftime', '1', join(CARPETA, '%Y%m%d-%H%M%S.ts'),
        // 2) Imágenes pequeñas para la IA
        '-map', '0:v:0', '-vf', `fps=1/${cada},scale=512:-2`, '-q:v', '7', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1',
      ],
      alError: (msg) => marcar('captura', 'error', msg + '. ¿Está instalado Streamlink?'),
      alTerminar: (codigo, errores) => {
        proceso = null;
        if (!activa) return;
        fallas++;
        const espera = Math.min(60, 5 * fallas);
        // Las primeras 2 veces reintentamos callados: casi siempre es que el directo está terminando
        // (Twitch tarda unos segundos en avisar que acabó) o un corte de un instante.
        if (fallas > 2) marcar('captura', 'aviso', `Se cortó la vista de tu directo; reintento en ${espera} s`, errores || `código ${codigo}`);
        reintento = setTimeout(() => activa && arrancar(), espera * 1000);
      },
    });

    let resto = Buffer.alloc(0);
    proceso.salida.on('data', (trozo) => {
      if (!activa) return;
      resto = Buffer.concat([resto, trozo]);
      for (;;) {
        const ini = resto.indexOf(SOI);
        const fin = ini < 0 ? -1 : resto.indexOf(EOI, ini + 2);
        if (fin < 0) break;
        fotos.push({ jpg: Buffer.from(resto.subarray(ini, fin + 2)), hora: Date.now() });
        if (fotos.length > 5) fotos.shift();
        resto = resto.subarray(fin + 2);
        fallas = 0;
        marcar('captura', 'ok', 'Viendo y grabando tu directo');
      }
    });
  }

  return {
    iniciar() {
      if (activa || leerConfig().pantalla?.activa === false) return;
      activa = true;
      fallas = 0;
      arrancar();
    },
    detener() {
      activa = false;
      clearTimeout(reintento);
      proceso?.detener();
      proceso = null;
      fotos = [];
      marcar('captura', 'apagado', 'Sin directo');
      // Dejamos 5 min por si un clip todavía se está armando; luego se borra todo.
      setTimeout(() => !activa && limpiarViejos(true), 5 * 60_000);
    },
    activa: () => activa,
    // Últimas imágenes (máx. 15 s de antigüedad), de la más vieja a la más nueva.
    recientes(cuantas = 3) {
      const limite = Date.now() - 15_000;
      return fotos.filter((f) => f.hora >= limite).slice(-cuantas)
        .map((f) => ({ mime: 'image/jpeg', base64: f.jpg.toString('base64') }));
    },
    // Pedacitos grabados que cubren los últimos `segundos`, en orden.
    pedazos(segundos) {
      const desde = Date.now() - (segundos + 12) * 1000;
      return readdirSync(CARPETA)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => ({ ruta: join(CARPETA, f), t: statSync(join(CARPETA, f)).mtimeMs, nombre: f }))
        .filter((p) => p.t >= desde)
        .sort((a, b) => a.nombre.localeCompare(b.nombre))
        .map((p) => p.ruta);
    },
  };
}
