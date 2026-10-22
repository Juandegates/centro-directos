// IA: primero Gemini (gratis, en la nube); si está saturado o en su límite, la IA de tu PC (Ollama).
import { marcar } from './estado.js';

const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PREFERIDOS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const ESPERA_MAXIMA_MS = 12_000;

let avisos = () => {};
export const alAvisoIA = (fn) => { avisos = fn; };

let geminiPausadoHasta = 0;
let configIA = () => ({});
export const configurarIA = (fn) => { configIA = fn; };

// Pregunta a Google qué modelos Flash tiene disponibles tu clave (cambian con el tiempo).
let catalogo = { hora: 0, modelos: [] };
async function modelosDisponibles(clave) {
  if (Date.now() - catalogo.hora < 6 * 3600_000 && catalogo.modelos.length) return catalogo.modelos;
  try {
    const r = await fetch(`${URL_BASE}?pageSize=1000`, { headers: { 'x-goog-api-key': clave }, signal: AbortSignal.timeout(10_000) });
    const d = await r.json();
    const version = (n) => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) ?? [])[1] ?? 0);
    const modelos = (d.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''))
      .filter((n) => /^gemini-.*flash/.test(n) && !/image|tts|audio|live|embedding|thinking|exp/.test(n))
      .sort((a, b) => version(b) - version(a) || Number(/lite/.test(a)) - Number(/lite/.test(b)) || Number(/preview/.test(a)) - Number(/preview/.test(b)));
    if (modelos.length) catalogo = { hora: Date.now(), modelos };
  } catch { /* sin catálogo: usamos los preferidos */ }
  return catalogo.modelos;
}

// Modelos que fallaron hace poco se brincan un rato, y el último que funcionó va primero:
// así el bot contesta en segundos aunque Google tenga algún modelo saturado.
const castigados = new Map(); // modelo → hasta cuándo no usarlo
let ultimoBueno = null;
let busquedaPausadaHasta = 0;
export let ultimaBusqueda = { hora: 0, consultas: [], modelo: null, error: null };
export const reactivarBusqueda = () => { busquedaPausadaHasta = 0; };
const castigar = (modelo, minutos) => castigados.set(modelo, Date.now() + minutos * 60_000);

