// Tu horario fijo de directos (el que tú dices, no el que el Centro adivina).
// Se usa en: la descripción de cada video ("📅 En vivo de lunes a viernes…"), el aviso de 15 min antes,
// el comando !horario del bot y la descripción del directo de YouTube.
// Se cambia en config.json → "horarioDirectos": { "dias": [1,2,3,4,5], "desde": "09:00", "hasta": "10:00", "avisoMinutos": 15 }
//   dias: 0 = domingo, 1 = lunes … 6 = sábado.  "avisoMinutos": 0 apaga el aviso.  "horarioDirectos": false apaga todo.
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const ORDEN = [1, 2, 3, 4, 5, 6, 0];
const PREDETERMINADO = { dias: [1, 2, 3, 4, 5], desde: '09:00', hasta: '10:00', avisoMinutos: 15 };

export function horarioFijo(config = {}) {
  if (config.horarioDirectos === false) return null;
  const h = { ...PREDETERMINADO, ...(config.horarioDirectos ?? {}) };
  const dias = [...new Set((Array.isArray(h.dias) ? h.dias : []).map(Number).filter((d) => d >= 0 && d <= 6))];
  if (!dias.length || !/^\d{1,2}:\d{2}$/.test(String(h.desde))) return null;
  return { ...h, dias, hasta: /^\d{1,2}:\d{2}$/.test(String(h.hasta)) ? h.hasta : null, avisoMinutos: Math.max(0, Number(h.avisoMinutos) || 0) };
}

const partes = (hhmm) => String(hhmm).split(':').map(Number);
const sufijo = (h) => (h < 12 ? 'am' : 'pm');
const hora = (hhmm) => { const [h, m] = partes(hhmm); return `${h % 12 === 0 ? 12 : h % 12}${m ? ':' + String(m).padStart(2, '0') : ''}`; };

// [1,2,3,4,5] → "de lunes a viernes";  [1,3,5] → "lunes, miércoles y viernes";  todos → "todos los días"
export function textoDias(dias) {
  const orden = ORDEN.filter((d) => dias.includes(d));
  if (orden.length === 7) return 'todos los días';
  const pos = orden.map((d) => ORDEN.indexOf(d));
  const seguidos = orden.length >= 3 && pos.every((p, i) => i === 0 || p === pos[i - 1] + 1);
  if (seguidos) return `de ${DIAS[orden[0]]} a ${DIAS[orden.at(-1)]}`;
  return orden.length > 1 ? `${orden.slice(0, -1).map((d) => DIAS[d]).join(', ')} y ${DIAS[orden.at(-1)]}` : DIAS[orden[0]];
}

// "09:00"–"10:00" → "entre 9 y 10 am";  solo "desde" → "a las 9 am"
export function textoHoras(h) {
  const [a] = partes(h.desde);
  if (!h.hasta || h.hasta === h.desde) return `a las ${hora(h.desde)} ${sufijo(a)}`;
  const [b] = partes(h.hasta);
  return sufijo(a) === sufijo(b) ? `entre ${hora(h.desde)} y ${hora(h.hasta)} ${sufijo(b)}` : `entre ${hora(h.desde)} ${sufijo(a)} y ${hora(h.hasta)} ${sufijo(b)}`;
}

// "de lunes a viernes, entre 9 y 10 am (hora del centro de México)"
export function describirFijo(h) {
  return h ? `${textoDias(h.dias)}, ${textoHoras(h)} (hora del centro de México)` : '';
}

// Línea para el final de la descripción de los videos.
export const MARCA_LINEA = '📅 En vivo';
export function lineaHorario(config = {}) {
  const h = horarioFijo(config);
  return h ? `${MARCA_LINEA} ${describirFijo(h)}` : '';
}

// Agrega la línea del horario a una descripción (una sola vez; si ya venía, se reemplaza por la actual).
export function conHorario(texto, config = {}) {
  const linea = lineaHorario(config);
  const limpio = String(texto ?? '').split('\n').filter((l) => !l.trim().startsWith(MARCA_LINEA)).join('\n').trim();
  return linea ? `${limpio}\n${linea}`.trim() : limpio;
}

// ¿Ahora toca el aviso de "entro en vivo en 15 min"? Devuelve la fecha de hoy (AAAA-MM-DD) si sí, o null.
// Ventana: desde 15 min antes de "desde" hasta "desde" (si el Centro se reinició justo a esa hora, aún avisa).
export function tocaAviso(config = {}, ahora = new Date()) {
  const h = horarioFijo(config);
  if (!h || !h.avisoMinutos || !h.dias.includes(ahora.getDay())) return null;
  const [hh, mm] = partes(h.desde);
  const inicio = new Date(ahora);
  inicio.setHours(hh, mm, 0, 0);
  const t = ahora.getTime();
  if (t < inicio.getTime() - h.avisoMinutos * 60_000 || t > inicio.getTime()) return null;
  return `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
}
