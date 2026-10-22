// Conexión con la IA (Gemini, plan gratuito).

const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function preguntarIA({ sistema, texto, imagenes = [] }) {
  const clave = process.env.GEMINI_API_KEY;
  const modelo = process.env.GEMINI_MODELO || 'gemini-flash-latest';
  if (!clave) throw new Error('Falta GEMINI_API_KEY en claves.txt');

  const res = await fetch(`${URL_BASE}/${modelo}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sistema }] },
      contents: [{
        role: 'user',
        parts: [
          ...imagenes.map((i) => ({ inline_data: { mime_type: i.mime, data: i.base64 } })),
          { text: texto },
        ],
      }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 1024 },
    }),
  });

  if (res.status === 429) {
    const e = new Error('La IA llegó a su límite gratuito por ahora; pausa de 1 minuto.');
    e.limite = true;
    throw e;
  }
  if (!res.ok) throw new Error(`La IA respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const datos = await res.json();
  const partes = datos.candidates?.[0]?.content?.parts ?? [];
  return partes.filter((p) => !p.thought).map((p) => p.text ?? '').join('').replace(/\s+/g, ' ').trim();
}
