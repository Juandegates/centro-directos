// "Probar todo": revisa cada parte del Centro una por una y dice qué funciona y qué no.
import { spawnSync } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rutaFfmpeg, rutaStreamlink } from './herramientas.js';
import { preguntarIA, iasConfiguradas } from './ia.js';
import { buscar, buscadorConfigurado, usadasEsteMes } from './buscador.js';
import * as twitch from './twitch.js';
import * as youtube from './youtube.js';
import * as kick from './kick.js';
import { probarConexion } from './tunel.js';
import { preguntarClaude, claudeDisponible } from './claude.js';
import { probarServicios } from './publicar.js';
import { urlBase } from './publico.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as unir } from 'node:path';
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
  if (kick.envioConfigurado() || kick.configurado()) {
    resultados.push(await prueba('Kick', async () => {
      if (!kick.envioConfigurado()) throw new Error('Falta KICK_STREAM_URL y KICK_STREAM_KEY en claves.txt (sin eso no se envía el video)');
      if (!kick.configurado()) return 'Clave de transmisión lista · sin app de Kick (no pone título ni platica en el chat)';
      if (!kick.tieneSesion()) throw new Error('Falta autorizar Kick en http://localhost:3000/kick desde la PC');
      const c = await kick.miCanal();
      const d = kick.destinoEnvio();
      let servidor = '';
      if (d?.seguro) {
        try { await probarConexion({ host: d.host, puerto: d.puerto }); servidor = ' · servidor de envío alcanzable'; }
        catch (e) { throw new Error(`No pude abrir conexión segura con el servidor de envío de Kick (${d.host}): ${e.code ?? e.message}`); }
      }
      return `Canal kick.com/${c.slug} · clave de transmisión ${d?.pareceClave ? 'lista' : 'puesta (ojo: no parece de Kick, deben empezar con sk_)'}${servidor}`;
    }));
  }
  // v5: Claude (con tu plan Max) para elegir y revisar los videos.
  resultados.push(await prueba('Claude (elige y revisa videos)', async () => {
    if (!claudeDisponible(config)) throw new Error('No encontré Claude Code en esta PC. Instálalo (el mismo de MythForge) e inicia sesión con "claude"');
    const carpeta = mkdtempSync(unir(tmpdir(), 'centro-claude-'));
    try {
      const r = await preguntarClaude({ prompt: 'Responde SOLO con este JSON exacto: {"ok": true}', carpeta, config, minutos: 3 });
      if (r.ok !== true) throw new Error('Respuesta rara: ' + JSON.stringify(r).slice(0, 100));
      return 'Respondió bien (usa tu plan Max)';
    } finally { rmSync(carpeta, { recursive: true, force: true }); }
  }));
  // v5: redes para publicar solo, y la dirección pública por donde descargan los videos.
  for (const s of await probarServicios(config)) {
    resultados.push(await prueba(s.nombre, async () => { if (!s.ok) throw new Error(s.detalle); return s.detalle; }));
  }
  resultados.push(await prueba('Dirección pública (Funnel) para los videos', async () => {
    const b = urlBase();
    if (!b) throw new Error('Sin dirección: revisa que Tailscale esté abierto y que Funnel esté activo (tailscale funnel --bg --https=8443 3001)');
    const r = await fetch(b + '/robots.txt', { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`Funnel respondió ${r.status}`);
    return b;
  }));
  // Cada IA de la nube por separado, para saber cuáles funcionan.
  for (const p of iasConfiguradas()) {
    const nombre = { gemini: 'Gemini', mistral: 'Mistral', groq: 'Groq' }[p];
    resultados.push(await prueba(`IA en la nube: ${nombre}`, async () => {
      const r = await preguntarIA({ sistema: 'Responde con una sola palabra.', texto: 'Di: listo', solo: p });
      return `Respondió: ${r.slice(0, 40)}`;
    }));
  }
  resultados.push(await prueba('Búsqueda en internet (guías del juego)', async () => {
    if (!buscadorConfigurado()) throw new Error('Falta TAVILY_API_KEY en claves.txt (cuenta gratis en tavily.com)');
    const r = await buscar('noticias de videojuegos esta semana ' + new Date().toISOString().slice(0, 10));
    if (!r?.resultados.length) throw new Error('El buscador no devolvió resultados (revisa la bitácora)');
    return `${r.resultados.length} resultados · ${usadasEsteMes()} de 1,000 búsquedas usadas este mes`;
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
