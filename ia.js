// IA: varias IAs gratis en la nube, cada una con su propio cupo (Gemini y Groq), y la IA de tu PC
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
    modelos: () => [configIA().ia?.mistral ?? 'mistral-small-latest'],
    maxImagenes: 8,
    imagen: (i) => ({ type: 'image_url', image_url: `data:${i.mime};base64,${i.base64}` }),
  },
  groq: {
    nombre: 'Groq',
    clave: () => process.env.GROQ_API_KEY,
    url: 'https://api.groq.com/openai/v1/chat/completions',
    // Groq da un cupo diario POR MODELO: lo que no lleva imágenes (chat, notas, textos) se va a modelos
    // de solo texto, y así el modelo que ve imágenes guarda su cupo para revisar la pantalla.
    modelos: (conImagenes) => {
      const vision = configIA().ia?.groq ?? 'qwen/qwen3.8-27b';
      if (conImagenes) return [vision];
      return [...new Set([...(configIA().ia?.groqTexto ?? ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']), vision])];
    },
    extra: (modelo) => (/gpt-oss/.test(modelo) ? { reasoning_effort: 'low' } : {}),
    maxImagenes: 1, // cada imagen le cuenta mucho a su límite por minuto: mandamos solo la más reciente
    imagen: (i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.base64}` } }),
  },
};
const configurado = (p) => {
  const k = PROVEEDORES[p]?.clave();
  return Boolean(k && !k.startsWith('pega_aqui'));
};
const pausados = new Map(); // proveedor → hasta cuándo no usarlo

const pausaModelo = new Map(); // "proveedor/modelo" → hasta cuándo no usarlo

async function compatible(p, { sistema, texto, imagenes }) {
  const prov = PROVEEDORES[p];
  const imgs = imagenes.slice(-prov.maxImagenes);
  const modelos = prov.modelos(imgs.length > 0);
  const libres = modelos.filter((m) => !((pausaModelo.get(`${p}/${m}`) ?? 0) > Date.now()));
  if (!libres.length) {
    const e = new Error(`${prov.nombre}: todos sus modelos están descansando (límite)`);
    e.status = 429; e.todos = true;
    throw e;
  }
  let ultimo;
  for (const modelo of libres) {
    let res;
    try {
      res = await fetch(prov.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prov.clave()}` },
        body: JSON.stringify({
          model: modelo,
          temperature: 0.8,
          max_tokens: 1500,
          ...(prov.extra?.(modelo) ?? {}),
          messages: [
            { role: 'system', content: sistema },
            { role: 'user', content: imgs.length ? [...imgs.map(prov.imagen), { type: 'text', text: texto }] : texto },
          ],
        }),
        signal: AbortSignal.timeout(imgs.length ? 20_000 : 12_000),
      });
    } catch (e) {
      ultimo = e;
      if (e.name === 'TimeoutError') { ultimo = new Error(`${prov.nombre} (${modelo}) tardó demasiado`); continue; }
      throw e;
    }
    if (!res.ok) {
      const detalle = (await res.text()).slice(0, 300);
      const e = new Error(`${prov.nombre} (${modelo}) respondió ${res.status}: ${detalle}`);
      e.status = res.status;
      // Límite del día: ese modelo descansa 30 min. Por minuto: 1 min. Modelo que ya no existe: 1 día.
      const minutos = res.status === 429 && /too large/i.test(detalle) ? 0
        : res.status === 429 && /per day|\(TPD\)|\(RPD\)|daily/i.test(detalle) ? 30
          : res.status === 429 ? 1
            : res.status === 404 || /model_not_found|decommissioned|does not exist/i.test(detalle) ? 24 * 60
              : res.status === 400 && modelos.length > 1 ? 60 : 0; // ese modelo no acepta algo de la petición: probamos otro
      if (minutos) pausaModelo.set(`${p}/${modelo}`, Date.now() + minutos * 60_000);
      ultimo = e;
      if (minutos || res.status >= 500) { avisos(`IA: ${e.message.slice(0, 120)}; pruebo otro modelo…`); continue; }
      throw e;
    }
    const d = await res.json();
    const t = d.choices?.[0]?.message?.content;
    const texto2 = Array.isArray(t) ? t.map((x) => x.text ?? '').join('') : String(t ?? '');
    const limpio = texto2.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\s+/g, ' ').trim();
    if (!limpio) { ultimo = new Error(`${prov.nombre} (${modelo}) respondió vacío`); continue; }
    return { texto: limpio, modelo };
  }
  throw ultimo ?? new Error(`${prov.nombre} no respondió`);
}

export const iasConfiguradas = () => ['gemini', ...Object.keys(PROVEEDORES).filter(configurado)];

// uso: 'chat' (contestar en vivo: primero la más rápida) o 'fondo' (clips, notas, categoría: primero la de más cupo).
export async function preguntarIA({ sistema, texto, imagenes = [], buscar = false, uso = 'fondo', solo = null }) {
  const errores = [];
  const orden = solo ? [solo] : uso === 'chat' ? ['gemini', 'groq', 'mistral'] : ['groq', 'mistral', 'gemini'];
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
    // Muchas imágenes (por ejemplo, revisar lo grabado de una pelea): solo a la IA que las aguanta.
    if (imagenes.length > 5 && imagenes.length > PROVEEDORES[p].maxImagenes) continue;
    try {
      const r = await compatible(p, { sistema, texto, imagenes });
      marcar('ia', 'ok', `Funcionando (${PROVEEDORES[p].nombre})`);
      return r.texto;
    } catch (e) {
      errores.push(e.name === 'TimeoutError' ? `${PROVEEDORES[p].nombre} tardó demasiado` : e.message);
      // Si se trabó todo el proveedor (no un modelo en particular), descansa un poco.
      if (!e.todos && !(e.status === 429 || e.status === 404)) pausados.set(p, Date.now() + 2 * 60_000);
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
