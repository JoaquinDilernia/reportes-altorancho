import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { getDb } from '../firestore.mjs';
import { hashPassword } from '../feriaAuth.mjs';
import { planBulkUsers } from '../feriaUsers.mjs';

// Alta masiva de usuarios de la feria. El archivo es un JSON:
//   { "vendedores": ["Nombre Apellido", ...], "caja": ["Nombre Apellido", ...] }
// Sin --apply solo muestra lo que haría. Con --apply los crea y deja los PINs y
// contraseñas en <archivo>-credenciales.csv: es la única copia de las
// contraseñas (en Firestore quedan hasheadas), repartirlas y borrar el archivo.
const filePath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!filePath) {
  console.error('Uso: node scripts/createFeriaUsers.mjs <usuarios.json> [--apply]');
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const db = getDb();
const sellers = (await db.collection('feria_sellers').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
const adminIds = (await db.collection('feria_admins').get()).docs.map((d) => d.id);

const plan = planBulkUsers(
  { sellerNames: input.vendedores ?? [], cajaNames: input.caja ?? [] },
  { sellers, adminIds },
  (n) => crypto.randomInt(n),
);

console.log(`Vendedores nuevos: ${plan.newSellers.length}`);
for (const s of plan.newSellers) console.log(`  F${s.code}  ${s.name}  PIN ${s.pin}`);
if (plan.skippedSellers.length) console.log(`Ya existían (no se tocan): ${plan.skippedSellers.join(', ')}`);
console.log(`Usuarios de caja nuevos: ${plan.newAdmins.length}`);
for (const a of plan.newAdmins) console.log(`  ${a.email}  ${a.name}`);
if (plan.skippedAdmins.length) console.log(`Ya existían (no se tocan): ${plan.skippedAdmins.join(', ')}`);

if (!apply) {
  console.log('\nNo se creó nada: volvé a correrlo con --apply para crearlos.');
  process.exit(0);
}

const batch = db.batch();
const now = new Date();
for (const s of plan.newSellers) batch.set(db.collection('feria_sellers').doc(), { ...s, createdAt: now });
for (const a of plan.newAdmins) {
  batch.set(db.collection('feria_admins').doc(a.email), {
    email: a.email, name: a.name, role: a.role, passwordHash: hashPassword(a.password), createdAt: now,
  });
}
await batch.commit();

const csvPath = filePath.replace(/\.json$/i, '') + '-credenciales.csv';
const rows = [
  'Tipo;Nombre;Usuario;Número;PIN / Contraseña',
  ...plan.newSellers.map((s) => `Vendedor;${s.name};;F${s.code};${s.pin}`),
  ...plan.newAdmins.map((a) => `Caja;${a.name};${a.email};;${a.password}`),
];
fs.writeFileSync(csvPath, '﻿' + rows.join('\r\n') + '\r\n');
console.log(`\nCreados. Credenciales en ${csvPath}`);
process.exit(0);
