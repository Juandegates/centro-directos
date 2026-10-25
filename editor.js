// Editor: subes un video desde el celular (por ejemplo, uno que bajaste de la PS5 con la PS App)
// y el Centro lo deja igual que los clips automáticos: vertical con el juego más grande, frase gancho
// arriba, tus cuentas abajo, y los textos listos para Shorts, TikTok y X.
import { createWriteStream, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { correrFfmpeg, cuadroDe, letraParaTextos, rutaFfmpeg } from './herramientas.js';
import { filtroVertical, partirGancho, lineasCuentas } from './clips.js';
import { agregar, nuevoId, CARPETA_CLIPS } from './bandeja.js';
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

export function crearEditor({ leerConfig, clips, avisar, urlApp, canalLogin }) {
  // Recibe el archivo tal cual llega del celular y lo guarda. Devuelve el id; el resto se hace aparte.
  async function recibir(req, { nota = '', nombre = '' } = {}) {
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
    procesar({ id, carpeta, original, nota: String(nota).slice(0, 200) })
      .catch((e) => {
        log('⚠️ No pude editar tu video: ' + e.message, { nivel: 'aviso', detalle: e.stack });
        avisar('⚠️ No pude editar tu video', 'Revisa la bitácora en Diagnóstico. Prueba con otro archivo .mp4.', { clave: 'editor-' + id });
      });
    return id;
  }

  async function procesar({ id, carpeta, original, nota }) {
    const config = leerConfig();
    const { duracion, ancho, alto } = await infoVideo(config, original);
    const yaVertical = alto > ancho;
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

    const c = config.clips ?? {};
    const zoom = Math.min(1, Math.max(0.4, Number(c.zoomVertical ?? 0.7)));
    const letra = c.gancho === false ? null : letraParaTextos();
    const lineas = letra ? partirGancho(textos.gancho) : [];
    const marcas = letra && c.marcaCanal !== false ? lineasCuentas(config, canalLogin) : [];
    lineas.forEach((l, i) => writeFileSync(join(carpeta, `linea${i + 1}.txt`), l));
    marcas.forEach((m, i) => writeFileSync(join(carpeta, `marca${i + 1}.txt`), m));
    const vertical = join(carpeta, 'vertical.mp4');
    const armar = (conTexto) => correrFfmpeg(config, ['-i', original, '-filter_complex',
      filtroVertical({ zoom, lineas: conTexto ? lineas : [], marcas: conTexto ? marcas : [], letra: conTexto ? letra : null, yaVertical }),
      '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', vertical], { cwd: carpeta });
    await armar(Boolean(letra)).catch((e) => {
      if (!letra) throw e;
      log('No pude poner el texto encima; lo armo sin texto: ' + e.message, { nivel: 'aviso' });
      return armar(false);
    });
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

  return { recibir };
}
