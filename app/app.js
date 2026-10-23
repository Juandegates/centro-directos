// App del celular del Centro de Directos: monitoreo y toques puntuales.
'use strict';

const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TITULOS = { vivo: 'En vivo', chat: 'Chat', publicar: 'Publicar', crecer: 'Crecer', diagnostico: 'Diagnóstico' };
const NOMBRE_PLAT = { twitch: 'Twitch', youtube: 'YouTube' };

let estado = null;
let ultimoChat = 0;
let filtroChat = 'todas';
let categoriaElegida = null;
let editandoTitulo = false;

// ---------- utilidades ----------
async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, {
    ...opciones,
    headers: { 'Content-Type': 'application/json' },
    body: opciones.cuerpo ? JSON.stringify(opciones.cuerpo) : undefined,
    method: opciones.cuerpo ? 'POST' : opciones.method ?? 'GET',
  });
  if (res.status === 401) { mostrarPin(); throw new Error('Falta el PIN'); }
  const tipo = res.headers.get('Content-Type') ?? '';
  const datos = tipo.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(datos.error ?? 'Error ' + res.status);
  return datos;
}

let toastTimer;
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

// Copiar funciona también sin HTTPS (método antiguo como respaldo).
async function copiar(texto) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(texto); return true; }
  } catch { /* uso el respaldo */ }
  const area = document.createElement('textarea');
  area.value = texto;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, texto.length);
  const ok = document.execCommand('copy');
  area.remove();
  return ok;
}

const duracion = (iso) => {
  if (!iso) return '';
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  return `Al aire ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h`;
};

// ---------- PIN ----------
function mostrarPin() {
  $('#app').hidden = true;
  $('#pantalla-pin').hidden = false;
}
$('#form-pin').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/entrar', { cuerpo: { pin: $('#pin').value } });
    $('#pantalla-pin').hidden = true;
    $('#app').hidden = false;
    arrancar();
  } catch (err) {
    $('#pin-error').textContent = err.message;
  }
});

