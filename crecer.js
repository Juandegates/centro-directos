// Crecer: estadísticas de tus directos, metas (Afiliado y TikTok), radar de competencia,
// raids sugeridos, título y etiquetas para la búsqueda de Twitch y el reporte semanal.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as twitch from './twitch.js';
import { preguntarIA } from './ia.js';
import { lista as listaBandeja } from './bandeja.js';
import { log } from './estado.js';

const ARCHIVO = new URL('./estadisticas.json', import.meta.url);
const DIA_MS = 24 * 3600_000;

// Requisitos de Afiliado (Twitch los bajó en junio de 2026). Se pueden cambiar en config.json → crecer.afiliado.
const AFILIADO = { seguidores: 25, horas: 4, dias: 4, promedio: 3 };

function cargar() {
  const base = { directos: [], seguidores: [], tiktok: [] };
  if (!existsSync(ARCHIVO)) return base;
  try { return { ...base, ...JSON.parse(readFileSync(ARCHIVO, 'utf8')) }; } catch { return base; }
}

const promedio = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const redondear = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// Capítulos para la descripción de YouTube (YouTube pide: el primero en 0:00, al menos 3, y 10 s entre cada uno).
export function capitulos(inicio, momentos) {
  const t0 = new Date(inicio).getTime();
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
  };
  const lista = [{ ms: 0, que: 'Inicio del directo' }];
  for (const m of [...momentos].sort((a, b) => a.hora - b.hora)) {
    const ms = m.hora - t0 - 30_000; // el momento empezó un poco antes de detectarlo
    if (ms > lista.at(-1).ms + 60_000 && m.que) lista.push({ ms, que: m.que.charAt(0).toUpperCase() + m.que.slice(1) });
  }
  return lista.length >= 3 ? lista.map((c) => `${fmt(c.ms)} ${c.que}`).join('\n') : '';
}

