// ¿El internet de la PC está saturado? Junta las fallas de red de todas las partes (descarga de Twitch,
// envíos a YouTube y Kick, revisión de internet). Las fallas del mismo medio minuto son un solo "episodio".
// Saturado = 3 episodios en 5 minutos Y fallas de al menos 2 partes distintas: si solo falla una
// (por ejemplo Kick con la clave mal), no es la red, es esa parte. Avisa a quien escuche (el modo ahorro).
const VENTANA = 30_000;
const PLAZO = 5 * 60_000;
const NECESARIOS = 3;

let episodios = []; // [{ t, origenes: Set }]
let ultimo = 0;
const oyentes = [];

// instantaneo: la parte se cayó nada más arrancar (menos de 15 s): eso es configuración, no red; no cuenta.
export function golpe(origen = '', { instantaneo = false } = {}) {
  if (instantaneo) return;
  const ahora = Date.now();
  ultimo = ahora;
  episodios = episodios.filter((e) => ahora - e.t < PLAZO);
  const actual = episodios[episodios.length - 1];
  if (actual && ahora - actual.t < VENTANA) { actual.origenes.add(origen); return; }
  episodios.push({ t: ahora, origenes: new Set([origen]) });
  const distintos = new Set(episodios.flatMap((e) => [...e.origenes]));
  if (episodios.length >= NECESARIOS && distintos.size >= 2) {
    episodios = [];
    for (const f of oyentes) { try { f(origen); } catch { /* que no tumbe al que avisó */ } }
  }
}

export const alSaturar = (f) => { oyentes.push(f); };
export const ultimoGolpe = () => ultimo;
export function reiniciar() { episodios = []; ultimo = 0; }

// Espera antes de reintentar algo que se cayó: cada vez más larga, para no comerse el internet reintentando.
const ESPERAS = [5, 15, 30, 60, 120, 300];
export const esperaReintento = (fallas) => ESPERAS[Math.min(Math.max(fallas, 1), ESPERAS.length) - 1];