async function gemini({ sistema, texto, imagenes, buscar }) {
  const clave = process.env.GEMINI_API_KEY;
  if (!clave) throw new Error('Falta GEMINI_API_KEY en claves.txt');
  const disponibles = await modelosDisponibles(clave);
  const todos = [...new Set([ultimoBueno, process.env.GEMINI_MODELO, ...PREFERIDOS, ...disponibles].filter(Boolean))].slice(0, 7);
  let modelos = todos.filter((m) => !(castigados.get(m) > Date.now()));
  if (!modelos.length) modelos = todos; // si todos están castigados, igual lo intentamos

  const armar = (conBusqueda) => JSON.stringify({
    systemInstruction: { parts: [{ text: sistema }] },
    contents: [{
      role: 'user',
      parts: [
        ...imagenes.map((i) => ({ inline_data: { mime_type: i.mime, data: i.base64 } })),
        { text: conBusqueda ? texto + '\n\n(Antes de contestar, busca en Google la informacion del juego que te preguntan y usala.)' : texto },
      ],
    }],
    ...(conBusqueda ? { tools: [{ google_search: {} }] } : {}),
    generationConfig: { temperature: 0.9, maxOutputTokens: 2048 },
  });

  let todosEnLimite = true;
  let ultimoError = '';
  const fases = buscar && Date.now() > busquedaPausadaHasta ? [true, false] : [false];

  for (const conBusqueda of fases) {
    let erroresDeBusqueda = 0;
    for (const modelo of modelos) {
      if (castigados.get(modelo) > Date.now() && modelos.some((m) => !(castigados.get(m) > Date.now()))) continue;
      let res;
      try {
        res = await fetch(`${URL_BASE}/${modelo}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave },
          body: armar(conBusqueda),
          signal: AbortSignal.timeout(conBusqueda ? 25_000 : ESPERA_MAXIMA_MS),
        });
      } catch (e) {
        todosEnLimite = false;
        ultimoError = e.name === 'TimeoutError' ? `${modelo} tardó demasiado` : `${modelo}: ${e.cause?.code ?? e.message}`;
        if (!conBusqueda) castigar(modelo, 10);
        avisos(`IA: ${ultimoError}; pruebo otro modelo…`);
        continue;
      }

      if (res.ok) {
        const datos = await res.json();
        const cand = datos.candidates?.[0];
        const partes = cand?.content?.parts ?? [];
        ultimoBueno = modelo;
        const consultas = cand?.groundingMetadata?.webSearchQueries ?? [];
        if (conBusqueda) {
          ultimaBusqueda = { hora: Date.now(), consultas, modelo, error: null };
          avisos(consultas.length ? `🔎 Busqué en Google: ${consultas.join(' | ')}` : '🔎 La IA tenía la búsqueda disponible pero decidió no buscar');
        }
        marcar('ia', 'ok', `Funcionando (${modelo}${conBusqueda ? ' + búsqueda' : ''})`);
        return partes.filter((p) => !p.thought).map((p) => p.text ?? '').join('').replace(/\s+/g, ' ').trim();
      }

      const detalle = (await res.text()).slice(0, 300);
      if (conBusqueda && [400, 403, 429].includes(res.status)) {
        // Este modelo no deja buscar (o se acabó la cuota de búsqueda): probamos la búsqueda en otro modelo.
        erroresDeBusqueda++;
        ultimaBusqueda = { hora: Date.now(), consultas: [], modelo, error: `${res.status}: ${detalle}` };
        avisos(`🔎 ${modelo} no permitió buscar (${res.status}); pruebo la búsqueda en otro modelo…`);
        continue;
      }
      if (res.status !== 429) todosEnLimite = false;
      if ([429, 500, 503, 504, 404].includes(res.status)) {
        ultimoError = `${modelo} respondió ${res.status}`;
        castigar(modelo, res.status === 404 ? 24 * 60 : 10);
        avisos(`IA: ${ultimoError}; pruebo otro modelo…`);
        continue;
      }
      marcar('ia', 'error', `Gemini respondió ${res.status}`, detalle);
      throw new Error(`La IA respondió ${res.status}: ${detalle}`);
    }
    if (conBusqueda) {
      if (erroresDeBusqueda) busquedaPausadaHasta = Date.now() + 30 * 60_000;
      marcar('ia', 'aviso', 'La búsqueda en Google no está disponible ahorita; contesto sin buscar', ultimaBusqueda.error ?? ultimoError);
    }
  }

  const e = new Error(todosEnLimite ? 'Gemini llegó a su límite gratuito' : `Ningún modelo de Gemini respondió (${ultimoError})`);
  e.limite = true;
  throw e;
}

async function local({ sistema, texto, imagenes }) {
  const c = configIA().iaLocal ?? {};
  if (!c.activa) throw new Error('IA de respaldo desactivada');
  const res = await fetch(`${c.url ?? 'http://localhost:11434'}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.modelo,
      stream: false,
      options: { temperature: 0.9, num_predict: 300 },
      messages: [
        { role: 'system', content: sistema },
        { role: 'user', content: texto, ...(imagenes.length && c.veImagenes !== false ? { images: imagenes.slice(-1).map((i) => i.base64) } : {}) },
      ],
    }),
    signal: AbortSignal.timeout((c.segundosMaximos ?? 60) * 1000),
  });
  if (!res.ok) throw new Error(`IA de la PC respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return (d.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
}

export async function preguntarIA({ sistema, texto, imagenes = [], buscar = false }) {
  let errorGemini = null;
  if (Date.now() >= geminiPausadoHasta) {
    try {
      return await gemini({ sistema, texto, imagenes, buscar });
    } catch (e) {
      errorGemini = e;
      if (e.limite) {
        geminiPausadoHasta = Date.now() + 60_000;
        marcar('ia', 'aviso', e.message + (configIA().iaLocal?.activa ? '; uso la IA de la PC por 1 minuto' : '; reintento en 1 minuto'), e.message);
      }
    }
  }
  try {
    const r = await local({ sistema, texto, imagenes });
    marcar('iaLocal', 'ok', `Respondió (${configIA().iaLocal?.modelo})`);
    return r;
  } catch (e) {
    if (configIA().iaLocal?.activa) marcar('iaLocal', 'error', 'La IA de la PC no respondió', e.cause?.code ?? e.message);
    const final = new Error(errorGemini ? `${errorGemini.message}; y la IA de la PC tampoco respondió` : e.message);
    final.limite = true;
    throw final;
  }
}
