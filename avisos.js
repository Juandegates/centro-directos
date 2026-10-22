// Avisos al celular con ntfy (gratis). Instala la app ntfy y suscríbete al tema que muestra la app del Centro.
import { ajustes } from './ajustes.js';
import { marcar, log } from './estado.js';

const recientes = new Map(); // evita mandar el mismo aviso muchas veces seguidas

// prioridad: 1 (mínima) a 5 (urgente). acciones: [{ texto, url }] (máx. 3)
export async function avisar(titulo, mensaje, { prioridad = 3, etiquetas = [], abrir = null, acciones = [], clave = null, cadaMinutos = 10 } = {}) {
  const id = clave ?? titulo + mensaje;
  const antes = recientes.get(id);
  if (antes && Date.now() - antes < cadaMinutos * 60_000) return true;
  recientes.set(id, Date.now());

  try {
    // Publicar en formato JSON: va a la raíz de ntfy.sh con el tema dentro (admite acentos y emojis).
    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: ajustes().temaAvisos,
        title: titulo,
        message: mensaje,
        priority: prioridad,
        tags: etiquetas,
        ...(abrir ? { click: abrir } : {}),
        ...(acciones.length ? { actions: acciones.slice(0, 3).map((a) => ({ action: 'view', label: a.texto, url: a.url, clear: true })) } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy respondió ${res.status}: ${(await res.text()).slice(0, 200)}`);
    marcar('avisos', 'ok', 'Funcionando');
    return true;
  } catch (e) {
    marcar('avisos', 'aviso', 'No pude mandar un aviso al celular', e.message);
    log(`(aviso no enviado) ${titulo}: ${mensaje}`);
    return false;
  }
}