// ---------- navegación ----------
function irA() {
  const [vista, extra] = (location.hash.slice(1) || 'vivo').split('/');
  const nombre = vista === 'clips' ? 'publicar' : vista === 'corregir' ? 'vivo' : TITULOS[vista] ? vista : 'vivo';
  for (const v of Object.keys(TITULOS)) $('#' + v).hidden = v !== nombre;
  document.querySelectorAll('.navegacion a').forEach((a) => a.classList.toggle('activo', a.dataset.vista === nombre));
  $('#titulo-seccion').textContent = TITULOS[nombre];
  if (nombre === 'publicar') cargarBandeja(extra);
  if (nombre === 'diagnostico') cargarBitacora();
  if (nombre === 'crecer') cargarCrecer();
  if (vista === 'corregir' && estado?.directo?.sugerencia) {
    $('#campo-categoria').value = estado.directo.sugerencia;
    buscarCategorias();
    $('#campo-categoria').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (nombre === 'chat') setTimeout(() => window.scrollTo(0, document.body.scrollHeight), 50);
}
window.addEventListener('hashchange', irA);

// ---------- estado general ----------
function pintarInterruptor(el, encendido) { el.setAttribute('aria-checked', String(Boolean(encendido))); }

function pintarEstado() {
  const e = estado;
  const d = e.directo;
  const vivo = Boolean(d?.enVivo);
  const pastilla = $('#estado-vivo');
  pastilla.textContent = vivo ? 'En vivo' : 'Sin directo';
  pastilla.className = 'pastilla' + (vivo ? ' vivo' : '');

  const sesion = $('#aviso-sesion');
  sesion.hidden = e.sesion;
  if (!e.sesion) sesion.textContent = 'El Centro todavía no tiene sesión de Twitch. En la PC abre http://localhost:3000/twitch';

  $('#juego-actual').textContent = d ? d.juego : '—';
  $('#espectadores').textContent = vivo ? d.espectadores : '0';
  $('#tiempo-vivo').textContent = vivo ? duracion(d.inicio) : (d ? `Horario: ${d.horario}` : '');
  if (d && !editandoTitulo && document.activeElement !== $('#campo-titulo')) $('#campo-titulo').value = d.titulo ?? '';
  if (d && !categoriaElegida && document.activeElement !== $('#campo-categoria')) $('#campo-categoria').value = d.juego === 'sin juego definido' ? '' : d.juego;

  const sug = $('#sugerencia');
  sug.hidden = !d?.sugerencia;
  if (d?.sugerencia) {
    sug.innerHTML = `<span>🎮 Parece que juegas <strong>${esc(d.sugerencia)}</strong>, pero Twitch dice "${esc(d.juego)}".</span><button class="primario">Corregir categoría</button>`;
    sug.querySelector('button').onclick = () => { $('#campo-categoria').value = d.sugerencia; buscarCategorias(); $('#campo-categoria').focus(); };
  }

  const parte = Object.fromEntries(e.partes.map((p) => [p.id, p]));
  $('#twitch-estado').textContent = parte.chatTwitch?.mensaje ?? '—';
  const tp = $('#twitch-pastilla');
  tp.textContent = vivo ? 'En vivo' : 'Esperando';
  tp.className = 'pastilla chica' + (vivo ? ' ok' : '');
  const y = e.youtube;
  $('#youtube-estado').textContent = !y.configurado ? 'Falta configurar en la PC'
    : !y.sesion ? 'Falta autorizar en la PC'
      : !y.envio ? 'Envío apagado'
        : y.activo ? `${parte.envioYoutube?.mensaje ?? ''} · cuota ${y.cuota}/10000` : 'Arranca solo cuando sales en vivo';
  pintarInterruptor($('#interruptor-youtube'), y.envio);
  pintarInterruptor($('#bot-twitch'), !e.bot?.twitch);
  pintarInterruptor($('#bot-youtube'), !e.bot?.youtube);
  $('#hacer-clip').disabled = !vivo;

  // Diagnóstico
  const fallas = e.partes.filter((p) => p.estado === 'error').length;
  const cf = $('#contador-fallas');
  cf.hidden = !fallas;
  cf.textContent = fallas;
  $('#semaforos').innerHTML = e.partes.map((p) => `
    <div class="fila semaforo"><span class="luz ${p.estado}"></span><div class="crece">
      <strong>${esc(p.nombre)}</strong><div class="tenue">${esc(p.mensaje)}</div>
      ${p.ultimoError && p.estado !== 'ok' ? `<div class="detalle">${esc(p.ultimoError.detalle ?? '')}</div>` : ''}
    </div></div>`).join('');
  $('#tema-avisos').textContent = e.temaAvisos;
  $('#link-ntfy').href = `https://ntfy.sh/${e.temaAvisos}`;
  $('#version-texto').textContent = e.versionNueva ? `Tienes la ${e.version}. ¡Hay una versión nueva: ${e.versionNueva}!` : `Versión ${e.version}`;
  $('#actualizar').textContent = e.versionNueva ? `Actualizar a ${e.versionNueva}` : 'Buscar actualización';
}

async function refrescarEstado() {
  try {
    estado = await api('/api/estado');
    pintarEstado();
  } catch { /* sin conexión: se reintenta */ }
}

// ---------- título y categoría ----------
$('#campo-titulo').addEventListener('input', () => { editandoTitulo = true; });
let buscarTimer;
async function buscarCategorias() {
  const q = $('#campo-categoria').value.trim();
  const lista = $('#resultados-categoria');
  if (q.length < 2) { lista.innerHTML = ''; return; }
  try {
    const r = await api('/api/categorias?q=' + encodeURIComponent(q));
    lista.innerHTML = r.map((c, i) => `<li><button type="button" data-i="${i}"><img src="${esc(c.imagen.replace('{width}', '52').replace('{height}', '72'))}" alt="">${esc(c.nombre)}</button></li>`).join('');
    lista.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        categoriaElegida = r[b.dataset.i];
        $('#campo-categoria').value = categoriaElegida.nombre;
        lista.innerHTML = '';
      };
    });
  } catch (e) { toast(e.message); }
}
$('#campo-categoria').addEventListener('input', () => {
  categoriaElegida = null;
  clearTimeout(buscarTimer);
  buscarTimer = setTimeout(buscarCategorias, 350);
});
$('#guardar-canal').addEventListener('click', async () => {
  const titulo = $('#campo-titulo').value.trim();
  const btn = $('#guardar-canal');
  btn.disabled = true;
  $('#canal-mensaje').textContent = 'Guardando…';
  try {
    await api('/api/canal', { cuerpo: { titulo: titulo || undefined, categoriaId: categoriaElegida?.id } });
    editandoTitulo = false;
    categoriaElegida = null;
    $('#canal-mensaje').textContent = '✅ Guardado en Twitch' + (estado?.youtube.activo ? ' y YouTube' : '');
    refrescarEstado();
  } catch (e) {
    $('#canal-mensaje').textContent = '❌ ' + e.message;
  } finally { btn.disabled = false; }
});

