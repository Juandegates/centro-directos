// Bandeja de publicaciones: clips y posts listos para que los publiques con un toque.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ARCHIVO = new URL('./bandeja.json', import.meta.url);
export const CARPETA_CLIPS = fileURLToPath(new URL('./clips/', import.meta.url));
mkdirSync(CARPETA_CLIPS, { recursive: true });

let items = existsSync(ARCHIVO) ? JSON.parse(readFileSync(ARCHIVO, 'utf8')) : [];
const guardar = () => writeFileSync(ARCHIVO, JSON.stringify(items, null, 2));

export const nuevoId = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + randomBytes(2).toString('hex');

export function agregar(item) {
  items.unshift({ creado: new Date().toISOString(), publicado: {}, ...item });
  // Máximo 40 elementos y nada de más de 7 días: se borran solos (con sus videos).
  const limite = Date.now() - 7 * 24 * 3600_000;
  const quedan = [];
  for (const [i, it] of items.entries()) {
    if (i < 40 && new Date(it.creado).getTime() > limite) quedan.push(it);
    else if (it.tipo === 'clip') rmSync(join(CARPETA_CLIPS, it.id), { recursive: true, force: true });
  }
  items = quedan;
  guardar();
  return items[0];
}

export function actualizar(id, cambios) {
  const it = items.find((x) => x.id === id);
  if (!it) return null;
  Object.assign(it, cambios, { publicado: { ...it.publicado, ...(cambios.publicado ?? {}) } });
  guardar();
  return it;
}

export function quitar(id) {
  const it = items.find((x) => x.id === id);
  if (it?.tipo === 'clip') rmSync(join(CARPETA_CLIPS, id), { recursive: true, force: true });
  items = items.filter((x) => x.id !== id);
  guardar();
}

export const lista = () => items;
