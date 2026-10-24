// Video resumen: al terminar el directo une lo más fuerte de cada clip (≈15 s de cada uno, en orden)
// en un solo video vertical de "lo mejor del directo", listo para TikTok y YouTube Shorts.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { correrFfmpeg } from './herramientas.js';
import { preguntarIA } from './ia.js';
import { recortar } from './promos.js';
import { lineaCuentas } from './clips.js';
import { agregar, nuevoId, lista, CARPETA_CLIPS } from './bandeja.js';
import { log } from './estado.js';

// El momento detectado queda ~15 s antes del final de cada clip: tomamos 10 s antes y 5 s después.
const SEGUNDOS_POR_CLIP = 15;
const DESDE_EL_FINAL = 25;

// Filtro de FFmpeg que une los pedazos (mismo tamaño, cuadros por segundo y audio para que no falle).
export function filtroResumen(n) {
  let f = '';
  for (let i = 0; i < n; i++) {
    f += `[${i}:v]scale=1080:1920,fps=30,format=yuv420p,setsar=1[v${i}];`;
    f += `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
  }
  f += Array.from({ length: n }, (_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${n}:v=1:a=1[v][a]`;
  return f;
}

export function crearResumen({ leerConfig, datos, avisar, urlApp, canalLogin }) {
  async function armar({ desde, minutos }) {
    const c = { activo: true, minimoClips: 2, maximoClips: 6, ...(leerConfig().resumen ?? {}) };
    if (!c.activo) return null;
    // Clips de este directo (sin otros resúmenes), en el orden en que pasaron.
    const clips = lista()
      .filter((i) => i.tipo === 'clip' && !i.resumen && new Date(i.creado).getTime() >= desde && existsSync(join(CARPETA_CLIPS, i.archivos.vertical)))
      .sort((a, b) => new Date(a.creado) - new Date(b.creado));
    if (clips.length < c.minimoClips) {
      log(`🎞️ Sin video resumen: solo hubo ${clips.length} clip(s) en este directo`);
      return null;
    }
    // Si hay más de los que caben, nos quedamos con los mejor calificados (sin perder el orden).
    const elegidos = clips.length > c.maximoClips
      ? [...clips].sort((a, b) => (b.puntos ?? 5) - (a.puntos ?? 5)).slice(0, c.maximoClips).sort((a, b) => new Date(a.creado) - new Date(b.creado))
      : clips;
    const id = nuevoId();
    const carpeta = join(CARPETA_CLIPS, id);
    mkdirSync(carpeta, { recursive: true });
    const vertical = join(carpeta, 'vertical.mp4');
    log(`🎞️ Armando el video resumen con ${elegidos.length} momentos…`);
    const config = leerConfig();
    const entradas = elegidos.flatMap((i) => ['-sseof', `-${DESDE_EL_FINAL}`, '-t', String(SEGUNDOS_POR_CLIP), '-i', join(CARPETA_CLIPS, i.archivos.vertical)]);
    await correrFfmpeg(config, [...entradas, '-filter_complex', filtroResumen(elegidos.length), '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', vertical]);
    const portadaOrigen = join(CARPETA_CLIPS, (elegidos.find((i) => i.puntos >= 9) ?? elegidos[0]).archivos.portada);
    if (existsSync(portadaOrigen)) copyFileSync(portadaOrigen, join(carpeta, 'portada.jpg'));

    const d = datos.actual();
    const fecha = new Date(desde).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    const momentos = elegidos.map((i) => i.titulo).join('; ');
    let textos = { titulo: `Lo mejor del directo: ${d.juego}`, tituloShorts: `Lo mejor del directo de ${d.juego}`, tiktok: `Lo mejor del directo de hoy en ${d.juego} 🎮 #PS5 #gaming` };
    try {
      const r = await preguntarIA({
        sistema: `Eres el community manager de ${d.nombre}, streamer mexicano de PS5. Escribes en espanol mexicano, con gancho, sin mentir.`,
        texto: `Directo de ${minutos} min jugando ${d.juego}. Momentos del video resumen, en orden: ${momentos}.\n` +
          'No inventes nada que no este en esos momentos. Devuelve SOLO un JSON: {"tituloShorts": "max 85 caracteres, sin hashtags", "tiktok": "descripcion con 4 a 6 hashtags, max 180 caracteres"}',
      });
      const j = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
      textos = { ...textos, tituloShorts: j.tituloShorts || textos.tituloShorts, tiktok: j.tiktok || textos.tiktok };
    } catch { /* usamos los textos de respaldo */ }
    const base = recortar(String(textos.tituloShorts).replace(/#\S+/g, '').trim(), 100 - ' #Shorts'.length);
    const cuentas = lineaCuentas(config, canalLogin);
    const item = agregar({
      id, tipo: 'clip', resumen: true, motivo: `resumen del directo (${elegidos.length} momentos)`, puntos: 10,
      juego: d.juego, titulo: textos.titulo,
      tituloShorts: `${base} #Shorts`,
      textoTikTok: cuentas ? `${textos.tiktok}\n${cuentas}` : textos.tiktok,
      textoX: recortar(`Lo mejor del directo de ${fecha} en ${d.juego} 🎮`, 250),
      archivos: { vertical: `${id}/vertical.mp4`, portada: `${id}/portada.jpg` },
    });
    log(`🎞️ Video resumen listo (${elegidos.length * SEGUNDOS_POR_CLIP} s)`);
    avisar('🎞️ Video resumen del directo listo', `${elegidos.length} momentos en un solo video para TikTok y Shorts.`, {
      etiquetas: ['film_frames'], abrir: `${urlApp()}#clips/${id}`, clave: 'resumen-' + id,
    });
    return item;
  }
  return { armar };
}
