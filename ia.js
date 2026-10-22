// IA: primero Gemini (gratis, en la nube); si está saturado o en su límite, la IA de tu PC (Ollama).
import { marcar } from './estado.js';

const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const PREFERIDOS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const ESPERA_MAXIMA_MS = 25_000;

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

async function gemini({ sistema, texto, imagenes }) {
  const clave = process.env.GEMINI_API_KEY;
  if (!clave) throw new Error('Falta GEMINI_API_KEY en claves.txt');
  const disponibles = await modelosDisponibles(clave);
  const modelos = [...new Set([process.env.GEMINI_MODELO, ...PREFERIDOS, ...disponibles].filter(Boolean))].slice(0, 6);

  const cuerpo = JSON.stringify({
    systemInstruction: { parts: [{ text: sistema }] },
    contents: [{
      role: 'user',
      parts: [
        ...imagenes.map((i) => ({ inline_data: { mime_type: i.mime, data: i.base64 } })),
        { text: texto },
      ],
    }],
    generationConfig: { temperature: 0.9, maxOutputTokens: 1024 },
  });

  let todosEnLimite = true;
  let ultimoError = '';

  for (const modelo of modelos) {
    let res;
    try {
      res = await fetch(`${URL_BASE}/${modelo}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave },
        body: cuerpo,
        signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
      });
    } catch (e) {
      todosEnLimite = false;
      ultimoError = e.name === 'TimeoutError' ? `${modelo} tardó demasiado` : `${modelo}: ${e.cause?.code ?? e.message}`;
      avisos(`IA: ${ultimoError}; pruebo otro modelo…`);
      continue;
    }

    if (res.ok) {
      const datos = await res.json();
      const partes = datos.candidates?.[0]?.content?.parts ?? [];
      marcar('ia', 'ok', `Funcionando (${modelo})`);
      return partes.filter((p) => !p.thought).map((p) => p.text ?? '').join('').replace(/\s+/g, ' ').trim();
    }

    const detalle = (await res.text()).slice(0, 300);
    if (res.status !== 429) todosEnLimite = false;
    if ([429, 500, 503, 504, 404].includes(res.status)) {
      ultimoError = `${modelo} respondió ${res.status}`;
      avisos(`IA: ${ultimoError}; pruebo otro modelo…`);
      continue;
    }
    marcar('ia', 'error', `Gemini respondió ${res.status}`, detalle);
    throw new Error(`La IA respondió ${res.status}: ${detalle}`);
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

export async function preguntarIA({ sistema, texto, imagenes = [] }) {
  let errorGemini = null;
  if (Date.now() >= geminiPausadoHasta) {
    try {
      return await gemini({ sistema, texto, imagenes });
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
