// Posts de promoción: "entro en vivo en 15 min" (según tu horario), "ya estoy en vivo" al empezar y un resumen al terminar.
import { preguntarIA } from './ia.js';
import { agregar, nuevoId, lista, actualizar } from './bandeja.js';
import { horarioFijo, textoHoras, tocaAviso } from './horario.js';
import { ajustes, guardarAjustes } from './ajustes.js';
import { log } from './estado.js';

// Recorta un texto sin dejar palabras a medias: en la última frase completa, o si no en la última palabra.
export function recortar(texto, max) {
  const t = String(texto ?? '').trim();
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const finFrase = Math.max(corte.lastIndexOf('. '), corte.lastIndexOf('! '), corte.lastIndexOf('? '), corte.lastIndexOf('.\n'));
  if (finFrase > max * 0.5) return corte.slice(0, finFrase + 1).trim();
  return corte.slice(0, corte.lastIndexOf(' ')).replace(/[,;:]$/, '').trim() + '…';
}

export const urlX = (texto) => `https://x.com/intent/post?text=${encodeURIComponent(texto)}`;

export function crearPromos({ datos, avisar, urlApp, urlTwitch, publicarX = async () => false, publicarFacebook = async () => false, leerConfig = () => ({}) }) {
  async function escribir(instruccion, respaldo) {
    const d = datos.actual();
    try {
      const r = await preguntarIA({
        sistema: `Eres ${d.nombre}, streamer mexicano que juega en PS5, escribiendo tus propios posts para X. Espanol mexicano natural, con gancho, sin exagerar ni mentir. Maximo 220 caracteres (cuentalos: es un limite estricto). Sin comillas.`,
        texto: `Juego: ${d.juego}. Titulo del directo: ${d.titulo || '(sin titulo)'}.\n${instruccion}\nResponde solo con el texto del post.`,
      });
      return recortar(r.replace(/^["']|["']$/g, ''), 250) || respaldo;
    } catch {
      return respaldo;
    }
  }

  // ---------- aviso antes del directo ----------
  // Los días de tu horario, 15 min antes de la hora: post en X y en tu Página de Facebook con el juego y la hora.
  // No avisa si ya estás en vivo, si ya se avisó hoy (aunque el Centro se reinicie) o si llevas más de 7 días sin
  // transmitir (vacaciones: que no se anuncie un directo que no va a haber). TikTok y la comunidad de YouTube
  // no permiten publicar texto desde programas, por eso el aviso va solo a X y Facebook.
  let avisando = false;
  async function avisoPrevio(ahora = new Date()) {
    const config = leerConfig();
    const hoy = tocaAviso(config, ahora);
    if (!hoy || avisando || ajustes().avisoPrevio === hoy || datos.actual().enVivo) return false;
    const ultimo = datos.ultimoInicio?.();
    if (!ultimo || ahora.getTime() - new Date(ultimo).getTime() > 7 * 24 * 3600_000) return false;
    avisando = true;
    try {
      guardarAjustes({ avisoPrevio: hoy }); // primero se marca: nunca sale dos veces
      const h = horarioFijo(config);
      const d = datos.actual();
      const cuando = textoHoras(h);
      const texto = await escribir(
        `Escribe un post avisando que HOY entras en vivo ${cuando} (falta poco) jugando ${d.juego}, en Twitch, YouTube y Kick. Invita a llegar desde el inicio con una razon concreta del juego. No incluyas links (se agregan solos).`,
        `Hoy en vivo ${cuando} con ${d.juego} 🎮 ¡Caile desde el inicio!`,
      );
      const link = urlTwitch();
      const donde = [];
      if (await publicarX(`${texto}\n${link}`).catch((e) => { log('Aviso previo en X: ' + e.message, { nivel: 'aviso' }); return false; })) donde.push('X');
      if (await publicarFacebook(texto, link).catch((e) => { log('Aviso previo en Facebook: ' + e.message, { nivel: 'aviso' }); return false; })) donde.push('Facebook');
      agregar({ id: nuevoId(), tipo: 'post', titulo: 'Aviso: hoy entro en vivo', textoX: `${texto}\n${link}`, ...(donde.includes('X') ? { publicado: { x: true } } : {}) });
      if (donde.length) {
        log(`📣 Avisé en ${donde.join(' y ')} que hoy entras ${cuando}`);
        avisar(`📣 Avisé en ${donde.join(' y ')} que hoy entras ${cuando}`, texto, { etiquetas: ['loudspeaker'], clave: 'aviso-previo-' + hoy });
      } else {
        avisar('📣 Aviso de hoy listo para X', `${texto}\n${link}`, {
          etiquetas: ['loudspeaker'], acciones: [{ texto: 'Publicar en X', url: urlX(`${texto}\n${link}`) }], clave: 'aviso-previo-' + hoy,
        });
      }
      return true;
    } finally { avisando = false; }
  }
  setInterval(() => { avisoPrevio().catch((e) => log('Aviso previo: ' + e.message, { nivel: 'aviso' })); }, 60_000);

  return {
    avisoPrevio,
    async alEmpezar() {
      const d = datos.actual();
      const texto = await escribir('Escribe un post anunciando que estas EN VIVO ahora mismo. No incluyas links (se agregan solos).', `¡Ya estoy en vivo jugando ${d.juego}! Caile 🎮`);
      const final = `${texto}\n${urlTwitch()}`;
      const item = agregar({ id: nuevoId(), tipo: 'post', titulo: 'Anuncio: estoy en vivo', textoX: final });
      // Con X conectado en Buffer, el anuncio sale solo.
      if (await publicarX(final).catch(() => false)) {
        actualizar(item.id, { publicado: { x: true } });
        avisar('📣 Publiqué en X que estás en vivo', final, { etiquetas: ['loudspeaker'], clave: 'anuncio-vivo', cadaMinutos: 60 });
        return;
      }
      avisar('📣 Anuncio listo para X', final, {
        etiquetas: ['loudspeaker'],
        acciones: [{ texto: 'Publicar en X', url: urlX(final) }, { texto: 'Ver en la app', url: `${urlApp()}#publicar` }],
        clave: 'anuncio-vivo', cadaMinutos: 60,
      });
    },
    async alTerminar({ minutos }) {
      const d = datos.actual();
      const desde = Date.now() - minutos * 60_000;
      const clips = lista().filter((i) => i.tipo === 'clip' && new Date(i.creado).getTime() > desde);
      const texto = await escribir(
        `Escribe un post de agradecimiento y resumen del directo que acaba de terminar (${minutos} minutos). Momentos destacados: ${clips.map((c) => c.titulo).join('; ') || 'ninguno registrado'}. Invita al proximo directo (${d.horario}).`,
        `¡Gracias a todos por el directo de hoy de ${d.juego}! Nos vemos en el próximo 🎮`,
      );
      const item = agregar({ id: nuevoId(), tipo: 'post', titulo: 'Resumen del directo', textoX: texto });
      if (await publicarX(texto).catch(() => false)) {
        actualizar(item.id, { publicado: { x: true } });
        avisar('📝 Publiqué en X el resumen del directo', texto, { etiquetas: ['memo'], clave: 'resumen', cadaMinutos: 30 });
        return;
      }
      avisar('📝 Resumen del directo listo', texto, {
        etiquetas: ['memo'],
        acciones: [{ texto: 'Publicar en X', url: urlX(texto) }, { texto: 'Ver en la app', url: `${urlApp()}#publicar` }],
        clave: 'resumen', cadaMinutos: 30,
      });
    },
  };
}
