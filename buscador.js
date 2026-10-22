// Buscador de internet para guías y datos de juegos (Tavily: 1,000 búsquedas al mes gratis, sin tarjeta).
// Guarda las búsquedas un día para no gastar dos veces en la misma pregunta.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ajustes, guardarAjustes } from './ajustes.js';
import { log, marcar } from './estado.js';

const ARCHIVO = new URL('./busquedas.json', import.meta.url);
const LIMITE_MES = 950; // dejamos margen antes de las 1,000 gratis

let cache = existsSync(ARCHIVO) ? (() => { try { return JSON.parse(readFileSync(ARCHIVO, 'utf8')); } catch { return {}; } })() : {};
const guardarCache = () => {
  const limite = Date.now() - 24 * 3600_000;
  cache = Object.fromEntries(Object.entries(cache).filter(([, v]) => v.hora > limite));
  writeFileSync(ARCHIVO, JSON.stringify(cache));
};

const clave = () => process.env.TAVILY_API_KEY && !process.env.TAVILY_API_KEY.startsWith('pega_aqui') ? process.env.TAVILY_API_KEY : null;
export const buscadorConfigurado = () => Boolean(clave());

const mesActual = () => new Date().toISOString().slice(0, 7);
export function usadasEsteMes() {
  const u = ajustes().busquedas ?? {};
  return u.mes === mesActual() ? u.usadas : 0;
}
const contar = () => guardarAjustes({ busquedas: { mes: mesActual(), usadas: usadasEsteMes() + 1 } });

const normal = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Arma la búsqueda con el nombre exacto del juego para no mezclarlo con otros de la saga.
export function armarConsulta(pregunta, juego) {
  let q = pregunta.replace(/@\w+/g, '').replace(/^\s*bot\b/i, '').trim();
  if (juego && juego !== 'sin juego definido' && !normal(q).includes(normal(juego).split(' ').slice(0, 2).join(' '))) q = `${juego} ${q}`;
  return q.slice(0, 300);
}

// Devuelve { respuesta, resultados: [{ titulo, texto }] } o null si no se pudo buscar.
export async function buscar(consulta) {
  if (!clave()) return null;
  const id = normal(consulta);
  if (cache[id]) { log(`🔎 Búsqueda repetida, uso la guardada: ${consulta}`); return cache[id].datos; }
  if (usadasEsteMes() >= LIMITE_MES) {
    marcar('ia', 'aviso', `Ya se usaron ${usadasEsteMes()} búsquedas este mes; contesto sin buscar hasta el próximo mes`);
    return null;
  }
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${clave()}` },
      body: JSON.stringify({ query: consulta, search_depth: 'basic', max_results: 5, include_answer: true }),
      signal: AbortSignal.timeout(10_000),
    });
    contar();
    if (!res.ok) throw new Error(`Tavily respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json();
    const datos = {
      respuesta: d.answer ?? '',
      resultados: (d.results ?? []).slice(0, 5).map((r) => ({ titulo: r.title ?? '', texto: (r.content ?? '').slice(0, 700) })),
    };
    cache[id] = { hora: Date.now(), datos };
    guardarCache();
    log(`🔎 Busqué en internet: "${consulta}" (${datos.resultados.length} resultados · ${usadasEsteMes()} de 1,000 este mes)`);
    return datos;
  } catch (e) {
    log('⚠️ No pude buscar en internet: ' + e.message, { nivel: 'aviso' });
    return null;
  }
}

// Texto para pasarle a la IA, sin links ni nombres de páginas.
export function resumenParaIA(datos) {
  if (!datos) return '';
  const partes = datos.resultados.map((r, i) => `(${i + 1}) ${r.titulo}: ${r.texto}`);
  return [datos.respuesta ? `Resumen: ${datos.respuesta}` : '', ...partes].filter(Boolean).join('\n');
}
