// Clips automáticos: detecta los mejores momentos y corta un clip horizontal y uno vertical (TikTok/Shorts).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { correrFfmpeg } from './herramientas.js';
import { preguntarIA } from './ia.js';
import { marcar, log } from './estado.js';
import { agregar, nuevoId, CARPETA_CLIPS } from './bandeja.js';

const REACCIONES = /(ja){2,}|j[aeo]j[aeo]|xd|lol|lmao|no+o+|wo+w|gg|clip|que paso|qu[eé] fue eso|nooo|alv|uff|omg|bruh|😂|🤣|😱|🔥/i;

export function crearClips({ captura, leerConfig, datos, crearClipTwitch, avisar, urlApp }) {
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

  async function crear(motivo) {
    const c = leerConfig().clips ?? {};
    if (trabajando || !captura.activa()) return null;
    if (Date.now() - ultimoClip < (c.minutosEntreClips ?? 3) * 60_000 && motivo !== 'manual') return null;
    trabajando = true;
    ultimoClip = Date.now();
    const id = nuevoId();
    const carpeta = join(CARPETA_CLIPS, id);
    const fotos = captura.recientes(5);
    const chat = mensajes.filter((m) => m.hora > Date.now() - 60_000).map((m) => m.linea).slice(-15);
    log(`🎬 Momento detectado (${motivo}); armando clip…`, { parte: 'clips' });

    try {
      const twitch = await crearClipTwitch().catch((e) => {
        log('No pude crear el clip en Twitch: ' + e.message, { parte: 'clips', nivel: 'aviso' });
        return null;
      });

      // Esperamos para incluir lo que pasó justo después del momento.
      await new Promise((r) => setTimeout(r, 15_000));
      const pedazos = captura.pedazos(c.segundos ?? 40);
      if (pedazos.length < 2) throw new Error('Todavía no hay suficiente grabación para el clip');

      mkdirSync(carpeta, { recursive: true });
      const listaArchivos = join(carpeta, 'lista.txt');
      writeFileSync(listaArchivos, pedazos.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
      const config = leerConfig();
      const horizontal = join(carpeta, 'horizontal.mp4');
      const vertical = join(carpeta, 'vertical.mp4');
      const portada = join(carpeta, 'portada.jpg');

      await correrFfmpeg(config, ['-f', 'concat', '-safe', '0', '-i', listaArchivos, '-c', 'copy', '-movflags', '+faststart', horizontal]);
      // Vertical: el juego al centro con zoom (recorta un poco los lados para que se vea más grande en el celular).
      const zoom = Math.min(1, Math.max(0.4, Number(c.zoomVertical ?? 0.7)));
      await correrFfmpeg(config, ['-i', horizontal, '-filter_complex',
        '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20:5[fondo];' +
        `[0:v]crop=trunc(iw*${zoom}/2)*2:ih,scale=1080:-2[frente];[fondo][frente]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`,
        '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', vertical]);
      await correrFfmpeg(config, ['-ss', '3', '-i', horizontal, '-frames:v', '1', '-vf', 'scale=480:-2', portada]);

      const textos = await escribirTextos({ fotos, chat, motivo, d: datos.actual() });
      const item = agregar({
        id, tipo: 'clip', motivo,
        juego: datos.actual().juego,
        titulo: textos.titulo,
        textoTikTok: textos.tiktok,
        textoX: textos.x,
        twitch,
        archivos: { horizontal: `${id}/horizontal.mp4`, vertical: `${id}/vertical.mp4`, portada: `${id}/portada.jpg` },
      });
      marcar('clips', 'ok', `Último clip: ${textos.titulo}`);
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

  async function escribirTextos({ fotos, chat, motivo, d }) {
    const respaldo = {
      titulo: `Momentazo en ${d.juego}`,
      tiktok: `Momentazo en ${d.juego} 🎮🔥 #${d.juego.replace(/[^a-z0-9]/gi, '')} #PS5 #gaming #twitch`,
      x: `Momentazo en ${d.juego} 🎮🔥`,
    };
    try {
      const r = await preguntarIA({
        sistema: `Eres el community manager de ${d.nombre}, streamer mexicano de PS5. Escribes en espanol mexicano, con gancho, sin mentir.`,
        imagenes: fotos,
        texto:
          `Juego: ${d.juego}. Motivo del clip: ${motivo}.\nChat en ese momento:\n${chat.join('\n') || '(sin mensajes)'}\n\n` +
          `Notas de la partida: ${d.notasJuego || '(ninguna)'}\n\n` +
          'Las imagenes son del momento del clip (la ultima es la mas reciente). Mira bien que esta pasando: jefe, enemigos, zona, accion, si gano o perdio. ' +
          'El titulo y los textos deben describir ESO en concreto (ej. "Me enfrento al jefe de la catedral", "Casi muero con estos picos"). ' +
          'Prohibido usar frases genericas como "paso perfecto", "momentazo", "epico" o "no te lo pierdas" si no dicen que paso. No inventes lo que no se ve.\n' +
          'Devuelve SOLO un JSON valido con estas llaves:\n' +
          '"titulo": titulo corto con gancho (max 60 caracteres),\n' +
          '"tiktok": descripcion para TikTok/Shorts con 4 a 6 hashtags relevantes (max 200 caracteres),\n' +
          '"x": texto para X (max 200 caracteres, sin hashtags de mas).',
      });
      const json = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
      return { titulo: json.titulo || respaldo.titulo, tiktok: json.tiktok || respaldo.tiktok, x: json.x || respaldo.x };
    } catch {
      return respaldo;
    }
  }

  return { registrarMensaje, crear };
}
