// Editor: subes un video desde el celular (por ejemplo, uno que bajaste de la PS5 con la PS App)
// y el Centro lo deja igual que los clips automáticos: vertical con el juego más grande, frase gancho
// arriba, tus cuentas abajo, y los textos listos para Shorts, TikTok y X.
import { createWriteStream, mkdirSync, rmSync, writeFileSync, statSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { correrFfmpeg, cuadroDe, letraParaTextos, rutaFfmpeg } from './herramientas.js';
import { filtroVertical, partirGancho, lineasCuentas } from './clips.js';
import { agregar, actualizar, lista, nuevoId, CARPETA_CLIPS } from './bandeja.js';
import { log } from './estado.js';

const MAXIMO_BYTES = 2 * 1024 ** 3; // 2 GB

// Duración (s), ancho y alto del video: FFmpeg los imprime al abrirlo.
export function infoVideo(config, ruta) {
  return new Promise((ok) => {
    const p = spawn(rutaFfmpeg(config), ['-hide_banner', '-i', ruta], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', () => ok({ duracion: 0, ancho: 0, alto: 0 }));
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const t = err.match(/Video:.*?(\d{3,5})x(\d{3,5})/);
      const rot = /rotat\w*\D+(-?90|270)/i.test(err); // videos de celular grabados de lado
      let [ancho, alto] = t ? [Number(t[1]), Number(t[2])] : [0, 0];
      if (rot) [ancho, alto] = [alto, ancho];
      ok({ duracion: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0, ancho, alto });
    });
  });
}

