// Cerebro del bot: lee el chat por tandas y contesta como si fueras tú.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { preguntarIA } from './ia.js';

const ARCHIVO_CONOCIDOS = new URL('./conocidos.json', import.meta.url);
const NADA = '(nada)';

export const leerConfig = () => JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

function instrucciones(config) {
  const d = config.datosDelCanal ?? {};
  return [
    'Eres el streamer escribiendo en su propio chat de Twitch mientras juega en vivo en la PS5. Escribes SIEMPRE en primera persona, como si fueras el, nunca digas que eres un bot o una IA.',
    `Quien soy y como hablo: ${config.comoSoy}`,
    `Datos del canal: juego de hoy: ${d.juegoDeHoy}. Horario: ${d.horario}. Otros: ${d.otros}.`,
    `Notas del juego (lo que llevo, mi personaje, etc.): ${d.notasDelJuego ?? '(ninguna)'}`,
    'Reglas:',
    '- Mensajes cortos de chat: 1 a 3 frases, maximo 350 caracteres, en espanol mexicano natural.',
    '- Menciona con @usuario a quien le contestas. Puedes contestar a varios en un mismo mensaje.',
    '- Haz preguntas al chat para sacar platica (sobre el juego, sus gustos, de donde son).',
    '- Saluda con ganas a quien escribe por primera vez en el canal; a quien vuelve, salúdalo como a un conocido.',
    '- No inventes datos: si no sabes algo (o un dato dice [pon aqui...]), sale por la tangente con humor sin dar el dato.',
    '- Pantalla: a veces recibes imagenes de mi directo de los ultimos segundos (la ultima es la mas reciente). Si alguien pregunta o comenta algo de lo que pasa en el juego, miralas y contesta segun lo que se ve, como si lo estuvieras jugando. Si no recibes imagenes o no se alcanza a ver, contesta de forma general sin inventar detalles.',
    '- No narres la pantalla si nadie pregunta; usala solo cuando venga al caso.',
    '- Nunca prometas regalos, sorteos, dinero ni encuentros. Nada de temas polemicos, politica ni groserias fuertes.',
    '- Nunca menciones ni invites a otras plataformas de streaming (YouTube, TikTok, Kick u otras).',
    '- Si alguien es grosero o hace spam, ignoralo.',
    '- No repitas frases de tus mensajes anteriores.',
    `- Si nada de lo nuevo necesita respuesta (solo emotes, "jaja", spam), responde exactamente: ${NADA}`,
  ].join('\n');
}

export function crearBot({ enviar, estaEnVivo, log, verPantalla = () => [] }) {
  const conocidos = new Set(existsSync(ARCHIVO_CONOCIDOS) ? JSON.parse(readFileSync(ARCHIVO_CONOCIDOS, 'utf8')) : []);
  const vistosHoy = new Set();
  const historial = []; // últimas líneas del chat, incluidas las tuyas
  let pendientes = [];  // mensajes nuevos que la IA aún no ha leído
  let ultimoMensajeChat = Date.now();
  let ultimoAnimo = 0;
  let pausadoHasta = 0;
  let ocupado = false;
  const enviados = new Set(); // lo que el bot mandó, para no duplicarlo cuando regresa por el chat

  const recordar = (linea) => {
    historial.push(linea);
    if (historial.length > 25) historial.shift();
  };

  const guardarConocidos = () => writeFileSync(ARCHIVO_CONOCIDOS, JSON.stringify([...conocidos]));

  async function hablar(texto, sistema) {
    if (Date.now() < pausadoHasta) return;
    try {
      const imagenes = verPantalla();
      if (imagenes.length) texto += `\n\n(Te adjunto ${imagenes.length} imagenes de mi directo de los ultimos segundos.)`;
      let r = await preguntarIA({ sistema, texto, imagenes });
      if (!r || r.includes(NADA)) return;
      r = r.slice(0, 450);
      const config = leerConfig();
      const final = (config.prefijo ?? '') + r;
      enviados.add(final);
      await enviar(final);
      recordar(`YO: ${r}`);
      log(`🗨️  Yo (bot): ${r}`);
    } catch (e) {
      if (e.limite) pausadoHasta = Date.now() + 60_000;
      log('⚠️ ' + e.message);
    }
  }

  // Lee los mensajes acumulados y contesta todo junto, como hace un streamer.
  async function leerTanda() {
    if (ocupado || !pendientes.length) return;
    ocupado = true;
    const tanda = pendientes;
    pendientes = [];
    const config = leerConfig();
    const texto =
      `Chat reciente (contexto):\n${historial.filter((l) => !tanda.some((t) => t.plano === l)).join('\n') || '(vacio)'}\n\n` +
      `Mensajes NUEVOS que debes contestar:\n${tanda.map((t) => t.linea).join('\n')}\n\n` +
      'Escribe UN solo mensaje para el chat.';
    await hablar(texto, instrucciones(config));
    ocupado = false;
  }

  // Si el chat está callado, manda algo para sacar plática.
  async function animar() {
    const config = leerConfig();
    const a = config.animarChat ?? {};
    if (!a.activo || ocupado) return;
    const espera = (a.minutosSinMensajes ?? 5) * 60_000;
    if (Date.now() - ultimoMensajeChat < espera || Date.now() - ultimoAnimo < espera) return;
    if (a.soloEnVivo && !(await estaEnVivo().catch(() => false))) return;
    ocupado = true;
    ultimoAnimo = Date.now();
    log('El chat está callado; mando algo para sacar plática…');
    await hablar(
      `Chat reciente:\n${historial.join('\n') || '(vacio)'}\n\nEl chat lleva un rato callado. ` +
        'Escribe UN mensaje para animar la platica: una pregunta al chat, un comentario de lo que esta pasando en el juego (si tienes imagenes) o una dinamica sencilla (por ejemplo, que voten algo). No pidas follows en cada mensaje.',
      instrucciones(config),
    );
    ocupado = false;
  }

  setInterval(leerTanda, (leerConfig().segundosParaLeerChat ?? 6) * 1000);
  setInterval(animar, 30_000);

  return {
    // Llamar con cada mensaje que llega al chat.
    async recibir({ usuarioId, nombre, texto, esMio }) {
      ultimoMensajeChat = Date.now();
      if (esMio) {
        // Tus mensajes (y los del bot, que salen con tu cuenta) solo quedan como contexto.
        if (enviados.has(texto)) enviados.delete(texto);
        else recordar(`YO: ${texto}`);
        return;
      }
      const config = leerConfig();
      const comando = config.comandos?.[texto.trim().split(/\s+/)[0].toLowerCase()];
      if (comando) {
        await enviar((config.prefijo ?? '') + comando).catch((e) => log('⚠️ ' + e.message));
        log(`🗨️  Comando ${texto.trim().split(/\s+/)[0]} → ${comando}`);
        return;
      }

      let marca = '';
      if (config.saludarNuevos && !conocidos.has(usuarioId)) {
        marca = ' [PRIMERA VEZ EN EL CANAL]';
        conocidos.add(usuarioId);
        guardarConocidos();
      } else if (!vistosHoy.has(usuarioId)) {
        marca = ' [PRIMER MENSAJE DE HOY, ya es conocido]';
      }
      vistosHoy.add(usuarioId);

      const linea = `@${nombre}${marca}: ${texto}`;
      recordar(`@${nombre}: ${texto}`);
      pendientes.push({ linea, plano: `@${nombre}: ${texto}` });
    },
  };
}