export function crearCrecer({ canal, datos, leerConfig, avisar, urlApp }) {
  const est = cargar();
  const guardar = () => writeFileSync(ARCHIVO, JSON.stringify(est, null, 2));
  let actual = null; // directo en curso
  let radar = null;
  let sugerencia = null; // { titulo, etiquetas }
  const cfg = () => ({ etiquetasAutomaticas: true, sugerirTitulo: true, reporteSemanal: true, horaReporte: '20:00', ...(leerConfig().crecer ?? {}) });

  async function anotarSeguidores() {
    try {
      const total = await twitch.seguidores(canal.id);
      const hoy = new Date().toISOString().slice(0, 10);
      const ultimo = est.seguidores.at(-1);
      if (ultimo?.fecha === hoy) ultimo.total = total;
      else est.seguidores.push({ fecha: hoy, total });
      est.seguidores = est.seguidores.slice(-400);
      guardar();
      return total;
    } catch { return est.seguidores.at(-1)?.total ?? null; }
  }

  // ---------- directo en curso ----------
  async function alEmpezar() {
    const d = datos.actual();
    actual = { inicio: new Date().toISOString(), juego: d.juego, titulo: d.titulo, muestras: [], seguidoresInicio: await anotarSeguidores() };
    radar = null;
    sugerencia = null;
    if (cfg().sugerirTitulo) sugerirTituloYEtiquetas().catch(() => {});
    setTimeout(() => revisarRadar().catch(() => {}), 3 * 60_000);
  }

  async function alTerminar() {
    if (!actual) return;
    const minutos = Math.round((Date.now() - new Date(actual.inicio)) / 60_000);
    const seguidoresFin = await anotarSeguidores();
    const clips = listaBandeja().filter((i) => i.tipo === 'clip' && new Date(i.creado) >= new Date(actual.inicio)).length;
    if (minutos >= 5) {
      est.directos.push({
        inicio: actual.inicio, minutos, juego: actual.juego,
        promedio: redondear(promedio(actual.muestras)), maximo: Math.max(0, ...actual.muestras),
        seguidoresInicio: actual.seguidoresInicio, seguidoresFin, clips,
        lugar: radar?.lugar ?? null, competencia: radar?.total ?? null,
      });
      est.directos = est.directos.slice(-200);
      guardar();
    }
    actual = null;
    sugerencia = null;
  }

  // Cada minuto en vivo: anotamos cuántos te están viendo.
  setInterval(() => {
    const d = datos.actual();
    if (actual && d.enVivo) actual.muestras.push(d.espectadores ?? 0);
  }, 60_000);

  // ---------- título y etiquetas ----------
  async function sugerirTituloYEtiquetas() {
    const d = datos.actual();
    const info = await twitch.infoCanal(canal.id).catch(() => ({}));
    const r = await preguntarIA({
      sistema: 'Eres experto en crecer canales pequenos de Twitch en espanol. Escribes titulos que la gente quiere abrir, sin mentir ni exagerar.',
      texto:
        `Canal: ${d.nombre}, streamer mexicano en PS5. Juego: ${d.juego}. Titulo actual: "${d.titulo || '(sin titulo)'}". Notas de la partida: ${d.notasJuego || '(ninguna)'}.\n` +
        'Devuelve SOLO un JSON: {"titulo": "max 100 caracteres, en espanol, que diga el juego y que se va a hacer hoy (jefe, zona, reto), con un emoji maximo", ' +
        '"etiquetas": ["8 a 10 etiquetas de Twitch SIN espacios ni simbolos, max 25 caracteres cada una: idioma (Español), pais (Mexico), plataforma (PS5), genero del juego, nombre corto del juego y estilo (Primerapartida, Relajado, Platicando)"]}',
    });
    const j = JSON.parse(r.slice(r.indexOf('{'), r.lastIndexOf('}') + 1));
    const etiquetas = twitch.limpiarEtiquetas([...(j.etiquetas ?? []), 'Español', 'PS5']);
    sugerencia = { titulo: String(j.titulo ?? '').slice(0, 140), etiquetas };
    // Las etiquetas casi nunca se ven, pero ayudan en la búsqueda: si no tienes ninguna, las ponemos solas.
    if (cfg().etiquetasAutomaticas && !(info.tags ?? []).length && etiquetas.length) {
      await twitch.cambiarCanal(canal.id, { etiquetas }).then(() => log(`🏷️ Puse etiquetas en tu canal: ${etiquetas.join(', ')}`)).catch((e) => log('No pude poner etiquetas: ' + e.message, { nivel: 'aviso' }));
    }
    if (sugerencia.titulo && sugerencia.titulo !== d.titulo) {
      avisar('✏️ Título sugerido para hoy', sugerencia.titulo, { etiquetas: ['pencil2'], abrir: `${urlApp()}#vivo`, clave: 'titulo-sugerido', cadaMinutos: 60 });
    }
    return sugerencia;
  }

  // ---------- radar: ¿en qué lugar del directorio estás? ----------
  async function revisarRadar() {
    const d = datos.actual();
    if (!d.enVivo || !d.juegoId) return null;
    const todos = await twitch.directosDelJuego(d.juegoId, { paginas: 5 });
    const enEspanol = todos.filter((s) => s.idioma === 'es');
    const lugar = todos.findIndex((s) => s.id === canal.id) + 1;
    const lugarEs = enEspanol.findIndex((s) => s.id === canal.id) + 1;
    radar = {
      hora: new Date().toISOString(), juego: d.juego, total: todos.length, lugar: lugar || null,
      totalEs: enEspanol.length, lugarEs: lugarEs || null, completo: todos.length < 500,
    };
    return radar;
  }
  setInterval(() => { if (datos.actual().enVivo) revisarRadar().catch(() => {}); }, 10 * 60_000);

  // ---------- raid sugerido: alguien en español, del mismo juego y de tu tamaño ----------
  async function sugerirRaid() {
    const d = datos.actual();
    if (!d.juegoId) throw new Error('Primero pon la categoría de tu directo');
    const mios = Math.max(1, d.espectadores ?? 0);
    const tope = Math.max(10, mios * 3);
    const candidatos = (await twitch.directosDelJuego(d.juegoId, { idioma: 'es', paginas: 3 }))
      .filter((s) => s.id !== canal.id && s.espectadores <= tope);
    if (!candidatos.length) return { canal: null, mensaje: `No encontré canales en español de tu tamaño jugando ${d.juego} ahorita.` };
    candidatos.sort((a, b) => Math.abs(a.espectadores - mios) - Math.abs(b.espectadores - mios));
    return { canal: candidatos[0], otros: candidatos.slice(1, 4) };
  }

  async function raidear(haciaId) {
    if (!twitch.tienePermiso('channel:manage:raids')) throw new Error('Falta el permiso de raids: en la PC abre http://localhost:3000/twitch y autoriza otra vez');
    await twitch.iniciarRaid(canal.id, haciaId);
    log('🚀 Raid en camino (Twitch cuenta 90 s)');
  }

  // ---------- metas ----------
  function metas() {
    const desde = Date.now() - 30 * DIA_MS;
    const ultimos = est.directos.filter((x) => new Date(x.inicio).getTime() > desde);
    const minutos = ultimos.reduce((a, x) => a + x.minutos, 0);
    const dias = new Set(ultimos.map((x) => new Date(x.inicio).toDateString())).size;
    const prom = minutos ? ultimos.reduce((a, x) => a + x.promedio * x.minutos, 0) / minutos : 0;
    const req = { ...AFILIADO, ...(cfg().afiliado ?? {}) };
    const seguidores = est.seguidores.at(-1)?.total ?? null;
    const tiktok = est.tiktok.at(-1)?.total ?? null;
    return {
      afiliado: [
        { nombre: 'Seguidores en Twitch', valor: seguidores, meta: req.seguidores },
        { nombre: 'Horas en vivo (30 días)', valor: redondear(minutos / 60), meta: req.horas },
        { nombre: 'Días con directo (30 días)', valor: dias, meta: req.dias },
        { nombre: 'Espectadores promedio', valor: redondear(prom), meta: req.promedio },
      ],
      tiktok: { valor: tiktok, meta: 1000, fecha: est.tiktok.at(-1)?.fecha ?? null },
      nota: 'Twitch decide la invitación a Afiliado; revisa tu panel de Twitch → Logros. El promedio de espectadores es el que mide el Centro.',
    };
  }

  function anotarTikTok(total) {
    const n = Math.round(Number(total));
    if (!Number.isFinite(n) || n < 0) throw new Error('Escribe un número');
    const hoy = new Date().toISOString().slice(0, 10);
    const ultimo = est.tiktok.at(-1);
    if (ultimo?.fecha === hoy) ultimo.total = n;
    else est.tiktok.push({ fecha: hoy, total: n });
    guardar();
    return metas();
  }

  // ---------- reporte semanal (para pegar en tu entrenador de Claude o ChatGPT) ----------
  function reporteSemanal() {
    const ahora = Date.now();
    const rango = (a, b) => est.directos.filter((x) => { const t = new Date(x.inicio).getTime(); return t > ahora - a * DIA_MS && t <= ahora - b * DIA_MS; });
    const resumen = (xs) => {
      const min = xs.reduce((a, x) => a + x.minutos, 0);
      return { directos: xs.length, horas: redondear(min / 60), promedio: redondear(min ? xs.reduce((a, x) => a + x.promedio * x.minutos, 0) / min : 0), maximo: Math.max(0, ...xs.map((x) => x.maximo)) };
    };
    const esta = rango(7, 0);
    const pasada = rango(14, 7);
    const a = resumen(esta);
    const b = resumen(pasada);
    const seg = (dias) => {
      const f = new Date(ahora - dias * DIA_MS).toISOString().slice(0, 10);
      return [...est.seguidores].reverse().find((x) => x.fecha <= f)?.total ?? null;
    };
    const segHoy = est.seguidores.at(-1)?.total ?? null;
    const seg7 = seg(7);
    const clips = listaBandeja().filter((i) => i.tipo === 'clip' && new Date(i.creado).getTime() > ahora - 7 * DIA_MS);
    const subidos = (p) => clips.filter((i) => i.publicado?.[p]).length;
    const tk = est.tiktok;
    const m = metas();
    const lineas = [
      'Eres mi entrenador para hacer crecer mi canal de Twitch (juego en PS5, en español, desde México). Con estos datos de mi semana dime: 1) qué funcionó, 2) qué cambiar la próxima semana (horario, juegos, títulos, tipo de clips) y 3) tres acciones concretas. Sé directo y realista.',
      '',
      `REPORTE SEMANAL · ${new Date().toLocaleDateString('es-MX', { dateStyle: 'long' })}`,
      `Directos: ${a.directos} (semana pasada ${b.directos}) · Horas: ${a.horas} (antes ${b.horas})`,
      `Espectadores promedio: ${a.promedio} (antes ${b.promedio}) · Máximo: ${a.maximo}`,
      `Seguidores en Twitch: ${segHoy ?? '?'}${segHoy != null && seg7 != null ? ` (${segHoy - seg7 >= 0 ? '+' : ''}${segHoy - seg7} esta semana)` : ''}`,
      `Seguidores en TikTok: ${tk.at(-1)?.total ?? 'sin anotar'}${tk.length > 1 ? ` (antes ${tk.at(-2).total})` : ''}`,
      `Clips hechos: ${clips.length} · Publicados en TikTok: ${subidos('tiktok')} · Shorts: ${subidos('youtube')} · X: ${subidos('x')}`,
      '',
      'Directos de la semana:',
      ...esta.map((x) => `- ${new Date(x.inicio).toLocaleString('es-MX', { weekday: 'long', hour: 'numeric', minute: '2-digit' })} · ${x.juego} · ${x.minutos} min · promedio ${x.promedio}, máximo ${x.maximo}${x.lugar ? ` · lugar ${x.lugar} de ${x.competencia} en el directorio` : ''}${x.seguidoresFin != null && x.seguidoresInicio != null ? ` · +${x.seguidoresFin - x.seguidoresInicio} seguidores` : ''}`),
      '',
      'Clips de la semana (calificación de 1 a 10):',
      ...clips.slice(0, 12).map((i) => `- ${i.titulo}${i.puntos ? ` (${i.puntos}/10)` : ''}${i.publicado?.tiktok || i.publicado?.youtube ? ' · publicado' : ' · sin publicar'}`),
      '',
      'Avance a Afiliado:',
      ...m.afiliado.map((x) => `- ${x.nombre}: ${x.valor ?? '?'} de ${x.meta}`),
    ];
    return lineas.join('\n');
  }

  // Domingo en la noche: aviso de que el reporte está listo.
  let ultimoReporte = '';
  setInterval(() => {
    const c = cfg();
    if (!c.reporteSemanal) return;
    const ahora = new Date();
    const [h, m] = c.horaReporte.split(':').map(Number);
    const clave = ahora.toDateString();
    if (ahora.getDay() === 0 && ahora.getHours() === h && ahora.getMinutes() >= (m || 0) && ultimoReporte !== clave) {
      ultimoReporte = clave;
      avisar('📊 Tu reporte semanal está listo', 'Ábrelo, cópialo y pégalo en tu entrenador de Claude o ChatGPT. De paso anota tus seguidores de TikTok.', {
        etiquetas: ['bar_chart'], abrir: `${urlApp()}#crecer`, clave: 'reporte-' + clave,
      });
    }
  }, 60_000);

  anotarSeguidores();
  setInterval(anotarSeguidores, 6 * 3600_000);

  return {
    alEmpezar, alTerminar, sugerirTituloYEtiquetas, revisarRadar, sugerirRaid, raidear, metas, anotarTikTok, reporteSemanal,
    estado: () => ({ radar, sugerencia }),
    descartarSugerencia: () => { sugerencia = null; },
  };
}
