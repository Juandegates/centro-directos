// ¿El internet de la PC está saturado? Junta las fallas de red (descarga de Twitch, envíos a YouTube y Kick,
// revisión de internet). Varias fallas en el mismo medio minuto cuentan como un solo "episodio";
// 3 episodios en 5 minutos = saturado, y avisa a quien esté escuchando (el modo ahorro).
const VENTANA = 30_000;
const PLAZO = 5 * 60_000;
const NECESARIOS = 3;

let episodios = [];
let ultimo = 0;
const oyentes = [];

export function golpe(origen = '') {
  const ahora = Date.now();
  ultimo = ahora;
  episodios = episodios.filter((t) => ahora - t < PLAZO);
  const actual = episodios[episodios.length - 1];
  if (actual && ahora - actual < VENTANA) return;
  episodios.push(ahora);
  if (episodios.length >= NECESARIOS) {
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
