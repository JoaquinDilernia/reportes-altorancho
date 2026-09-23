// Spike manual (Task 2 del plan 2026-09-23): prueba deliverLines contra el
// Odoo REAL. Mueve stock de verdad. Correr solo con OK del usuario.
//
// Sin argumentos: lista qué hay en FER/Stock/exhibicion y FER/Stock/Rolon.
// Con dos SKUs:   node scripts/feriaDeliverySpike.mjs <SKU_EXHIBICION> <SKU_ROLON>
//   1. crea un sale.order (partner 77753, almacén Feria) con 1 u. de cada SKU
//   2. lo confirma
//   3. entrega el primero desde exhibición → espera remito done + backorder
//   4. entrega el segundo desde Rolón     → espera backorder done
import 'dotenv/config';
import { authenticate, callKw } from '../odoo.mjs';
import { deliverLines } from '../feriaDelivery.mjs';

const EXHIB = Number(process.env.ODOO_FERIA_LOCATION_EXHIBICION_ID || 427);
const ROLON = Number(process.env.ODOO_FERIA_LOCATION_ROLON_ID || 428);
const WAREHOUSE = Number(process.env.ODOO_FERIA_WAREHOUSE_ID || 43);
const TEST_PARTNER = 77753; // "Altorancho Nordelta" — cliente de prueba acordado

async function showPickings(orderId) {
  const pickings = await callKw('stock.picking', 'search_read', [[['sale_id', '=', orderId]]], {
    fields: ['name', 'state', 'backorder_id', 'move_ids'],
  });
  for (const p of pickings) {
    const moves = await callKw('stock.move', 'read', [p.move_ids], { fields: ['product_id', 'product_uom_qty', 'quantity_done', 'state'] });
    console.log(`  ${p.name} [${p.state}] backorder_de=${p.backorder_id ? p.backorder_id[1] : '-'}`);
    for (const m of moves) console.log(`     ${m.product_id[1]} pedido=${m.product_uom_qty} hecho=${m.quantity_done} ${m.state}`);
  }
}

await authenticate();
const [skuA, skuB] = process.argv.slice(2);

if (!skuA || !skuB) {
  const quants = await callKw('stock.quant', 'search_read', [[['location_id', 'in', [EXHIB, ROLON]], ['quantity', '>', 0]]], {
    fields: ['product_id', 'location_id', 'quantity'],
  });
  for (const q of quants) console.log(`${q.location_id[1]}  ${q.product_id[1]}  qty=${q.quantity}`);
  process.exit(0);
}

async function productId(sku) {
  const [p] = await callKw('product.product', 'search_read', [[['default_code', '=ilike', sku]]], { fields: ['id'], limit: 1 });
  if (!p) throw new Error(`SKU no encontrado: ${sku}`);
  return p.id;
}

const orderId = (await callKw('sale.order', 'create', [[{
  partner_id: TEST_PARTNER,
  warehouse_id: WAREHOUSE,
  order_line: [
    [0, 0, { product_id: await productId(skuA), product_uom_qty: 1 }],
    [0, 0, { product_id: await productId(skuB), product_uom_qty: 1 }],
  ],
}]]))[0];
await callKw('sale.order', 'action_confirm', [[orderId]]);
const [order] = await callKw('sale.order', 'read', [[orderId]], { fields: ['name', 'order_line'] });
console.log(`Pedido ${order.name} (id ${orderId}) confirmado. Remitos:`);
await showPickings(orderId);

console.log(`\n→ Entregando ${skuA} desde exhibición`);
console.log(await deliverLines(orderId, [{ odooLineId: order.order_line[0], qty: 1, locationId: EXHIB }]));
await showPickings(orderId);

console.log(`\n→ Entregando ${skuA} otra vez (tiene que volver alreadyDone)`);
console.log(await deliverLines(orderId, [{ odooLineId: order.order_line[0], qty: 1, locationId: EXHIB }]));

console.log(`\n→ Entregando ${skuB} desde Rolón`);
console.log(await deliverLines(orderId, [{ odooLineId: order.order_line[1], qty: 1, locationId: ROLON }]));
await showPickings(orderId);

console.log(`\nListo. Revisar ${order.name} en Odoo y hacer la devolución de las 2 unidades si hace falta.`);
process.exit(0);
