import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStockAlerts } from '../feriaStock.mjs';

const catalog = [
  { sku: 'A', modelo: 'Mesa', color: 'Roble', precioDiscontinuo: 1000 },
  { sku: 'B', modelo: 'Aparador', precioDiscontinuo: 1000 },
  { sku: 'C', modelo: 'Silla', precioDiscontinuo: 1000 },
  { sku: 'D', modelo: 'Banco', precioDiscontinuo: null, precioFalla: 500 }, // solo falla: no va
  { sku: 'E', modelo: 'Cómoda', precioDiscontinuo: 1000 },
];
const odoo = new Map([
  ['A', { exhibicion: 0, rolon: 3 }],
  ['B', { exhibicion: 2, rolon: 5 }], // reservado todo lo de exhibición → alerta
  ['C', { exhibicion: 1, rolon: 4 }], // queda 1 en exhibición → no
  ['D', { exhibicion: 0, rolon: 2 }],
  ['E', { exhibicion: 0, rolon: 1 }], // lo de Rolón está todo reservado → no
]);
const reserved = new Map([['B__exhibicion', 2], ['E__rolon', 1]]);

test('computeStockAlerts: discontinuo sin disponible en exhibición y con disponible en Rolón', () => {
  const alerts = computeStockAlerts(catalog, odoo, reserved, new Map());
  assert.deepEqual(alerts.map((a) => [a.sku, a.exhibicion, a.rolon]), [['B', 0, 5], ['A', 0, 3]]);
  assert.equal(alerts[1].color, 'Roble');
});

test('computeStockAlerts: marca lo que ya está en camino', () => {
  const inTransit = new Map([['A', { by: 'Logística', at: new Date('2026-10-01T15:00:00Z') }]]);
  const alerts = computeStockAlerts(catalog, odoo, reserved, inTransit);
  assert.equal(alerts.find((a) => a.sku === 'A').enCamino.by, 'Logística');
  assert.equal(alerts.find((a) => a.sku === 'B').enCamino, null);
});
