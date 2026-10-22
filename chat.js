// Registro del chat unificado (Twitch + YouTube) para la app del celular.
let siguiente = 1;
const mensajes = [];

// tipo: 'gente' | 'yo' (lo que escribiste tú) | 'bot'
export function registrar({ plataforma, nombre, texto, tipo = 'gente' }) {
  mensajes.push({ n: siguiente++, hora: new Date().toISOString(), plataforma, nombre, texto, tipo });
  if (mensajes.length > 400) mensajes.shift();
}

export const desde = (n = 0) => mensajes.filter((m) => m.n > n).slice(-200);
