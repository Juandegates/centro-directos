// Video resumen de 1:30: durante el directo se guarda un pedacito de cada momento que revisa la IA.
// Al terminar se escogen los mejor calificados (en el orden en que pasaron) y se unen hasta completar
// 90 segundos, haya habido muchos clips o ninguno. Sale en vertical (TikTok/Shorts) y en horizontal.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { correrFfmpeg, letraParaTextos } from './herramientas.js';
import { preguntarIA } from './ia.js';
import { recortar } from './promos.js';
import { lineaCuentas, lineasCuentas, filtroVertical, partirGancho } from './clips.js';
import { agregar, nuevoId, CARPETA_CLIPS } from './bandeja.js';
import { log } from './estado.js';

// Cuántos momentos y cuánto de cada uno para llegar a la duración pedida.
export function planResumen(piezas, { segundos = 90, maximo = 6, minimoPorMomento = 10, maximoPorMomento = 30 } = {}) {
  const ordenadas = [...piezas].sort((a, b) => b.puntos - a.puntos || b.hora - a.hora);
  const n = Math.min(maximo, ordenadas.length, Math.max(1, Math.floor(segundos / minimoPorMomento)));
  // Con pocos momentos, cada uno dura más (hasta 30 s): así siempre se acerca a 1:30.
  const n2 = Math.max(n, Math.min(ordenadas.length, Math.ceil(segundos / maximoPorMomento)));
  const elegidas = ordenadas.slice(0, n2).sort((a, b) => a.hora - b.hora);
  const cada = Math.min(maximoPorMomento, Math.max(minimoPorMomento, segundos / Math.max(1, elegidas.length)));
  return { elegidas, cada: Math.round(cada * 10) / 10 };
}

