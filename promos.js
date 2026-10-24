// Posts de promoción: "ya estoy en vivo" al empezar y un resumen al terminar.
import { preguntarIA } from './ia.js';
import { agregar, nuevoId, lista } from './bandeja.js';

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

export function crearPromos({ datos, avisar, urlApp, urlTwitch }) {
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

  return {
    async alEmpezar() {
      const d = datos.actual();
      const texto = await escribir('Escribe un post anunciando que estas EN VIVO ahora mismo. No incluyas links (se agregan solos).', `¡Ya estoy en vivo jugando ${d.juego}! Caile 🎮`);
      const final = `${texto}\n${urlTwitch()}`;
      agregar({ id: nuevoId(), tipo: 'post', titulo: 'Anuncio: estoy en vivo', textoX: final });
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
      agregar({ id: nuevoId(), tipo: 'post', titulo: 'Resumen del directo', textoX: texto });
      avisar('📝 Resumen del directo listo', texto, {
        etiquetas: ['memo'],
        acciones: [{ texto: 'Publicar en X', url: urlX(texto) }, { texto: 'Ver en la app', url: `${urlApp()}#publicar` }],
        clave: 'resumen', cadaMinutos: 30,
      });
    },
  };
}