const limpiarFrase = (t) => String(t ?? '').replace(/[#\p{Extended_Pictographic}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);

export function crearEditor({ leerConfig, clips, avisar, urlApp, canalLogin }) {
  // Arma el vertical desde un video horizontal (o ya vertical) con la frase y tus cuentas encima.
  async function armarVertical({ entrada, carpeta, gancho, salida }) {
    const config = leerConfig();
    const { ancho, alto } = await infoVideo(config, entrada);
    const yaVertical = alto > ancho;
    const c = config.clips ?? {};
    const zoom = Math.min(1, Math.max(0.4, Number(c.zoomVertical ?? 0.7)));
    const letra = c.gancho === false ? null : letraParaTextos();
    const lineas = letra ? partirGancho(gancho) : [];
    const marcas = letra && c.marcaCanal !== false ? lineasCuentas(config, canalLogin) : [];
    for (let i = 1; i <= 2; i++) rmSync(join(carpeta, `linea${i}.txt`), { force: true });
    lineas.forEach((l, i) => writeFileSync(join(carpeta, `linea${i + 1}.txt`), l));
    marcas.forEach((m, i) => writeFileSync(join(carpeta, `marca${i + 1}.txt`), m));
    const armar = (conTexto) => correrFfmpeg(config, ['-i', entrada, '-filter_complex',
      filtroVertical({ zoom, lineas: conTexto ? lineas : [], marcas: conTexto ? marcas : [], letra: conTexto ? letra : null, yaVertical }),
      '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', salida], { cwd: carpeta });
    await armar(Boolean(letra)).catch((e) => {
      if (!letra) throw e;
      log('No pude poner el texto encima; lo armo sin texto: ' + e.message, { nivel: 'aviso' });
      return armar(false);
    });
  }

  // Recibe el archivo tal cual llega del celular y lo guarda. Devuelve el id; el resto se hace aparte.
  async function recibir(req, { nota = '', nombre = '', frase = '' } = {}) {
    const largo = Number(req.headers['content-length'] ?? 0);
    if (largo > MAXIMO_BYTES) throw new Error('El video pesa más de 2 GB');
    const id = nuevoId();
    const carpeta = join(CARPETA_CLIPS, id);
    mkdirSync(carpeta, { recursive: true });
    const ext = /\.(mov|webm|mkv|m4v)$/i.test(nombre) ? nombre.slice(nombre.lastIndexOf('.')).toLowerCase() : '.mp4';
    const original = join(carpeta, 'original' + ext);
    let recibidos = 0;
    req.on('data', (c) => { recibidos += c.length; if (recibidos > MAXIMO_BYTES) req.destroy(new Error('El video pesa más de 2 GB')); });
    try {
      await pipeline(req, createWriteStream(original));
    } catch (e) {
      rmSync(carpeta, { recursive: true, force: true });
      throw new Error('No se completó la subida: ' + e.message);
    }
    if (statSync(original).size < 10_000) { rmSync(carpeta, { recursive: true, force: true }); throw new Error('El archivo llegó vacío'); }
    log(`📤 Recibí tu video (${(statSync(original).size / 1024 ** 2).toFixed(0)} MB); lo estoy editando…`);
    procesar({ id, carpeta, original, nota: String(nota).slice(0, 200), frase: limpiarFrase(frase) })
      .catch((e) => {
        log('⚠️ No pude editar tu video: ' + e.message, { nivel: 'aviso', detalle: e.stack });
        avisar('⚠️ No pude editar tu video', 'Revisa la bitácora en Diagnóstico. Prueba con otro archivo .mp4.', { clave: 'editor-' + id });
      });
    return id;
  }

  async function procesar({ id, carpeta, original, nota, frase }) {
    const config = leerConfig();
    const { duracion } = await infoVideo(config, original);
    if (!duracion) throw new Error('No reconozco ese archivo como video');
    // 5 imágenes repartidas en el video para que la IA entienda qué pasa.
    const fotos = [];
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      try {
        const jpg = await cuadroDe(config, original, duracion * p, 512);
        fotos.push({ mime: 'image/jpeg', base64: jpg.toString('base64') });
      } catch { /* esa imagen no salió */ }
    }
    const textos = await clips.escribir({ fotos, que: nota });
    if (frase) textos.gancho = frase; // la frase que escribiste tú manda
    await armarVertical({ entrada: original, carpeta, gancho: textos.gancho, salida: join(carpeta, 'vertical.mp4') });
    if (fotos.length) writeFileSync(join(carpeta, 'portada.jpg'), Buffer.from(fotos[Math.floor(fotos.length / 2)].base64, 'base64'));

    const nombreOriginal = original.split(/[\\/]/).pop();
    agregar({
      id, tipo: 'clip', subido: true, motivo: nota ? `tu video: ${nota}` : 'tu video de la PS5', puntos: 10,
      titulo: textos.titulo, gancho: textos.gancho,
      tituloShorts: textos.tituloShorts, textoTikTok: textos.tiktok, textoX: textos.x,
      archivos: { horizontal: `${id}/${nombreOriginal}`, vertical: `${id}/vertical.mp4`, portada: `${id}/portada.jpg` },
    });
    log(`📤 Tu video quedó listo: ${textos.titulo}`);
    avisar('🎬 Tu video está listo', `${textos.titulo}\nYa está en vertical con su texto para Shorts y TikTok.`, {
      etiquetas: ['clapper'], abrir: `${urlApp()}#clips/${id}`, clave: 'editor-' + id,
    });
  }

  // "Cambiar frase": tu frase o una nueva de la IA, y se vuelve a armar el vertical (sin subir nada otra vez).
  const enProceso = new Set();
  async function cambiarFrase(id, frase = '') {
    const item = lista().find((x) => x.id === id);
    if (!item || item.tipo !== 'clip') throw new Error('No encontré ese video');
    if (enProceso.has(id)) throw new Error('Ya estoy rehaciendo ese video; espera un momento');
    const carpeta = join(CARPETA_CLIPS, id);
    const entrada = item.archivos.horizontal ? join(CARPETA_CLIPS, item.archivos.horizontal) : null;
    if (!entrada || !existsSync(entrada)) throw new Error('Este video ya no tiene su versión original para rehacerlo');
    enProceso.add(id);
    actualizar(id, { rehaciendo: true });
    (async () => {
      try {
        let nueva = limpiarFrase(frase);
        if (!nueva) {
          const config = leerConfig();
          const { duracion } = await infoVideo(config, entrada);
          const fotos = [];
          for (const p of [0.3, 0.6, 0.9]) {
            try { fotos.push({ mime: 'image/jpeg', base64: (await cuadroDe(config, entrada, duracion * p, 512)).toString('base64') }); } catch { /* sin esa imagen */ }
          }
          nueva = await clips.fraseNueva({ item, fotos });
        }
        if (!nueva) throw new Error('La IA no dio una frase nueva');
        const temporal = join(carpeta, 'vertical-nuevo.mp4');
        await armarVertical({ entrada, carpeta, gancho: nueva, salida: temporal });
        renameSync(temporal, join(carpeta, 'vertical.mp4'));
        actualizar(id, { gancho: nueva, rehaciendo: false, editado: Date.now() });
        log(`✏️ Frase cambiada: "${nueva}"`);
        avisar('✏️ Frase cambiada', `"${nueva}"\nEl video vertical ya está actualizado.`, { abrir: `${urlApp()}#clips/${id}`, clave: 'frase-' + id + Date.now() });
      } catch (e) {
        actualizar(id, { rehaciendo: false });
        log('⚠️ No pude cambiar la frase: ' + e.message, { nivel: 'aviso' });
        avisar('⚠️ No pude cambiar la frase', e.message, { clave: 'frase-error-' + id });
      } finally {
        enProceso.delete(id);
      }
    })();
  }

  return { recibir, cambiarFrase };
}