// ---------- interruptores ----------
$('#interruptor-youtube').addEventListener('click', async (ev) => {
  const nuevo = ev.currentTarget.getAttribute('aria-checked') !== 'true';
  pintarInterruptor(ev.currentTarget, nuevo);
  try { await api('/api/youtube', { cuerpo: { envio: nuevo } }); toast(nuevo ? 'Envío a YouTube encendido' : 'Envío a YouTube apagado'); } catch (e) { toast(e.message); }
  refrescarEstado();
});
for (const p of ['twitch', 'youtube']) {
  $('#bot-' + p).addEventListener('click', async (ev) => {
    const activo = ev.currentTarget.getAttribute('aria-checked') !== 'true';
    pintarInterruptor(ev.currentTarget, activo);
    try { await api('/api/bot', { cuerpo: { plataforma: p, pausado: !activo } }); toast(`Bot de ${NOMBRE_PLAT[p]} ${activo ? 'activo' : 'en pausa'}`); } catch (e) { toast(e.message); }
    refrescarEstado();
  });
}
$('#hacer-clip').addEventListener('click', async () => {
  try { const r = await api('/api/clip', { cuerpo: {} }); $('#clip-mensaje').textContent = r.mensaje; } catch (e) { $('#clip-mensaje').textContent = '❌ ' + e.message; }
});

// ---------- chat ----------
function pintarMensaje(m) {
  const li = document.createElement('li');
  li.className = m.tipo;
  li.dataset.plataforma = m.plataforma;
  li.hidden = filtroChat !== 'todas' && filtroChat !== m.plataforma;
  const canal = estado?.canal ?? 'Tú';
  const nombre = m.tipo === 'bot' ? `${canal} · bot · ${NOMBRE_PLAT[m.plataforma]}` : m.tipo === 'yo' ? `${canal} · tú · ${NOMBRE_PLAT[m.plataforma]}` : m.nombre;
  li.innerHTML = `${m.tipo === 'bot' ? '' : `<span class="punto ${esc(m.plataforma)}"></span>`}<div><div class="nombre">${esc(nombre)}</div><div>${esc(m.texto)}</div></div>`;
  $('#mensajes').appendChild(li);
}
async function refrescarChat() {
  try {
    const nuevos = await api('/api/chat?desde=' + ultimoChat);
    if (!nuevos.length) return;
    const abajo = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    nuevos.forEach(pintarMensaje);
    ultimoChat = nuevos.at(-1).n;
    const lista = $('#mensajes');
    while (lista.children.length > 300) lista.firstChild.remove();
    if (abajo && !$('#chat').hidden) window.scrollTo(0, document.body.scrollHeight);
  } catch { /* se reintenta */ }
}
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  filtroChat = c.dataset.filtro;
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('activo', x === c));
  document.querySelectorAll('#mensajes li').forEach((li) => { li.hidden = filtroChat !== 'todas' && li.dataset.plataforma !== filtroChat; });
}));
$('#form-chat').addEventListener('submit', async (e) => {
  e.preventDefault();
  const texto = $('#texto-chat').value.trim();
  if (!texto) return;
  try {
    await api('/api/chat', { cuerpo: { plataforma: $('#destino').value, texto } });
    $('#texto-chat').value = '';
  } catch (err) { toast(err.message); }
});

