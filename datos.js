// Datos del canal que el Centro junta solo: juego y título (de Twitch), si estás en vivo,
// tu horario (aprendido de tus directos), notas de tu partida y revisión de la categoría.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { preguntarIA } from './ia.js';
import { marcar, log } from './estado.js';
import * as twitch from './twitch.js';

const ARCHIVO = new URL('./memoria.json', import.meta.url);
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ORDEN_DIAS = [1, 2, 3, 4, 5, 6, 0];

function cargar() {
  const base = { inicios: [], juegos: {}, directos: [] };
  if (!existsSync(ARCHIVO)) return base;
  try { return { ...base, ...JSON.parse(readFileSync(ARCHIVO, 'utf8')) }; } catch { return base; }
}

const horaBonita = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'am' : 'pm'}`;
const normal = (t) => (t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

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
  const listaDias = dias.length >= 6 ? 'casi diario' : dias.length > 1 ? `${dias.slice(0, -1).join(', ')} y ${dias.at(-1)}` : dias[0];
  return `normalmente ${listaDias}, como a las ${horaBonita(hora)}`;
}

export function crearDatos({ canal, verPantalla, leerConfig, alCambioVivo, alCambioTitulo, avisar, urlApp }) {
  const memoria = cargar();
  const guardar = () => writeFileSync(ARCHIVO, JSON.stringify(memoria, null, 2));
  const estado = { juego: '', juegoId: '', titulo: '', enVivo: false, inicio: null, espectadores: 0, horario: 'todavía sin horario fijo', sugerencia: null };
  let fuentesHorario = [];
  let vodsTwitch = [];
  let ultimaNota = 0;
  let ultimaRevision = 0;
  let sospechas = 0;

  async function refrescar() {
    try {
      const [info, directo] = await Promise.all([twitch.infoCanal(canal.id), twitch.directoActual(canal.id)]);
      if (info.game_name && info.game_name !== estado.juego) {
        log(`🎮 Juego en Twitch: ${info.game_name}`);
        estado.sugerencia = null;
        sospechas = 0;
      }
      const tituloAntes = estado.titulo;
      Object.assign(estado, { juego: info.game_name ?? '', juegoId: info.game_id ?? '', titulo: info.title ?? '' });
      if (tituloAntes && tituloAntes !== estado.titulo) alCambioTitulo?.(estado.titulo);
      estado.espectadores = directo?.viewer_count ?? 0;
      estado.inicio = directo?.started_at ?? null;
      ponerVivo(Boolean(directo));
      marcar('internet', 'ok', 'Conectado');
    } catch (e) {
      const sinRed = e.cause?.code || e.name === 'TimeoutError' || /fetch failed/i.test(e.message);
      marcar(sinRed ? 'internet' : 'twitch', sinRed ? 'error' : 'aviso', sinRed ? 'La PC no tiene internet o Twitch no responde' : 'No pude leer tu canal de Twitch', e.message);
    }
  }

  // Lo llaman tanto el sondeo (cada 60 s) como el aviso instantáneo de Twitch.
  function ponerVivo(vivo) {
    if (vivo === estado.enVivo) return;
    estado.enVivo = vivo;
    if (vivo) {
      memoria.inicios = [...memoria.inicios, new Date().toISOString()].slice(-60);
      memoria.directos = [...memoria.directos, { inicio: new Date().toISOString(), juego: estado.juego, titulo: estado.titulo }].slice(-30);
      guardar();
      actualizarHorario();
    } else {
      const ultimo = memoria.directos.at(-1);
      if (ultimo && !ultimo.minutos) {
        Object.assign(ultimo, { juego: estado.juego || ultimo.juego, titulo: estado.titulo || ultimo.titulo, minutos: Math.round((Date.now() - new Date(ultimo.inicio)) / 60_000) });
        guardar();
      }
    }
    alCambioVivo?.(vivo);
  }

  async function refrescarFuentesHorario() {
    const [publicado, pasados] = await Promise.all([twitch.horarioPublicado(canal.id), twitch.directosPasados(canal.id)]);
    vodsTwitch = pasados;
    fuentesHorario = publicado.length ? publicado : pasados.map((v) => v.fecha);
    actualizarHorario();
  }
  const actualizarHorario = () => { estado.horario = describirHorario([...fuentesHorario, ...memoria.inicios]); };

  // Cada 5 min en vivo: mira la pantalla y actualiza las notas de tu partida.
  async function aprenderDelJuego() {
    if (!estado.enVivo || !estado.juego || Date.now() - ultimaNota < 5 * 60_000) return;
    const imagenes = verPantalla();
    if (!imagenes.length) return;
    ultimaNota = Date.now();
    const previas = memoria.juegos[estado.juego]?.notas ?? '(ninguna)';
    try {
      const notas = await preguntarIA({
        sistema: 'Tomas notas breves de una partida de videojuego a partir de capturas del directo.',
        imagenes,
        texto: `Juego: ${estado.juego}.\nNotas actuales:\n${previas}\n\nCon estas imagenes, actualiza las notas: personaje, zona o mapa, modo, progreso, equipo o armas y datos utiles para platicar con el chat. Maximo 6 lineas. Conserva lo que siga siendo cierto. Solo hechos que se vean; no inventes. Responde solo con las notas.`,
      });
      if (notas) {
        memoria.juegos[estado.juego] = { notas: notas.slice(0, 800), actualizado: new Date().toISOString() };
        guardar();
        log(`📝 Notas de ${estado.juego} actualizadas`);
      }
    } catch { /* la IA ya dejó registro */ }
  }

  // Cada 10 min en vivo: ¿lo que se ve en pantalla coincide con la categoría de Twitch?
  async function revisarCategoria() {
    if (!estado.enVivo || leerConfig().revisarCategoria === false || Date.now() - ultimaRevision < 10 * 60_000) return;
    const imagenes = verPantalla();
    if (!imagenes.length) return;
    ultimaRevision = Date.now();
    try {
      const r = await preguntarIA({
        sistema: 'Identificas videojuegos a partir de capturas de pantalla. Respondes solo con el nombre oficial del juego en ingles tal como aparece en Twitch, o exactamente NO_SE si no estas seguro.',
        imagenes,
        texto: `La categoria actual en Twitch es: "${estado.juego || 'ninguna'}". ¿Que juego se ve en estas imagenes?`,
      });
      const visto = r.replace(/["'.]/g, '').trim();
      if (!visto || /NO_SE/i.test(visto) || normal(visto).includes(normal(estado.juego)) || normal(estado.juego).includes(normal(visto))) {
        sospechas = 0;
        return;
      }
      sospechas++;
      if (sospechas >= 2) {
        estado.sugerencia = visto;
        avisar('🎮 ¿Categoría equivocada?', `Parece que juegas ${visto}, pero Twitch dice "${estado.juego || 'sin categoría'}". Toca para corregirlo.`, {
          etiquetas: ['video_game'], abrir: `${urlApp()}#corregir`, clave: 'categoria-' + visto, cadaMinutos: 30,
        });
      }
    } catch { /* sin IA disponible: se reintenta luego */ }
  }

  // Lista corta de tus directos anteriores para que el bot pueda platicar de ellos.
  function resumenDirectos() {
    const fecha = (f) => new Date(f).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    const propios = memoria.directos.filter((x) => x.minutos || !estado.enVivo).slice(-6).reverse()
      .map((x) => `${fecha(x.inicio)}: ${x.juego || 'juego desconocido'}${x.titulo ? ` ("${x.titulo}")` : ''}${x.minutos ? `, ${x.minutos} min` : ''}`);
    if (propios.length >= 3) return propios.join('; ');
    const deTwitch = vodsTwitch.slice(0, 6 - propios.length).map((v) => `${fecha(v.fecha)}: "${v.titulo}"${v.duracion ? `, duró ${v.duracion}` : ''}`);
    return [...propios, ...deTwitch].join('; ');
  }

  refrescar();
  refrescarFuentesHorario().catch(() => {});
  setInterval(refrescar, 60_000);
  setInterval(() => refrescarFuentesHorario().catch(() => {}), 6 * 3600_000);
  setInterval(() => { aprenderDelJuego(); revisarCategoria(); }, 30_000);

  return {
    refrescar,
    ponerVivo,
    descartarSugerencia: () => { estado.sugerencia = null; sospechas = 0; },
    actual: () => ({
      nombre: canal.display_name,
      juego: estado.juego || 'sin juego definido',
      juegoId: estado.juegoId,
      titulo: estado.titulo,
      horario: estado.horario,
      enVivo: estado.enVivo,
      inicio: estado.inicio,
      espectadores: estado.espectadores,
      sugerencia: estado.sugerencia,
      notasJuego: memoria.juegos[estado.juego]?.notas ?? '',
      directosPasados: resumenDirectos(),
    }),
  };
}