// Une los pedazos (cada pieza ~32 s; el momento está a ~22 s): se toma un poco antes y un poco después.
export function argsUnir(elegidas, cada) {
  const entradas = elegidas.flatMap((p) => ['-ss', String(Math.max(0, 22 - cada * 0.65).toFixed(1)), '-t', String(cada), '-i', p.ruta]);
  let f = '';
  elegidas.forEach((_, i) => {
    f += `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1[v${i}];`;
    f += `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`;
  });
  f += elegidas.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${elegidas.length}:v=1:a=1[v][a]`;
  return [...entradas, '-filter_complex', f, '-map', '[v]', '-map', '[a]'];
}

export function crearResumen({ leerConfig, datos, avisar, urlApp, canalLogin, momentos }) {
  async function armar({ minutos }) {
    const c = { activo: true, segundos: 90, ...(leerConfig().resumen ?? {}) };
    if (!c.activo) return null;
    const piezas = momentos.piezas();
    if (piezas.length < 2) {
      log(`🎞️ Sin video resumen: el Centro solo guardó ${piezas.length} momento(s) en este directo`);
      return null;
    }
    const { elegidas, cada } = planResumen(piezas, { segundos: c.segundos });
    const id = nuevoId();
    const carpeta = join(CARPETA_CLIPS, id);
    mkdirSync(carpeta, { recursive: true });
    const horizontal = join(carpeta, 'horizontal.mp4');
    const vertical = join(carpeta, 'vertical.mp4');
    const portada = join(carpeta, 'portada.jpg');
    const config = leerConfig();
    log(`🎞️ Armando el video resumen: ${elegidas.length} momentos de ${cada} s`);

    // Textos primero: el gancho va escrito encima del video vertical.
    const d = datos.actual();
    const lista = elegidas.map((p) => p.que).filter(Boolean).join('; ');
    let textos = { gancho: 'Lo mejor del directo de hoy', titulo: `Lo mejor del directo: ${d.juego}`, tituloShorts: `Lo mejor del directo de ${d.juego}`, tiktok: `Lo mejor del directo de hoy en ${d.juego} 🎮 #PS5 #gaming` };
    try {
      const r = await preguntarIA({
        sistema: `Eres el community manager de ${d.nombre}, streamer mexicano de PS5. Escribes en espanol mexicano, con gancho, sin mentir.`,
        texto: `Directo de ${minutos} min jugando ${d.juego}. Momentos del video resumen, en orden: ${lista || '(sin descripcion)'}.\n` +
          'No inventes nada que no este en esos momentos. Devuelve SOLO un JSON: {"gancho": "frase para escribir encima del video, max 32 caracteres, sin hashtags ni emojis", ' +
          '"tituloShorts": "max 85 caracteres, sin hashtags", "tiktok": "descripcion con 4 a 6 hashtags, max 180 caracteres"}',
      });
      const j = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
      textos = { ...textos, gancho: j.gancho || textos.gancho, tituloShorts: j.tituloShorts || textos.tituloShorts, tiktok: j.tiktok || textos.tiktok };
    } catch { /* usamos los textos de respaldo */ }

    await correrFfmpeg(config, [...argsUnir(elegidas, cada), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', horizontal]);
    const zoom = Math.min(1, Math.max(0.4, Number(config.clips?.zoomVertical ?? 0.7)));
    const letra = letraParaTextos();
    const lineas = letra ? partirGancho(String(textos.gancho).replace(/[#\p{Extended_Pictographic}]/gu, '').trim()) : [];
    const marcas = letra ? lineasCuentas(config, canalLogin) : [];
    lineas.forEach((l, i) => writeFileSync(join(carpeta, `linea${i + 1}.txt`), l));
    marcas.forEach((m, i) => writeFileSync(join(carpeta, `marca${i + 1}.txt`), m));
    const armarVertical = (conTexto) => correrFfmpeg(config, ['-i', horizontal, '-filter_complex',
      filtroVertical({ zoom, lineas: conTexto ? lineas : [], marcas: conTexto ? marcas : [], letra: conTexto ? letra : null }),
      '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'copy', '-movflags', '+faststart', vertical], { cwd: carpeta });
    await armarVertical(Boolean(letra)).catch(() => armarVertical(false));
    const mejor = elegidas.reduce((a, b) => (b.puntos > a.puntos ? b : a));
    const segundoMejor = elegidas.indexOf(mejor) * cada + cada * 0.65;
    await correrFfmpeg(config, ['-ss', String(segundoMejor.toFixed(1)), '-i', horizontal, '-frames:v', '1', '-vf', 'scale=480:-2', portada]).catch(() => {});

    const fecha = new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    const base = recortar(String(textos.tituloShorts).replace(/#\S+/g, '').trim(), 100 - ' #Shorts'.length);
    const cuentas = lineaCuentas(config, canalLogin);
    const duracion = Math.round(elegidas.length * cada);
    const item = agregar({
      id, tipo: 'clip', resumen: true, motivo: `resumen del directo · ${elegidas.length} momentos · ${Math.floor(duracion / 60)}:${String(duracion % 60).padStart(2, '0')}`, puntos: 10,
      juego: d.juego, titulo: textos.titulo, gancho: textos.gancho,
      tituloShorts: `${base} #Shorts`,
      textoTikTok: cuentas ? `${textos.tiktok}\n${cuentas}` : textos.tiktok,
      textoX: recortar(`Lo mejor del directo de ${fecha} en ${d.juego} 🎮`, 250),
      archivos: { horizontal: `${id}/horizontal.mp4`, vertical: `${id}/vertical.mp4`, portada: `${id}/portada.jpg` },
    });
    momentos.borrarPiezas();
    log(`🎞️ Video resumen listo (${duracion} s)`);
    avisar('🎞️ Video resumen del directo listo', `${elegidas.length} momentos en ${Math.floor(duracion / 60)}:${String(duracion % 60).padStart(2, '0')} min, en vertical y horizontal.`, {
      etiquetas: ['film_frames'], abrir: `${urlApp()}#clips/${id}`, clave: 'resumen-' + id,
    });
    return item;
  }
  return { armar };
}
