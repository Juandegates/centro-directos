// Clips automáticos: detecta los mejores momentos y corta un clip horizontal y uno vertical (TikTok/Shorts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { correrFfmpeg, letraParaTextos } from './herramientas.js';
import { recortar } from './promos.js';
import { preguntarIA } from './ia.js';
import { marcar, log } from './estado.js';
import { agregar, nuevoId, CARPETA_CLIPS } from './bandeja.js';

const REACCIONES = /(ja){2,}|j[aeo]j[aeo]|xd|lol|lmao|no+o+|wo+w|gg|clip|que paso|qu[eé] fue eso|nooo|alv|uff|omg|bruh|😂|🤣|😱|🔥/i;

// Parte el gancho en máximo 2 líneas cortas para que quepa grande en el celular.
export function partirGancho(texto, max = 20) {
  const lineas = [''];
  for (const p of String(texto ?? '').replace(/\s+/g, ' ').trim().split(' ')) {
    if (!p) continue;
    const ultima = lineas.at(-1);
    if (!ultima) lineas[lineas.length - 1] = p;
    else if ((ultima + ' ' + p).length <= max) lineas[lineas.length - 1] = ultima + ' ' + p;
    else if (lineas.length < 2) lineas.push(p);
    else { lineas[1] = (lineas[1] + '…').slice(0, max); break; }
  }
  return lineas.filter(Boolean).map((l) => l.slice(0, max + 2));
}

// Filtro de FFmpeg del video vertical: fondo difuminado, juego al centro con zoom y, si hay letra, el gancho arriba y tu canal abajo.
// yaVertical: el video ya viene vertical (por ejemplo, uno que subiste): solo se ajusta y se le escribe encima.
export function filtroVertical({ zoom, lineas = [], marcas = [], letra = null, yaVertical = false }) {
  const altoJuego = yaVertical ? 1440 : Math.round(1080 / ((16 / 9) * zoom) / 2) * 2;
  const arriba = Math.round((1920 - altoJuego) / 2);
  let f = yaVertical
    ? '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black'
    : '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[fondo];' +
      `[0:v]crop=trunc(iw*${zoom}/2)*2:ih,scale=1080:-2[frente];[fondo][frente]overlay=(W-w)/2:(H-h)/2`;
  if (letra) {
    const fuente = `fontfile='${letra.replace(/\\/g, '/').replace(/:/g, '\\:')}'`;
    const caja = 'box=1:boxcolor=black@0.55:boxborderw=22';
    lineas.forEach((_, i) => {
      const y = yaVertical ? 140 + i * 110 : arriba - 70 - (lineas.length - i) * 110; // ya vertical: arriba, sobre el video
      f += `,drawtext=${fuente}:expansion=none:textfile=linea${i + 1}.txt:fontsize=78:fontcolor=white:${caja}:x=(w-text_w)/2:y=${y}`;
    });
    // Tus cuentas abajo del juego, un poco más chicas que el gancho.
    marcas.forEach((_, i) => {
      f += `,drawtext=${fuente}:expansion=none:textfile=marca${i + 1}.txt:fontsize=44:fontcolor=white:${caja}:x=(w-text_w)/2:y=${yaVertical ? 1920 - 300 + i * 92 : arriba + altoJuego + 80 + i * 92}`;
    });
  }
  return f + ',format=yuv420p[v]';
}

// Tus cuentas: Twitch sale del canal; YouTube de config.json → redes.youtube.
export function lineasCuentas(config, canalLogin) {
  const yt = String(config.redes?.youtube ?? '').trim();
  return [canalLogin && `Twitch: ${canalLogin}`, yt && `YouTube: ${yt.startsWith('@') ? yt : '@' + yt}`].filter(Boolean);
}
export function lineaCuentas(config, canalLogin) {
  const yt = String(config.redes?.youtube ?? '').trim();
  const partes = [canalLogin && `Twitch (${canalLogin})`, yt && `YouTube (${yt.startsWith('@') ? yt : '@' + yt})`].filter(Boolean);
  return partes.length ? `🎮 En vivo en ${partes.join(' y ')}` : '';
}

