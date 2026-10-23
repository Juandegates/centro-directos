// Calendario de publicaciones: reparte tus clips en la semana (uno al día, los mejores primero)
// y te avisa al celular cuando toca publicar cada uno.
import { lista, actualizar } from './bandeja.js';
import { urlX } from './promos.js';
import { log } from './estado.js';

const DIA_MS = 24 * 3600_000;
const publicado = (i) => Boolean(i.publicado?.tiktok || i.publicado?.youtube);

// "18:30" → la próxima fecha a esa hora en o después de `desde`.
function aLaHora(fecha, hora) {
  const [h, m] = String(hora ?? '18:00').split(':').map(Number);
  const d = new Date(fecha);
  d.setHours(Number.isFinite(h) ? h : 18, Number.isFinite(m) ? m : 0, 0, 0);
  return d;
}

export function crearCalendario({ leerConfig, avisar, urlApp, enVivo = () => false }) {
  const cfg = () => ({ hora: '18:00', porDia: 1, ...(leerConfig().publicar ?? {}) });

  // Pone fecha a los clips que todavía no la tienen. Los clips se borran a los 7 días, así que
  // solo se programan dentro de esa ventana; los que no caben quedan como "extra".
  function programar() {
    const { hora, porDia } = cfg();
    const clips = lista().filter((i) => i.tipo === 'clip');
    const ocupados = new Map(); // día → cuántos
    for (const i of clips) {
      if (i.programado && !publicado(i)) {
        const k = new Date(i.programado).toDateString();
        ocupados.set(k, (ocupados.get(k) ?? 0) + 1);
      }
    }
    const sinFecha = clips.filter((i) => !i.programado && !publicado(i) && !i.extra)
      .sort((a, b) => (b.puntos ?? 5) - (a.puntos ?? 5) || new Date(a.creado) - new Date(b.creado));
    let nuevos = 0;
    for (const item of sinFecha) {
      const vence = new Date(item.creado).getTime() + 6.5 * DIA_MS;
      let dia = aLaHora(Date.now(), hora);
      if (dia.getTime() < Date.now() + 10 * 60_000) dia = new Date(dia.getTime() + DIA_MS);
      while ((ocupados.get(dia.toDateString()) ?? 0) >= porDia && dia.getTime() < vence) dia = new Date(dia.getTime() + DIA_MS);
      if (dia.getTime() >= vence) { actualizar(item.id, { extra: true }); continue; }
      ocupados.set(dia.toDateString(), (ocupados.get(dia.toDateString()) ?? 0) + 1);
      actualizar(item.id, { programado: dia.toISOString() });
      nuevos++;
    }
    if (nuevos) log(`📅 Programé ${nuevos} clip(s) para publicar en los próximos días`);
    return nuevos;
  }

  // Cada minuto: ¿ya toca publicar algún clip?
  async function revisar() {
    for (const i of lista()) {
      if (i.tipo !== 'clip' || !i.programado || i.avisado || publicado(i)) continue;
      if (new Date(i.programado).getTime() > Date.now()) continue;
      if (enVivo()) continue; // no te distraemos en pleno directo; avisa al terminar
      const ok = await avisar('🎬 Hoy toca publicar este clip', `${i.titulo}\nDescárgalo y súbelo a TikTok y Shorts (el texto ya está listo).`, {
        etiquetas: ['clapper'],
        abrir: `${urlApp()}#clips/${i.id}`,
        acciones: [{ texto: 'Abrir clip', url: `${urlApp()}#clips/${i.id}` }, ...(i.textoX ? [{ texto: 'Publicar en X', url: urlX(i.textoX) }] : [])],
        clave: 'toca-' + i.id,
      });
      if (ok) actualizar(i.id, { avisado: new Date().toISOString() });
    }
  }

  setInterval(() => { revisar().catch(() => {}); }, 60_000);
  setInterval(() => { if (!enVivo()) programar(); }, 30 * 60_000);

  return {
    programar,
    revisar,
    // Lo que viene: clips con fecha, de la más próxima a la más lejana.
    proximos: () => lista().filter((i) => i.tipo === 'clip' && i.programado && !publicado(i))
      .sort((a, b) => new Date(a.programado) - new Date(b.programado))
      .map((i) => ({ id: i.id, titulo: i.titulo, programado: i.programado, puntos: i.puntos ?? null, avisado: Boolean(i.avisado) })),
  };
}
