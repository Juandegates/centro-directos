// Datos del canal que el bot junta solo: juego y título (de Twitch), tu horario
// (aprendido de tus directos) y notas de tu partida (aprendidas viendo la pantalla).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { preguntarIA } from './ia.js';
import * as twitch from './twitch.js';

const ARCHIVO = new URL('./memoria.json', import.meta.url);
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ORDEN_DIAS = [1, 2, 3, 4, 5, 6, 0];

function cargar() {
  const base = { inicios: [], juegos: {} };
  if (!existsSync(ARCHIVO)) return base;
  try { return { ...base, ...JSON.parse(readFileSync(ARCHIVO, 'utf8')) }; } catch { return base; }
}

function horaBonita(h) {
  const sufijo = h < 12 ? 'am' : 'pm';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${sufijo}`;
}

// De una lista de fechas de inicio saca algo como "normalmente lunes y jueves, como a las 9 pm".
export function describirHorario(fechas) {
  const unicas = [...new Set(fechas)].map((f) => new Date(f)).filter((d) => !isNaN(d));
  if (unicas.length < 2) return 'todavía sin horario fijo';
  const porDia = new Map();
  const porHora = new Map();
  for (const d of unicas) {
    porDia.set(d.getDay(), (porDia.get(d.getDay()) ?? 0) + 1);
    porHora.set(d.getHours(), (porHora.get(d.getHours()) ?? 0) + 1);
  }
  const minimo = Math.max(1, Math.ceil(unicas.length * 0.15));
  const dias = ORDEN_DIAS.filter((d) => (porDia.get(d) ?? 0) >= minimo).map((d) => DIAS.at(d));
  const hora = [...porHora.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const listaDias = dias.length >= 6 ? 'casi diario' : dias.length > 1
    ? `${dias.slice(0, -1).join(', ')} y ${dias.at(-1)}` : dias[0];
  return `normalmente ${listaDias}, como a las ${horaBonita(hora)}`;
}

export function crearDatos({ canal, log, verPantalla, leerConfig }) {
  const memoria = cargar();
  const guardar = () => writeFileSync(ARCHIVO, JSON.stringify(memoria, null, 2));
  const estado = { juego: '', titulo: '', enVivo: false, horario: 'todavía sin horario fijo' };
  let fuentesHorario = [];
  let ultimaNota = 0;

  async function refrescarCanal() {
    try {
      const [info, vivo] = await Promise.all([twitch.infoCanal(canal.id), twitch.estaEnVivo(canal.id)]);
      if (info.game_name && info.game_name !== estado.juego) log(`🎮 Juego detectado en Twitch: ${info.game_name}`);
      estado.juego = info.game_name ?? '';
      estado.titulo = info.title ?? '';
      if (vivo && !estado.enVivo) {
        memoria.inicios = [...memoria.inicios, new Date().toISOString()].slice(-60);
        guardar();
        actualizarHorario();
      }
      estado.enVivo = vivo;
    } catch (e) {
      log('⚠️ No pude leer los datos del canal: ' + e.message);
    }
  }

  async function refrescarFuentesHorario() {
    const [publicado, pasados] = await Promise.all([twitch.horarioPublicado(canal.id), twitch.directosPasados(canal.id)]);
    fuentesHorario = publicado.length ? publicado : pasados;
    actualizarHorario();
  }

  function actualizarHorario() {
    estado.horario = describirHorario([...fuentesHorario, ...memoria.inicios]);
  }

  // Cada 5 min en vivo: mira la pantalla y actualiza las notas de tu partida en este juego.
  async function aprenderDelJuego() {
    if (!estado.enVivo || !estado.juego || Date.now() - ultimaNota < 5 * 60_000) return;
    if (leerConfig().pantalla?.activa === false) return;
    const imagenes = verPantalla();
    if (!imagenes.length) return;
    ultimaNota = Date.now();
    const previas = memoria.juegos[estado.juego]?.notas ?? '(ninguna)';
    try {
      const notas = await preguntarIA({
        sistema: 'Eres un asistente que toma notas breves de una partida de videojuego a partir de capturas del directo.',
        imagenes,
        texto:
          `Juego: ${estado.juego}.\nNotas actuales de mi partida:\n${previas}\n\n` +
          'Con estas imagenes recientes, actualiza las notas: personaje, zona o mapa, modo de juego, progreso, equipo o armas, y cualquier dato util para platicar con el chat. ' +
          'Maximo 6 lineas cortas. Conserva lo anterior que siga siendo cierto. Solo hechos que se vean o que ya estaban en las notas; no inventes. Responde solo con las notas.',
      });
      if (notas) {
        memoria.juegos[estado.juego] = { notas: notas.slice(0, 800), actualizado: new Date().toISOString() };
        guardar();
        log(`📝 Notas de ${estado.juego} actualizadas.`);
      }
    } catch (e) {
      log('⚠️ No pude actualizar las notas del juego: ' + e.message);
    }
  }

  refrescarCanal();
  refrescarFuentesHorario().catch(() => {});
  setInterval(refrescarCanal, 60_000);
  setInterval(() => refrescarFuentesHorario().catch(() => {}), 6 * 60 * 60_000);
  setInterval(aprenderDelJuego, 30_000);

  return {
    actual: () => ({
      nombre: canal.display_name,
      juego: estado.juego || 'sin juego definido',
      titulo: estado.titulo,
      horario: estado.horario,
      enVivo: estado.enVivo,
      notasJuego: memoria.juegos[estado.juego]?.notas ?? '',
    }),
  };
}