export function crearClips({ captura, leerConfig, datos, crearClipTwitch, avisar, urlApp, canalLogin = '', alClipListo = () => {} }) {
  const mensajes = []; // { hora, reaccion, linea }
  let ultimoClip = 0;
  let trabajando = false;

  // Llamar con cada mensaje de la gente (de cualquier plataforma).
  function registrarMensaje({ nombre, texto, plataforma }) {
    mensajes.push({ hora: Date.now(), reaccion: REACCIONES.test(texto), linea: `${nombre} (${plataforma}): ${texto}` });
    while (mensajes.length && mensajes[0].hora < Date.now() - 10 * 60_000) mensajes.shift();
    if (/^!clip\b/i.test(texto.trim())) crear('alguien del chat pidió clip').catch(() => {});
  }

  // Revisa cada 5 s si el chat "explotó" comparado con lo normal.
  setInterval(() => {
    const c = leerConfig().clips ?? {};
    if (c.automaticos === false || !captura.activa()) return;
    const ahora = Date.now();
    const ventana = mensajes.filter((m) => m.hora > ahora - 20_000);
    const previos = mensajes.filter((m) => m.hora <= ahora - 20_000 && m.hora > ahora - 5 * 60_000);
    const normal = previos.length / 14; // promedio por cada 20 s en los 5 min anteriores
    const reacciones = ventana.filter((m) => m.reaccion).length;
    const pico = ventana.length >= Math.max(c.minimoMensajes ?? 5, normal * 3);
    if (pico || reacciones >= (c.minimoReacciones ?? 4)) {
      crear(pico ? 'el chat explotó' : 'muchas reacciones en el chat').catch(() => {});
    }
  }, 5_000);

  // rango: { desde, hasta } en ms para armar el clip de un momento ya pasado (por ejemplo, el final de un jefe).
  async function crear(motivo, { puntos = null, que = '', saltarEspera = false, segundos = null, rango = null, fotosMomento = null } = {}) {
    const c = leerConfig().clips ?? {};
    if (trabajando || !captura.activa()) return null;
    if (Date.now() - ultimoClip < (c.minutosEntreClips ?? 3) * 60_000 && motivo !== 'manual' && !saltarEspera) return null;
    trabajando = true;
    ultimoClip = Date.now();
    const id = nuevoId();
    const carpeta = join(CARPETA_CLIPS, id);
    const fotos = fotosMomento?.length ? fotosMomento : captura.recientes(5);
    const chat = mensajes.filter((m) => m.hora > Date.now() - 60_000).map((m) => m.linea).slice(-15);
    log(`🎬 Momento detectado (${motivo}); armando clip…`, { parte: 'clips' });

    try {
      // El clip de Twitch es de "ahora": no sirve para un momento que ya pasó.
      const twitch = rango ? null : await crearClipTwitch().catch((e) => {
        log('No pude crear el clip en Twitch: ' + e.message, { parte: 'clips', nivel: 'aviso' });
        return null;
      });

      // Esperamos para incluir lo que pasó justo después del momento.
      if (!rango) await new Promise((r) => setTimeout(r, 15_000));
      const pedazos = rango ? captura.pedazosEntre(rango.desde, rango.hasta) : captura.pedazos(segundos ?? c.segundos ?? 40);
      if (pedazos.length < 2) throw new Error('Todavía no hay suficiente grabación para el clip');

      mkdirSync(carpeta, { recursive: true });
      const listaArchivos = join(carpeta, 'lista.txt');
      writeFileSync(listaArchivos, pedazos.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      const config = leerConfig();
      const horizontal = join(carpeta, 'horizontal.mp4');
      const vertical = join(carpeta, 'vertical.mp4');
      const portada = join(carpeta, 'portada.jpg');

      await correrFfmpeg(config, ['-f', 'concat', '-safe', '0', '-i', listaArchivos, '-c', 'copy', '-movflags', '+faststart', horizontal]);
      // Primero los textos: el gancho va escrito encima del video vertical.
      const textos = await escribirTextos({ fotos, chat, motivo, que, d: datos.actual() });
      // Vertical: el juego al centro con zoom (recorta un poco los lados para que se vea más grande en el celular).
      const zoom = Math.min(1, Math.max(0.4, Number(c.zoomVertical ?? 0.7)));
      const letra = c.gancho === false ? null : letraParaTextos();
      const lineas = letra ? partirGancho(textos.gancho) : [];
      const marcas = letra && c.marcaCanal !== false ? lineasCuentas(leerConfig(), canalLogin) : [];
      lineas.forEach((l, i) => writeFileSync(join(carpeta, `linea${i + 1}.txt`), l));
      marcas.forEach((m, i) => writeFileSync(join(carpeta, `marca${i + 1}.txt`), m));
      const armarVertical = (conTexto) => correrFfmpeg(config, ['-i', horizontal, '-filter_complex',
        filtroVertical({ zoom, lineas: conTexto ? lineas : [], marcas: conTexto ? marcas : [], letra: conTexto ? letra : null }),
        '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', vertical], { cwd: carpeta });
      // Si escribir el texto falla (letra rara, versión vieja de FFmpeg), igual sale el clip sin texto.
      await armarVertical(Boolean(letra)).catch((e) => {
        if (!letra) throw e;
        log('No pude poner el texto encima del clip; lo armo sin texto: ' + e.message, { parte: 'clips', nivel: 'aviso' });
        return armarVertical(false);
      });
      // Portada: la imagen del momento exacto que se detectó (la acción), no el segundo 3 del clip.
      if (fotos.length) writeFileSync(portada, Buffer.from(fotos.at(-1).base64, 'base64'));
      else await correrFfmpeg(config, ['-ss', '3', '-i', horizontal, '-frames:v', '1', '-vf', 'scale=480:-2', portada]);

      const item = agregar({
        id, tipo: 'clip', motivo, puntos, gancho: textos.gancho,
        juego: datos.actual().juego,
        titulo: textos.titulo,
        textoTikTok: textos.tiktok,
        tituloShorts: textos.tituloShorts,
        textoX: textos.x,
        twitch,
        archivos: { horizontal: `${id}/horizontal.mp4`, vertical: `${id}/vertical.mp4`, portada: `${id}/portada.jpg` },
      });
      marcar('clips', 'ok', `Último clip: ${textos.titulo}`);
      alClipListo(item);
      avisar('🎬 Clip listo', `${textos.titulo}\nÁbrelo para publicarlo en TikTok, Shorts o X.`, {
        etiquetas: ['clapper'], abrir: `${urlApp()}#clips/${id}`, clave: 'clip' + id,
      });
      return item;
    } catch (e) {
      marcar('clips', 'error', 'No pude armar un clip', e.message);
      return null;
    } finally {
      trabajando = false;
    }
  }

  async function escribirTextos({ fotos, chat, motivo, que, d, uso = 'fondo' }) {
    const respaldo = {
      gancho: que || `Mira esto en ${d.juego}`,
      titulo: que || `Momentazo en ${d.juego}`,
      tiktok: `Momentazo en ${d.juego} 🎮🔥 #${d.juego.replace(/[^a-z0-9]/gi, '')} #PS5 #gaming`,
      x: `Momentazo en ${d.juego} 🎮🔥`,
    };
    try {
      const r = await preguntarIA({
        uso,
        sistema: `Eres el community manager de ${d.nombre}, streamer mexicano de PS5. Escribes en espanol mexicano, con gancho, sin mentir.`,
        imagenes: fotos,
        texto:
          `Juego: ${d.juego}. Motivo del clip: ${motivo}.${que ? ` LO QUE PASO (dato confirmado; no lo contradigas y no agregues nada que no diga aqui, por ejemplo no digas "al primer intento" ni "lo derrote" si no lo dice): ${que}.` : ''}\nChat en ese momento:\n${chat.join('\n') || '(sin mensajes)'}\n\n` +
          `Notas de la partida: ${d.notasJuego || '(ninguna)'}\n\n` +
          'Las imagenes son del momento del clip (la ultima es la mas reciente). Mira bien que esta pasando: jefe, enemigos, zona, accion, si gano o perdio. ' +
          'El titulo y los textos deben describir ESO en concreto (ej. "Me enfrento al jefe de la catedral", "Casi muero con estos picos"). ' +
          'Prohibido usar frases genericas como "paso perfecto", "momentazo", "epico" o "no te lo pierdas" si no dicen que paso. No inventes lo que no se ve.\n' +
          'Devuelve SOLO un JSON valido con estas llaves:\n' +
          '"gancho": frase que va ESCRITA ENCIMA del video en los primeros segundos para que la gente no deslice: max 32 caracteres, pregunta o reaccion en primera persona ("¿Cómo esquivo esto?", "Este jefe casi me mata"), sin hashtags ni emojis,\n' +
          '"titulo": titulo corto con gancho (max 60 caracteres),\n' +
          '"tituloShorts": titulo para YouTube Shorts, max 85 caracteres, con gancho y el nombre del juego, sin hashtags,\n' +
          '"tiktok": descripcion para TikTok/Shorts con 4 a 6 hashtags relevantes (max 180 caracteres),\n' +
          '"x": texto para X (max 200 caracteres, sin hashtags de mas).',
      });
      const json = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
      const gancho = String(json.gancho || respaldo.gancho).replace(/[#\p{Extended_Pictographic}]/gu, '').trim().slice(0, 40);
      const titulo = json.titulo || respaldo.titulo;
      return conCuentas({ gancho, titulo, tituloShorts: json.tituloShorts || titulo, tiktok: json.tiktok || respaldo.tiktok, x: json.x || respaldo.x });
    } catch {
      return conCuentas({ ...respaldo, tituloShorts: respaldo.titulo });
    }
  }

  // Título de Shorts (máx. 100 con #Shorts) y tus cuentas al final de la descripción, siempre.
  function conCuentas(t) {
    const base = recortar(String(t.tituloShorts).replace(/#\S+/g, '').replace(/\s+/g, ' ').trim(), 100 - ' #Shorts'.length);
    const cuentas = lineaCuentas(leerConfig(), canalLogin);
    return { ...t, tituloShorts: `${base} #Shorts`, tiktok: cuentas ? `${t.tiktok}\n${cuentas}` : t.tiktok };
  }

  // Textos para un video que subiste tú (las imágenes van repartidas a lo largo del video).
  const escribir = ({ fotos, que }) => escribirTextos({ fotos, chat: [], motivo: 'video que el streamer grabo en su PS5 y eligio publicar', que, d: datos.actual(), uso: 'chat' });

  return { registrarMensaje, crear, escribir };
}
