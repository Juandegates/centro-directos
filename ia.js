// Conexión con la IA (Gemini, plan gratuito).

const URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function preguntarIA({ personalidad, contexto, mensaje }) {
  const clave = process.env.GEMINI_API_KEY;
  const modelo = process.env.GEMINI_MODELO || 'gemini-flash-latest';
  if (!clave) throw new Error('Falta GEMINI_API_KEY en claves.txt');

  const texto = (contexto ? `Mensajes recientes del chat:\n${contexto}\n\n` : '') +
    `Responde a este mensaje:\n${mensaje}`;

  const res = await fetch(`${URL_BASE}/${modelo}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: personalidad }] },
      contents: [{ role: 'user', parts: [{ text: texto }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
    }),
  });

  if (res.status === 429) throw new Error('La IA llegó a su límite gratuito por ahora (429). Esperando…');
  if (!res.ok) throw new Error(`La IA respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const datos = await res.json();
  const partes = datos.candidates?.[0]?.content?.parts ?? [];
  const respuesta = partes.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  return respuesta.replace(/\s+/g, ' ').slice(0, 450);
}