// ---------- bandeja de publicaciones ----------
const urlX = (t) => `https://x.com/intent/post?text=${encodeURIComponent(t)}`;
async function cargarBandeja(enfocar) {
  let items;
  try { items = await api('/api/bandeja'); } catch { return; }
  const pendientes = items.filter((i) => !(i.publicado?.x || i.publicado?.tiktok || i.publicado?.youtube)).length;
  const cb = $('#contador-bandeja');
  cb.hidden = !pendientes;
  cb.textContent = pendientes;
  if (enfocar === undefined && $('#publicar').hidden) return;
  const cont = $('#bandeja');
  if (!items.length) { cont.innerHTML = '<p class="tenue centro">Todavía no hay nada. Los clips y anuncios aparecen solos durante tus directos.</p>'; return; }
  cont.innerHTML = items.map((i) => {
    const hecho = i.publicado?.x || i.publicado?.tiktok || i.publicado?.youtube;
    const fecha = new Date(i.creado).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
    if (i.tipo === 'clip') {
      return `<article class="item ${hecho ? 'hecho' : ''}" id="item-${esc(i.id)}">
        <div><strong>🎬 ${esc(i.titulo)}</strong><div class="tenue">${esc(fecha)} · ${esc(i.juego ?? '')} · ${esc(i.motivo ?? '')}${i.puntos ? ` · ${i.puntos}/10` : ''}</div>
          ${i.programado && !hecho ? `<div class="tenue">📅 Toca publicarlo: ${esc(fechaCorta(i.programado))}</div>` : ''}</div>
        <video controls playsinline preload="none" poster="/media/${esc(i.archivos.portada)}" src="/media/${esc(i.archivos.vertical)}"></video>
        <div class="tenue">Texto para TikTok / Shorts</div><div class="texto">${esc(i.textoTikTok)}</div>
        <div class="acciones">
          <a class="boton primario" href="/media/${esc(i.archivos.vertical)}" download="clip-${esc(i.id)}.mp4">⬇ Video vertical</a>
          <button data-copiar="${esc(i.textoTikTok)}">Copiar texto</button>
          <a class="boton" href="${esc(urlX(i.textoX))}" target="_blank" rel="noopener">Publicar en X</a>
          <a class="boton" href="/media/${esc(i.archivos.horizontal)}" download="clip-${esc(i.id)}-horizontal.mp4">⬇ Horizontal</a>
          ${i.twitch?.url ? `<a class="boton" href="${esc(i.twitch.url)}" target="_blank" rel="noopener">Clip en Twitch</a>` : ''}
          <button data-borrar="${esc(i.id)}">Borrar</button>
        </div>
        <div class="marcas">${['tiktok', 'youtube', 'x'].map((p) => `<label><input type="checkbox" data-marcar="${esc(i.id)}" data-plat="${p}" ${i.publicado?.[p] ? 'checked' : ''}>${{ tiktok: 'TikTok', youtube: 'Shorts', x: 'X' }[p]}</label>`).join('')}</div>
      </article>`;
    }
    return `<article class="item ${hecho ? 'hecho' : ''}" id="item-${esc(i.id)}">
      <div><strong>📣 ${esc(i.titulo)}</strong><div class="tenue">${esc(fecha)}</div></div>
      <div class="texto">${esc(i.textoX)}</div>
      <div class="acciones">
        <a class="boton primario" href="${esc(urlX(i.textoX))}" target="_blank" rel="noopener">Publicar en X</a>
        <button data-copiar="${esc(i.textoX)}">Copiar texto</button>
        <button data-borrar="${esc(i.id)}">Borrar</button>
      </div>
      <div class="marcas"><label><input type="checkbox" data-marcar="${esc(i.id)}" data-plat="x" ${i.publicado?.x ? 'checked' : ''}>Publicado en X</label></div>
    </article>`;
  }).join('');
  cont.querySelectorAll('[data-copiar]').forEach((b) => { b.onclick = async () => toast((await copiar(b.dataset.copiar)) ? 'Texto copiado' : 'No pude copiar; mantén presionado el texto'); });
  cont.querySelectorAll('[data-borrar]').forEach((b) => { b.onclick = async () => { await api('/api/bandeja/' + b.dataset.borrar, { cuerpo: { borrar: true } }); cargarBandeja(null); }; });
  cont.querySelectorAll('[data-marcar]').forEach((c) => { c.onchange = async () => { await api('/api/bandeja/' + c.dataset.marcar, { cuerpo: { publicado: { [c.dataset.plat]: c.checked } } }); cargarBandeja(null); }; });
  if (enfocar) document.getElementById('item-' + enfocar)?.scrollIntoView({ behavior: 'smooth' });
}

