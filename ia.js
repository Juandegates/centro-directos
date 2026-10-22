// Conexión con la IA (Gemini, plan gratuito).
// Si un modelo está saturado (503), tarda demasiado o llegó a su límite, prueba con el siguiente.

const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RESPALDOS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const ESPERA_MAXIMA_MS = 25_000;

let avisos = () => {};
export const alAvisoIA = (fn) => { avisos = fn; };

export async function preguntarIA({ sistema, texto, imagenes = [] }) {
  const clave = process.env.GEMINI_API_KEY;
  if (!clave) throw new Error('Falta GEMINI_API_KEY en claves.txt');
  const modelos = [...new Set([process.env.GEMINI_MODELO, ...RESPALDOS].filter(Boolean))];

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
      return partes.filter((p) => !p.thought).map((p) => p.text ?? '').join('').replace(/\s+/g, ' ').trim();
    }

    const detalle = (await res.text()).slice(0, 200);
    if (res.status !== 429) todosEnLimite = false;
    if ([429, 500, 503, 504, 404].includes(res.status)) {
      ultimoError = `${modelo} respondió ${res.status}`;
      avisos(`IA: ${ultimoError}; pruebo otro modelo…`);
      continue;
    }
    throw new Error(`La IA respondió ${res.status}: ${detalle}`);
  }

  const e = new Error(todosEnLimite
    ? 'La IA llegó a su límite gratuito por ahora; pausa de 1 minuto.'
    : `Ningún modelo de IA respondió (${ultimoError}); pausa de 1 minuto.`);
  e.limite = true;
  throw e;
}
