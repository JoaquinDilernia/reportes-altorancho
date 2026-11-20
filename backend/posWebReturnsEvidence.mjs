// Evidencia de cambios web (fotos, video, PDF) y etiquetas de envío en
// Firebase Storage: pos-web-returns/<id de la solicitud>/<uuid>.<ext>.
// El bucket se inyecta como último parámetro en los tests.
import { randomUUID } from 'node:crypto';
import admin from 'firebase-admin';
import { getDb } from './firestore.mjs';

export const MAX_EVIDENCE_BYTES = 15 * 1024 * 1024;
const URL_TTL_MS = 60 * 60 * 1000;
const PREFIX = 'pos-web-returns';

const TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'application/pdf': { ext: 'pdf', kind: 'pdf' },
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(TYPES).map(([mime, t]) => [t.ext, mime]));

function defaultBucket() {
  const name = process.env.FIREBASE_STORAGE_BUCKET;
  if (!name) throw new Error('Falta configurar FIREBASE_STORAGE_BUCKET');
  getDb(); // inicializa la app de firebase-admin
  return admin.storage().bucket(name);
}

const assertPath = (storagePath) => {
  const p = String(storagePath ?? '');
  if (!p.startsWith(`${PREFIX}/`) || p.includes('..')) throw new Error('Archivo inválido');
  return p;
};

export async function saveEvidence({ requestId, base64, mimetype, uploadedBy, kind } = {}, bucket) {
  const id = String(requestId ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Solicitud inválida');
  const type = TYPES[String(mimetype ?? '').toLowerCase()];
  if (!type) throw new Error('Tipo de archivo no permitido: subí JPG, PNG, WEBP, MP4 o PDF');
  const data = String(base64 ?? '').replace(/^data:[^,]*,/, '');
  if (!data) throw new Error('Falta el archivo');
  const tooBig = () => new Error('El archivo puede pesar hasta 15 MB');
  if (Math.floor((data.length * 3) / 4) - 2 > MAX_EVIDENCE_BYTES) throw tooBig(); // sin decodificar
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('Falta el archivo');
  if (buf.length > MAX_EVIDENCE_BYTES) throw tooBig();
  const name = `${randomUUID()}.${type.ext}`;
  const storagePath = `${PREFIX}/${id}/${name}`;
  const mime = String(mimetype).toLowerCase();
  await (bucket ?? defaultBucket()).file(storagePath).save(buf, {
    contentType: mime, resumable: false, metadata: { metadata: { uploadedBy: String(uploadedBy ?? '') } },
  });
  return { storagePath, kind: kind ?? type.kind, mimetype: mime, name };
}

export async function evidenceUrl(storagePath, bucket) {
  const [url] = await (bucket ?? defaultBucket()).file(assertPath(storagePath)).getSignedUrl({
    version: 'v4', action: 'read', expires: Date.now() + URL_TTL_MS,
  });
  return url;
}

// Para adjuntar en Odoo (posWebReturnsOdoo la importa lazy).
export async function readEvidenceFile(storagePath, bucket) {
  const p = assertPath(storagePath);
  const [buf] = await (bucket ?? defaultBucket()).file(p).download();
  const name = p.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return { base64: Buffer.from(buf).toString('base64'), mimetype: MIME_BY_EXT[ext] ?? 'application/octet-stream', name };
}
