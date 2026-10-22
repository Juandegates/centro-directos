// Cerebro del bot: lee el chat por tandas y contesta como si fueras tú. Una copia por plataforma.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { preguntarIA } from './ia.js';
import { log } from './estado.js';
import { registrar } from './chat.js';
import { ajustes } from './ajustes.js';

const ARCHIVO_CONOCIDOS = new URL('./conocidos.json', import.meta.url);
const NADA = '(nada)';
const NOMBRES = { twitch: 'Twitch', youtube: 'YouTube' };

export const leerConfig = () => JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

// Personas que ya han escrito alguna vez (compartido entre plataformas).
const conocidos = new Set((existsSync(ARCHIVO_CONOCIDOS) ? JSON.parse(readFileSync(ARCHIVO_CONOCIDOS, 'utf8')) : [])
  .map((id) => (String(id).includes(':') ? id : `twitch:${id}`))); // la v1 guardaba solo ids de Twitch
const guardarConocidos = () => writeFileSync(ARCHIVO_CONOCIDOS, JSON.stringify([...conocidos]));

function instrucciones(config, d, plataforma) {
  const comoSoy = (config.comoSoy ?? '').replaceAll('{nombre}', d.nombre);
  return [
    `Eres el streamer escribiendo en su propio chat de ${NOMBRES[plataforma]} mientras juega en vivo en la PS5. Escribes SIEMPRE en primera persona, como si fueras el, nunca digas que eres un bot o una IA.`,
    `Quien soy y como hablo: ${comoSoy}`,
    `Mi canal: ${d.nombre}. ${d.enVivo ? 'Estoy EN VIVO ahora.' : 'Ahorita NO estoy en vivo.'}`,
    `Juego actual: ${d.juego}. Titulo del directo: ${d.titulo || '(sin titulo)'}.`,
    `Mi horario: ${d.horario}.`,
    `Notas de mi partida en este juego: ${d.notasJuego || '(todavia ninguna)'}`,
    config.extras ? `Otros datos que debo saber: ${config.extras}` : '',
    'Usa tu conocimiento general del juego actual para platicar (mecanicas, personajes, tips), pero no inventes cosas de mi partida.',
    'Reglas:',
    `- Mensajes cortos de chat: 1 a 3 frases, maximo ${plataforma === 'youtube' ? 190 : 350} caracteres, en espanol mexicano natural.`,
    '- Menciona con @usuario a quien le contestas. Puedes contestar a varios en un mismo mensaje.',
    '- Haz preguntas al chat para sacar platica (sobre el juego, sus gustos, de donde son).',
    '- Saluda con ganas a quien escribe por primera vez en el canal; a quien vuelve, saludalo como a un conocido.',
    '- No inventes datos: si no sabes algo, sale por la tangente con humor sin dar el dato.',
    '- Pantalla: a veces recibes imagenes de mi directo de los ultimos segundos (la ultima es la mas reciente). Si alguien pregunta o comenta algo de lo que pasa en el juego, miralas y contesta segun lo que se ve, como si lo estuvieras jugando. Si no recibes imagenes o no se alcanza a ver, contesta de forma general sin inventar detalles.',
    '- No narres la pantalla si nadie pregunta; usala solo cuando venga al caso.',
    '- Nunca prometas regalos, sorteos, dinero ni encuentros. Nada de temas polemicos, politica ni groserias fuertes.',
    '- Nunca menciones ni invites a otras plataformas de streaming (YouTube, TikTok, Kick, Twitch u otras): cada chat es solo de su plataforma.',
    '- Si alguien es grosero o hace spam, ignoralo.',
    '- No repitas frases de tus mensajes anteriores.',
    `- Si nada de lo nuevo necesita respuesta (solo emotes, "jaja", spam), responde exactamente: ${NADA}`,
  ].filter(Boolean).join('\n');
}

