// IA: varias IAs gratis en la nube, cada una con su propio cupo (Gemini, Mistral y Groq), y la IA de tu PC
// (Ollama) como último respaldo. Si una se satura o llega a su límite, el Centro pasa a la siguiente.
// Las respuestas al chat usan primero la más rápida; las tareas de fondo (clips, notas, categoría)
// usan primero la de cupo más grande, para que la rápida no se gaste.
import { marcar } from './estado.js';

const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PREFERIDOS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
// Con imágenes de la pantalla la IA tarda más, así que le damos más tiempo.
const ESPERA_MAXIMA_MS = { texto: 9_000, imagenes: 15_000 };  // por modelo
const ESPERA_TOTAL_MS = { texto: 16_000, imagenes: 30_000 };  // entre todos los modelos

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

  const tipo = imagenes.length ? 'imagenes' : 'texto';
  const limite = Date.now() + ESPERA_TOTAL_MS[tipo]; // nunca esperar más de esto en total
  for (const conBusqueda of fases) {
    let erroresDeBusqueda = 0;
    for (const modelo of modelos) {
      if (castigados.get(modelo) > Date.now() && modelos.some((m) => !(castigados.get(m) > Date.now()))) continue;
      const queda = limite - Date.now();
      if (queda < 2500) { ultimoError = ultimoError || 'se acabó el tiempo de espera'; todosEnLimite = false; break; }
      let res;
      try {
        res = await fetch(`${URL_BASE}/${modelo}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave },
          body: armar(conBusqueda),
          signal: AbortSignal.timeout(Math.min(conBusqueda ? 25_000 : ESPERA_MAXIMA_MS[tipo], queda)),
        });
      } catch (e) {
        todosEnLimite = false;
        ultimoError = e.name === 'TimeoutError' ? `${modelo} tardó demasiado` : `${modelo}: ${e.cause?.code ?? e.message}`;
        if (!conBusqueda) castigar(modelo, 3); // tardarse suele ser pasajero
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
        // 429 = se acabó el cupo de ese modelo (suele ser del día): lo dejamos descansar una hora.
        castigar(modelo, res.status === 404 ? 24 * 60 : res.status === 429 ? 60 : 10);
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

// ---------- Otras IAs gratis en la nube (formato compatible con OpenAI) ----------
const PROVEEDORES = {
  mistral: {
    nombre: 'Mistral',
    clave: () => process.env.MISTRAL_API_KEY,
    url: 'https://api.mistral.ai/v1/chat/completions',
    modelo: () => configIA().ia?.mistral ?? 'mistral-small-latest',
    maxImagenes: 8,
    imagen: (i) => ({ type: 'image_url', image_url: `data:${i.mime};base64,${i.base64}` }),
  },
  groq: {
    nombre: 'Groq',
    clave: () => process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    modelo: () => configIA().ia?.groq ?? 'qwen/qwen3.8-27b',
    maxImagenes: 3,
    imagen: (i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } }),
  },
};
const configurado = (p) => {
  const k = PROVEEDORES[p]?.clave();
  return Boolean(k && !k.startsWith('pega_aqui'));
};
const pausados = new Map(); // proveedor → hasta cuándo no usarlo

async function compatible(p, { sistema, texto, imagenes }) {
  const prov = PROVEEDORES[p];
  const imgs = imagenes.slice(-prov.maxImagenes);
  const res = await fetch(prov.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.clave()}` },
    body: JSON.stringify({
      model: prov.modelo(),
      temperature: 0.8,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: sistema },
        { role: 'user', content: imgs.length ? [...imgs.map(prov.imagen), { type: 'text', text: texto }] : texto },
      ],
    }),
    signal: AbortSignal.timeout(imgs.length ? 20_000 : 12_000),
  });
  if (!res.ok) {
    const detalle = (await res.text()).slice(0, 300);
    const e = new Error(`${prov.nombre} respondió ${res.status}: ${detalle}`);
    e.status = res.status;
    throw e;
  }
  const d = await res.json();
  const t = d.choices?.[0]?.message?.content;
  const texto2 = Array.isArray(t) ? t.map((x) => x.text ?? '').join('') : String(t ?? '');
  const limpio = texto2.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
  if (!limpio) throw new Error(`${prov.nombre} respondió vacío`);
  return limpio;
}

export const iasConfiguradas = () => ['gemini', ...Object.keys(PROVEEDORES).filter(configurado)];

// uso: 'chat' (contestar en vivo: primero la más rápida) o 'fondo' (clips, notas, categoría: primero la de más cupo).
export async function preguntarIA({ sistema, texto, imagenes = [], buscar = false, uso = 'fondo', solo = null }) {
  const errores = [];
  const orden = solo ? [solo] : uso === 'chat' ? ['gemini', 'groq', 'mistral'] : ['mistral', 'gemini', 'groq'];
  for (const p of orden) {
    if (p === 'gemini') {
      if (Date.now() < geminiPausadoHasta) continue;
      try {
        return await gemini({ sistema, texto, imagenes, buscar });
      } catch (e) {
        errores.push(e.message);
        if (e.limite) geminiPausadoHasta = Date.now() + 60_000;
      }
      continue;
    }
    if (!configurado(p) || (pausados.get(p) ?? 0) > Date.now()) continue;
    try {
      const r = await compatible(p, { sistema, texto, imagenes });
      marcar('ia', 'ok', `Funcionando (${PROVEEDORES[p].nombre})`);
      return r;
    } catch (e) {
      errores.push(e.name === 'TimeoutError' ? `${PROVEEDORES[p].nombre} tardó demasiado` : e.message);
      // Límite alcanzado: esa IA descansa 30 min. Otras fallas: 2 min.
      pausados.set(p, Date.now() + (e.status === 429 ? 30 : 2) * 60_000);
      avisos(`IA: ${errores.at(-1).slice(0, 120)}; pruebo otra…`);
    }
  }
  const errorNube = errores.length ? new Error(`Ninguna IA de la nube respondió (${errores.at(-1).slice(0, 150)})`) : null;
  if (errorNube) marcar('ia', 'aviso', errorNube.message + (configIA().iaLocal?.activa ? '; uso la IA de la PC' : '; reintento en un momento'), errores.join(' | ').slice(0, 1500));
  const errorGemini = errorNube;
  try {
    const r = await local({ sistema, texto, imagenes });
    marcar('iaLocal', 'ok', `Respondió (${configIA().iaLocal?.modelo})`);
    return r;
  } catch (e) {
    if (configIA().iaLocal?.activa) marcar('iaLocal', 'error', 'La IA de la PC no respondió', e.cause?.code ?? e.message);
    const final = new Error(errorGemini ? `${errorGemini.message}; y la IA de la PC tampoco respondió` : e.message);
    final.errores = errores;
    final.limite = true;
    throw final;
  }
}
