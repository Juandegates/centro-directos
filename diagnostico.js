// "Probar todo": revisa cada parte del Centro una por una y dice qué funciona y qué no.
import { spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rutaFfmpeg, rutaStreamlink } from './herramientas.js';
import { preguntarIA } from './ia.js';
import * as twitch from './twitch.js';
import * as youtube from './youtube.js';
import { avisar } from './avisos.js';
import { limpiar } from './estado.js';

async function prueba(nombre, fn) {
  const inicio = Date.now();
  try {
    const detalle = await fn();
    return { nombre, ok: true, detalle: detalle ?? 'OK', ms: Date.now() - inicio };
  } catch (e) {
    return { nombre, ok: false, detalle: limpiar(e.cause?.code ? `${e.message} (${e.cause.code})` : e.message), ms: Date.now() - inicio };
  }
}

const programa = (ruta, args) => {
  const r = spawnSync(ruta, args, { windowsHide: true, timeout: 15_000 });
  if (r.error) throw new Error(`No encontré ${ruta} (${r.error.code})`);
  return r.stdout.toString().split('\n')[0].trim();
};

export async function probarTodo({ leerConfig, canalId }) {
  const config = leerConfig();
  const resultados = [];
  resultados.push(await prueba('Internet', async () => {
    const r = await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(8000) });
    if (r.status !== 204) throw new Error(`Respuesta rara: ${r.status}`);
  }));
  resultados.push(await prueba('Aviso de prueba al celular', async () => {
    if (!(await avisar('🔧 Prueba del Centro', 'Si ves esto, los avisos funcionan.', { clave: 'prueba' + Date.now(), etiquetas: ['wrench'] }))) throw new Error('ntfy no recibió el aviso (revisa el internet de la PC)');
    return 'Enviado (revisa tu celular)';
  }));
  resultados.push(await prueba('Espacio en disco', async () => {
    const s = statfsSync(fileURLToPath(new URL('./', import.meta.url)));
    const libres = (s.bavail * s.bsize) / 2 ** 30;
    if (libres < 5) throw new Error(`Quedan solo ${libres.toFixed(1)} GB libres`);
    return `${libres.toFixed(0)} GB libres`;
  }));
  resultados.push(await prueba('Twitch: sesión y permisos', async () => {
    const yo = await twitch.idDeUsuario();
    const faltan = twitch.permisosFaltantes();
    if (faltan.length) throw new Error(`Faltan permisos (${faltan.join(', ')}): vuelve a autorizar en http://localhost:3000/twitch desde la PC`);
    return `Sesión de ${yo.display_name}`;
  }));
  resultados.push(await prueba('Twitch: tu canal', async () => {
    const c = await twitch.infoCanal(canalId);
    return `${c.game_name || 'sin categoría'} · "${c.title || 'sin título'}"`;
  }));
  resultados.push(await prueba('YouTube', async () => {
    if (!youtube.configurado()) throw new Error('Falta configurar Google (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en claves.txt)');
    if (!youtube.tieneSesion()) throw new Error('Falta autorizar YouTube en http://localhost:3000/youtube desde la PC');
    const c = await youtube.miCanal();
    return `Canal "${c.nombre}" · cuota usada hoy: ${youtube.cuotaUsada()} de 10,000`;
  }));
  resultados.push(await prueba('IA (Gemini o respaldo)', async () => {
    const r = await preguntarIA({ sistema: 'Responde con una sola palabra.', texto: 'Di: listo' });
    return `Respondió: ${r.slice(0, 40)}`;
  }));
  if (config.iaLocal?.activa) {
    resultados.push(await prueba('IA de la PC (Ollama)', async () => {
      const r = await fetch(`${config.iaLocal.url ?? 'http://localhost:11434'}/api/tags`, { signal: AbortSignal.timeout(5000) });
      const d = await r.json();
      const modelos = (d.models ?? []).map((m) => m.name);
      if (!modelos.some((m) => m.startsWith(config.iaLocal.modelo))) throw new Error(`Ollama funciona pero falta el modelo ${config.iaLocal.modelo} (tiene: ${modelos.join(', ') || 'ninguno'})`);
      return `Modelo ${config.iaLocal.modelo} listo`;
    }));
  }
  resultados.push(await prueba('Streamlink', async () => programa(rutaStreamlink(config), ['--version'])));
  resultados.push(await prueba('FFmpeg', async () => programa(rutaFfmpeg(config), ['-version']).slice(0, 60)));
  return resultados;
}