export function crearBot({ plataforma, enviar, verPantalla = () => [], datos, animarChat = false }) {
  const rellenar = (t) => {
    const d = datos.actual();
    return t.replaceAll('{juego}', d.juego).replaceAll('{horario}', d.horario)
      .replaceAll('{titulo}', d.titulo).replaceAll('{nombre}', d.nombre);
  };
  const pausado = () => Boolean(ajustes().botPausado?.[plataforma]);
  let vistosHoy = new Set();
  const historial = [];
  let pendientes = [];
  let ultimoMensajeChat = Date.now();
  let ultimoAnimo = 0;
  let ocupado = false;
  const enviados = new Set(); // lo que mandó el bot, para reconocerlo cuando regresa por el chat

  const recordar = (linea) => {
    historial.push(linea);
    if (historial.length > 25) historial.shift();
  };

  async function decir(texto) {
    const final = (leerConfig().prefijo ?? '') + texto;
    enviados.add(final);
    await enviar(final);
    recordar(`YO: ${texto}`);
    registrar({ plataforma, nombre: 'Bot', texto: final, tipo: 'bot' });
    log(`🗨️  Bot (${NOMBRES[plataforma]}): ${final}`);
  }

  async function hablar(texto, sistema) {
    try {
      const imagenes = verPantalla();
      if (imagenes.length) texto += `\n\n(Te adjunto ${imagenes.length} imagenes de mi directo de los ultimos segundos.)`;
      const r = await preguntarIA({ sistema, texto, imagenes });
      if (!r || r.includes(NADA) || pausado()) return;
      await decir(r.slice(0, plataforma === 'youtube' ? 200 : 450));
    } catch (e) {
      log(`⚠️ Bot (${NOMBRES[plataforma]}): ${e.message}`, { nivel: 'aviso' });
    }
  }

  async function leerTanda() {
    if (ocupado || !pendientes.length) return;
    if (pausado()) { pendientes = []; return; }
    ocupado = true;
    const tanda = pendientes;
    pendientes = [];
    const texto =
      `Chat reciente (contexto):\n${historial.filter((l) => !tanda.some((t) => t.plano === l)).join('\n') || '(vacio)'}\n\n` +
      `Mensajes NUEVOS que debes contestar:\n${tanda.map((t) => t.linea).join('\n')}\n\n` +
      'Escribe UN solo mensaje para el chat.';
    await hablar(texto, instrucciones(leerConfig(), datos.actual(), plataforma));
    ocupado = false;
  }

  async function animar() {
    const config = leerConfig();
    const a = config.animarChat ?? {};
    if (!animarChat || !a.activo || ocupado || pausado()) return;
    const espera = (a.minutosSinMensajes ?? 5) * 60_000;
    if (Date.now() - ultimoMensajeChat < espera || Date.now() - ultimoAnimo < espera) return;
    if (a.soloEnVivo && !datos.actual().enVivo) return;
    ocupado = true;
    ultimoAnimo = Date.now();
    log('El chat está callado; mando algo para sacar plática…');
    await hablar(
      `Chat reciente:\n${historial.join('\n') || '(vacio)'}\n\nEl chat lleva un rato callado. ` +
        'Escribe UN mensaje para animar la platica: una pregunta al chat, un comentario de lo que esta pasando en el juego (si tienes imagenes) o una dinamica sencilla (por ejemplo, que voten algo). No pidas follows en cada mensaje.',
      instrucciones(config, datos.actual(), plataforma),
    );
    ocupado = false;
  }

  setInterval(leerTanda, (leerConfig().segundosParaLeerChat ?? 6) * 1000);
  setInterval(animar, 30_000);

  return {
    nuevoDirecto() { vistosHoy = new Set(); },
    // Llamar con cada mensaje que llega al chat de esta plataforma.
    async recibir({ usuarioId, nombre, texto, esMio }) {
      ultimoMensajeChat = Date.now();
      if (esMio) {
        if (enviados.has(texto)) { enviados.delete(texto); return; } // eco del bot
        recordar(`YO: ${texto}`);
        registrar({ plataforma, nombre, texto, tipo: 'yo' });
        return;
      }
      registrar({ plataforma, nombre, texto, tipo: 'gente' });
      const config = leerConfig();
      const palabra = texto.trim().split(/\s+/)[0].toLowerCase();
      const comando = config.comandos?.[palabra];
      if (comando) {
        if (!pausado()) await decir(rellenar(comando)).catch((e) => log('⚠️ ' + e.message, { nivel: 'aviso' }));
        return;
      }
      if (palabra.startsWith('!')) return; // otros comandos (como !clip) no los contesta la IA

      const id = `${plataforma}:${usuarioId}`;
      let marca = '';
      if (config.saludarNuevos && !conocidos.has(id)) {
        marca = ' [PRIMERA VEZ EN EL CANAL]';
        conocidos.add(id);
        guardarConocidos();
      } else if (!vistosHoy.has(id)) {
        marca = ' [PRIMER MENSAJE DE HOY, ya es conocido]';
      }
      vistosHoy.add(id);

      recordar(`@${nombre}: ${texto}`);
      pendientes.push({ linea: `@${nombre}${marca}: ${texto}`, plano: `@${nombre}: ${texto}` });
    },
  };
}