// ---------- crecer ----------
let crecer = null;
const fechaCorta = (iso) => new Date(iso).toLocaleString('es-MX', { weekday: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function pintarTituloSugerido() {
  const b = $('#titulo-sugerido');
  const s = crecer?.sugerencia;
  b.hidden = !s?.titulo || s.titulo === estado?.directo?.titulo;
  if (b.hidden) return;
  b.innerHTML = `<span>✏️ <strong>Título sugerido para la búsqueda de Twitch:</strong></span><div class="texto">${esc(s.titulo)}</div>
    ${s.etiquetas?.length ? `<div class="etiquetas">${s.etiquetas.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="fila botones"><button class="primario crece" data-accion="usar">Usar</button><button class="crece" data-accion="otro">Otro</button><button class="crece" data-accion="no">No</button></div>`;
  b.querySelectorAll('button').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const a = btn.dataset.accion;
        await api('/api/crecer/titulo', { cuerpo: a === 'usar' ? { usar: true } : a === 'otro' ? { nuevo: true } : { usar: false } });
        toast(a === 'usar' ? '✅ Título y etiquetas puestos' : a === 'otro' ? 'Va otro título…' : 'Listo, lo dejo como está');
        await cargarCrecer();
        refrescarEstado();
      } catch (e) { toast(e.message); btn.disabled = false; }
    };
  });
}

async function cargarCrecer() {
  try { crecer = await api('/api/crecer'); } catch { return; }
  if (crecer.sinSesion) return;
  pintarTituloSugerido();
  const m = crecer.metas;
  const perm = $('#crecer-permisos');
  perm.hidden = !crecer.permisosFaltantes?.length;
  perm.textContent = 'Para raidear desde aquí y agradecer a tus seguidores nuevos, en la PC abre http://localhost:3000/twitch y autoriza otra vez (una sola vez).';
  const barra = (valor, meta) => {
    const pct = valor == null ? 0 : Math.min(100, Math.round((valor / meta) * 100));
    return `<div class="barra ${pct >= 100 ? 'lista' : ''}"><span style="width:${pct}%"></span></div>`;
  };
  $('#metas-afiliado').innerHTML = m.afiliado.map((x) => `<div class="meta"><div class="fila"><span>${esc(x.nombre)}</span><strong>${x.valor ?? '—'} / ${x.meta}${x.valor >= x.meta ? ' ✅' : ''}</strong></div>${barra(x.valor, x.meta)}</div>`).join('') +
    `<p class="tenue">${esc(m.nota)}</p>`;
  $('#meta-tiktok').innerHTML = `<div class="meta"><div class="fila"><span>Seguidores para hacer LIVE</span><strong>${m.tiktok.valor ?? '—'} / ${m.tiktok.meta}</strong></div>${barra(m.tiktok.valor, m.tiktok.meta)}</div>` +
    `<p class="tenue">${m.tiktok.fecha ? `Anotado el ${esc(m.tiktok.fecha)}` : 'Anótalo cada domingo para ver tu avance.'}</p>`;
  pintarRadar(crecer.radar);
  const cal = $('#calendario');
  cal.innerHTML = crecer.proximos.length
    ? crecer.proximos.map((p) => `<div class="fila"><div class="crece"><strong>${esc(p.titulo)}</strong><div class="tenue">${esc(fechaCorta(p.programado))}${p.puntos ? ` · ${p.puntos}/10` : ''}${p.avisado ? ' · ya te avisé' : ''}</div></div><a class="boton" href="#clips/${esc(p.id)}">Ver</a></div>`).join('')
    : '<div class="fila tenue">Sin clips programados todavía. Al terminar cada directo, el Centro reparte los clips: uno al día, los mejores primero.</div>';
}

function pintarRadar(r) {
  if (!r?.total) return;
  $('#radar-texto').innerHTML = `${r.lugar ? `Estás en el lugar <strong>${r.lugar}</strong> de ${r.total}${r.completo ? '' : '+'} canales en ${esc(r.juego)}.` : `Hay ${r.total}${r.completo ? '' : '+'} canales en ${esc(r.juego)} (todavía no apareces en la lista).`}` +
    `<br>En español: ${r.lugarEs ? `lugar <strong>${r.lugarEs}</strong> de ${r.totalEs}` : `${r.totalEs} canales`}.` +
    `<div class="tenue">${r.total < 40 ? 'Poca competencia: buena categoría para que te encuentren.' : r.total < 200 ? 'Competencia media.' : 'Mucha competencia: aquí te van a encontrar más por tus clips que por el directorio.'} · ${esc(fechaCorta(r.hora))}</div>`;
}

$('#revisar-radar').addEventListener('click', async () => {
  try { const r = await api('/api/crecer/radar', { cuerpo: {} }); if (r.mensaje) toast(r.mensaje); else pintarRadar(r); } catch (e) { toast(e.message); }
});
$('#buscar-raid').addEventListener('click', async () => {
  const cont = $('#raid-opciones');
  cont.innerHTML = '<p class="tenue">Buscando…</p>';
  try {
    const r = await api('/api/crecer/raid');
    if (!r.canal) { cont.innerHTML = `<p class="tenue">${esc(r.mensaje)}</p>`; return; }
    const opciones = [r.canal, ...(r.otros ?? [])];
    cont.innerHTML = opciones.map((c, i) => `<button type="button" data-i="${i}"><div class="crece"><strong>${esc(c.nombre)}</strong> · ${c.espectadores} viendo<div class="tenue">${esc(c.titulo)}</div></div>🚀</button>`).join('');
    cont.querySelectorAll('button').forEach((b) => {
      b.onclick = async () => {
        const c = opciones[b.dataset.i];
        try { const x = await api('/api/crecer/raid', { cuerpo: { id: c.id } }); cont.innerHTML = `<p>✅ ${esc(x.mensaje)}</p>`; } catch (e) { toast(e.message); }
      };
    });
  } catch (e) { cont.innerHTML = ''; toast(e.message); }
});
$('#form-tiktok').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/crecer/tiktok', { cuerpo: { total: $('#campo-tiktok').value } }); $('#campo-tiktok').value = ''; toast('Anotado'); cargarCrecer(); } catch (err) { toast(err.message); }
});
$('#copiar-semanal').addEventListener('click', async () => {
  try { const t = await api('/api/crecer/reporte'); toast((await copiar(t)) ? 'Reporte copiado: pégalo en tu entrenador' : 'No pude copiar'); } catch (e) { toast(e.message); }
});

// ---------- diagnóstico ----------
$('#probar-todo').addEventListener('click', async () => {
  const btn = $('#probar-todo');
  btn.disabled = true;
  $('#diag-mensaje').textContent = 'Probando cada parte… (tarda unos segundos)';
  $('#resultados-prueba').innerHTML = '';
  try {
    const r = await api('/api/probar', { cuerpo: {} });
    $('#resultados-prueba').innerHTML = r.map((x) => `<li>${x.ok ? '✅' : '❌'} <strong>${esc(x.nombre)}</strong><div class="tenue">${esc(x.detalle)}</div></li>`).join('');
    const malas = r.filter((x) => !x.ok).length;
    $('#diag-mensaje').textContent = malas ? `${malas} cosa(s) por revisar. Copia el reporte y mándamelo.` : '✅ Todo funciona.';
  } catch (e) {
    $('#diag-mensaje').textContent = '❌ ' + e.message;
  } finally { btn.disabled = false; refrescarEstado(); }
});
$('#copiar-reporte').addEventListener('click', async () => {
  try {
    const texto = await api('/api/reporte');
    toast((await copiar(texto)) ? 'Reporte copiado: pégalo en el chat con Claude' : 'No pude copiar el reporte');
  } catch (e) { toast(e.message); }
});
$('#actualizar').addEventListener('click', async () => {
  const btn = $('#actualizar');
  btn.disabled = true;
  btn.textContent = 'Revisando…';
  try {
    const r = await api('/api/actualizar', { cuerpo: {} });
    toast(r.mensaje);
    if (/reinicia/.test(r.mensaje)) setTimeout(() => location.reload(), 20000);
  } catch (e) { toast('❌ ' + e.message); } finally { btn.disabled = false; refrescarEstado(); }
});
async function cargarBitacora() {
  try {
    const b = await api('/api/bitacora');
    $('#bitacora').innerHTML = b.reverse().map((x) => `<li class="${esc(x.nivel)}">${esc(new Date(x.hora).toLocaleTimeString('es-MX', { hour12: false }))} ${esc(x.texto)}</li>`).join('');
  } catch { /* nada */ }
}

// ---------- arranque ----------
let arrancado = false;
async function arrancar() {
  if (arrancado) return;
  arrancado = true;
  irA();
  await refrescarEstado();
  await refrescarChat();
  cargarBandeja(null);
  setInterval(refrescarEstado, 4000);
  setInterval(refrescarChat, 2000);
  setInterval(() => cargarBandeja(null), 20000);
  cargarCrecer();
  setInterval(cargarCrecer, 30000);
}

(async () => {
  try {
    await api('/api/estado');
    $('#app').hidden = false;
    arrancar();
  } catch { /* api() ya mostró el PIN */ }
})();

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
