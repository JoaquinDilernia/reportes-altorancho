import { Router } from 'express';
import {
  requireFeriaAuth, requireFeriaRole, requireSuperadmin, validateSellerPin, validateCajaCredentials, generateToken,
} from './feriaAuth.mjs';
import {
  listUsers, createSeller, updateSeller, deleteSeller, createAdmin, updateAdmin, deleteAdmin,
} from './feriaUsers.mjs';
import {
  createOrder, listOrdersByStatus, getOrderById,
  claimOrderForConfirm, markOrderError,
  applyOrderLineActions, cancelOrder, listLogisticsOrders, updateOrderShipping,
  addOrderLine, listOrderHistory, closeConfirmedOrder, updateOrderPayments, updateOrderNotes,
  listCancelledItemsOrders, restockOrderLine,
} from './feriaOrders.mjs';
import { deliverLines, withOrderLock } from './feriaDelivery.mjs';
import { confirmOrder } from './feriaConfirm.mjs';
import { invoiceOrder } from './feriaInvoice.mjs';
import {
  getCurrentCash, openCashSession, closeCashSession, listCashSessions,
  addCashMovement, voidOpenCashMovement, updateCashNotes,
} from './feriaCash.mjs';
import { computeStats, rangeBounds } from './feriaStats.mjs';
import { assertLineActionAllowed, assertAnnullable, assertInvoiceable, isSentOrder } from './feriaLines.mjs';
import {
  createCart, listSellerCarts, addCartLine, updateCartLine, removeCartLine, discardCart, submitCart,
} from './feriaCarts.mjs';
import { findPartnerByDoc, cancelSaleOrder, hasDeliveredMoves, findOrderInvoices } from './feriaOdoo.mjs';
import { searchFeriaProducts, setRebajaActiva, getFeriaProduct, filterCachedByRebaja } from './feriaProducts.mjs';
import { productImages } from './feriaImages.mjs';
import { getAvailability, getDb, deliveryLocationId } from './feriaStock.mjs';
import { PUBLIC_PRICE_OPTIONS, rebajaLevels, tablePrice, computeFinalPrice, activeRebajaField } from './feriaPricing.mjs';

const router = Router();

router.post('/auth/vendedor', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'Falta el PIN' });
    const seller = await validateSellerPin(pin);
    if (!seller) return res.status(401).json({ error: 'PIN incorrecto' });
    const token = generateToken({ role: 'vendedor', id: seller.id, name: seller.name });
    res.json({ token, seller });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/caja', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Faltan credenciales' });
    const user = await validateCajaCredentials(email, password);
    if (!user) return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    const token = generateToken({ role: 'caja', id: user.id, email: user.email, name: user.name, adminRole: user.adminRole });
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/customers/lookup', requireFeriaAuth, async (req, res) => {
  try {
    const docNumber = req.query.docNumber?.trim();
    if (!docNumber) return res.status(400).json({ error: 'Falta el DNI/CUIT' });
    const partner = await findPartnerByDoc(docNumber);
    res.json({ found: !!partner, partner });
  } catch (err) {
    res.status(502).json({ error: `Error consultando Odoo: ${err.message}` });
  }
});

function buildConditionsPayload(product) {
  const conditions = {};
  for (const condition of ['falla', 'discontinuo']) {
    const priceField = condition === 'falla' ? 'precioFalla' : 'precioDiscontinuo';
    const rebajaActiva = product[activeRebajaField(condition)] ?? 0;
    conditions[condition] = product[priceField] != null
      ? {
        disponible: true, precioTabla: tablePrice(product, condition, rebajaActiva), rebajaActiva,
        niveles: rebajaLevels(product, condition), precioManual: tablePrice(product, condition, 3),
      }
      : { disponible: false, precioTabla: null, rebajaActiva: 0 };
  }
  return conditions;
}

// Las fotos de los resultados se empiezan a traer de Odoo mientras se arma
// la respuesta: cuando el navegador las pide, ya están (o están llegando).
function prefetchImages(products) {
  productImages.prefetch(products.map((p) => p.sku))
    .catch((err) => console.error('[feria] fotos de Odoo no disponibles:', err.message));
}

// Foto del producto. Pública (la usa también /feria, y un <img> no manda el
// token) pero solo para SKUs de la feria. Sin foto → 404 y el panel muestra
// un recuadro vacío.
router.get('/products/:sku/image', async (req, res) => {
  try {
    if (!getFeriaProduct(req.params.sku)) return res.status(404).end();
    const image = await productImages.get(req.params.sku);
    if (!image) {
      res.set('Cache-Control', 'public, max-age=3600');
      return res.status(404).end();
    }
    res.set({ 'Content-Type': image.contentType, 'Cache-Control': 'public, max-age=86400' });
    res.send(image.data);
  } catch (err) {
    console.error('[feria] foto de producto error:', err.message);
    res.status(502).end();
  }
});

router.get('/products/search', requireFeriaAuth, async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json({ products: [] });
    const found = searchFeriaProducts(q);
    prefetchImages(found);

    // Stock en vivo desde Odoo menos lo reservado en la app. Si Odoo no
    // responde, stock: null — el panel no deja agregar (decisión explícita:
    // sin stock confirmado no se vende).
    let availability = null;
    try {
      availability = found.length ? await getAvailability(getDb(), found.map((p) => p.sku)) : new Map();
    } catch (err) {
      console.error('[feria] stock en vivo no disponible:', err.message);
    }

    const products = found.map((p) => ({
      sku: p.sku, modelo: p.modelo, color: p.color,
      stock: availability ? (availability.get(p.sku.toUpperCase()) ?? { exhibicion: 0, rolon: 0 }) : null,
      condiciones: buildConditionsPayload(p),
    }));
    res.json({ products });
  } catch (err) {
    // tablePrice/computeFinalPrice tiran si un documento de Firestore quedó
    // con un nivel de rebaja inválido (p. ej. editado a mano durante la
    // feria). Sin este catch, el rechazo sin manejar en un handler async de
    // Express 4 voltea el proceso entero.
    console.error('[feria] products/search error:', err.message);
    res.status(500).json({ error: 'Error buscando productos' });
  }
});

// Qué está rebajado: contadores por nivel y, con ?level=1|2|3, esos productos
// (sin stock: es para revisar precios, no para vender).
router.get('/products/rebajas', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const level = req.query.level ? Number(req.query.level) : null;
    const { counts, products } = filterCachedByRebaja(level);
    res.json({
      counts,
      products: products.map((p) => ({ sku: p.sku, modelo: p.modelo, color: p.color, condiciones: buildConditionsPayload(p) })),
    });
  } catch (err) {
    console.error('[feria] products/rebajas error:', err.message);
    res.status(500).json({ error: 'Error listando rebajas' });
  }
});

router.patch('/products/:sku/rebaja', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    // `price`: solo para la rebaja 3 (precio manual, con IVA).
    const { condition, level, price } = req.body;
    const product = await setRebajaActiva(req.params.sku, condition, level, price);
    res.json({
      product: { sku: product.sku, modelo: product.modelo, color: product.color, condiciones: buildConditionsPayload(product) },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/public/products/search', async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json({ products: [] });
    const found = searchFeriaProducts(q);
    prefetchImages(found);
    const products = found.map((p) => {
      const precios = {};
      for (const condition of ['falla', 'discontinuo']) {
        const priceField = condition === 'falla' ? 'precioFalla' : 'precioDiscontinuo';
        if (p[priceField] == null) continue;
        const rebajaActiva = p[activeRebajaField(condition)] ?? 0;
        precios[condition] = Object.fromEntries(
          PUBLIC_PRICE_OPTIONS.map(({ key, label, method }) => [
            key,
            { label, precio: computeFinalPrice(p, condition, rebajaActiva, method) },
          ])
        );
      }
      return { sku: p.sku, modelo: p.modelo, color: p.color, precios };
    });
    res.json({ products });
  } catch (err) {
    // Misma razón que en /products/search: esta ruta es pública y un
    // rechazo sin manejar acá voltearía todo el servidor de reportes.
    console.error('[feria] public/products/search error:', err.message);
    res.status(500).json({ error: 'Error buscando productos' });
  }
});

router.post('/orders', requireFeriaAuth, requireFeriaRole('vendedor'), async (req, res) => {
  try {
    const order = await createOrder({
      ...req.body, sellerId: req.feriaUser.id, sellerName: req.feriaUser.name,
    });
    res.status(201).json({ order });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Carritos del vendedor (ver feriaCarts.mjs) ----
const sellerOf = (req) => ({ id: req.feriaUser.id, name: req.feriaUser.name });
const lineInput = ({ sku, condition, qty, location, delivery } = {}) => ({ sku, condition, qty, location, delivery });

function cartRoute(handler) {
  return async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}

router.get('/carts', requireFeriaAuth, requireFeriaRole('vendedor'), cartRoute(async (req) => (
  { carts: await listSellerCarts(req.feriaUser.id) })));

// Crea el carrito con su primer producto (ya reservado) y su número.
router.post('/carts', requireFeriaAuth, requireFeriaRole('vendedor'), cartRoute(async (req) => (
  { cart: await createCart(sellerOf(req), lineInput(req.body)) })));

router.post('/carts/:id/lines', requireFeriaAuth, requireFeriaRole('vendedor'), cartRoute(async (req) => (
  { cart: await addCartLine(req.params.id, req.feriaUser.id, lineInput(req.body)) })));

router.patch('/carts/:id/lines/:lineId', requireFeriaAuth, requireFeriaRole('vendedor'), cartRoute(async (req) => {
  const { qty, location, delivery } = req.body ?? {};
  return { cart: await updateCartLine(req.params.id, req.feriaUser.id, req.params.lineId, { qty, location, delivery }) };
}));

router.delete('/carts/:id/lines/:lineId', requireFeriaAuth, requireFeriaRole('vendedor'), cartRoute(async (req) => (
  { cart: await removeCartLine(req.params.id, req.feriaUser.id, req.params.lineId) })));

// "Vaciar carrito": el cliente no compra, se devuelve todo el stock.
router.delete('/carts/:id', requireFeriaAuth, requireFeriaRole('vendedor'), cartRoute(async (req) => (
  { cart: await discardCart(req.params.id, req.feriaUser.id) })));

router.post('/carts/:id/submit', requireFeriaAuth, requireFeriaRole('vendedor'), cartRoute(async (req) => {
  const { customer, paymentMethod, shipping } = req.body ?? {};
  return { order: await submitCart(req.params.id, sellerOf(req), { customer, paymentMethod, shipping }) };
}));

router.get('/orders', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ orders: await listOrdersByStatus(req.query.status || 'pendiente') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:id', requireFeriaAuth, async (req, res) => {
  // try/catch: en Express 4 un rechazo sin manejar en un handler async voltea
  // el proceso entero, justo cuando Firestore está fallando.
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function feriaUserName(req) {
  return req.feriaUser?.name || req.feriaUser?.email || 'caja';
}

// Confirma el pedido en Odoo (ver feriaConfirm.mjs). NO factura: la
// facturación automática está deshabilitada por ahora. Es reintentable si
// quedó en 'error': si ya había un odooOrderId guardado, no se crea otro
// sale.order (reintentar no puede duplicar una venta ya cobrada).
router.post('/orders/:id/confirm', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  // Se reclama el pedido en una transacción y lo que viaja a Odoo es lo leído
  // ahí: nadie puede cambiarlo, cancelarlo ni confirmarlo dos veces mientras
  // tanto (ver isConfirming).
  let order;
  try {
    const claim = await claimOrderForConfirm(req.params.id);
    // Ya confirmado/facturado: doble click o cajero reabriendo — inocuo.
    if (claim.alreadyConfirmed) return res.json({ order: claim.order });
    order = claim.order;
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  try {
    res.json({ order: await confirmOrder(order, feriaUserName(req)) });
  } catch (err) {
    // markOrderError escribe en Firestore: si lo caído es Firestore, tirar acá
    // voltearía el proceso (rechazo sin manejar en Express 4). Se registra y
    // se sigue: al cajero le importa recibir el 502.
    try {
      await markOrderError(order.id, err.message);
    } catch (markErr) {
      console.error('[feria] no se pudo marcar el pedido como error:', markErr.message);
    }
    res.status(502).json({ error: `No se pudo confirmar en Odoo: ${err.message}` });
  }
});

router.delete('/orders/:id/lines/:lineId', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ order: await applyOrderLineActions(req.params.id, [req.params.lineId], 'remove', { user: feriaUserName(req) }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/orders/:id/lines/:lineId', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const { location, delivery, qty } = req.body;
    res.json({ order: await applyOrderLineActions(req.params.id, [req.params.lineId], 'edit', {
      user: feriaUserName(req), changes: { location, delivery, qty },
    }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orders/:id/lines/:lineId/sent-to-feria', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ order: await applyOrderLineActions(req.params.id, [req.params.lineId], 'sendToFeria', { user: feriaUserName(req) }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// "Hecho": el cliente ya se lo llevó. Primero Odoo (valida esa línea del
// remito desde su ubicación), después la app. Si Odoo ya la tenía hecha (un
// intento anterior se cortó antes de actualizar la app), deliverLines la
// devuelve en alreadyDone y se marca igual.
router.post('/orders/:id/lines/:lineId/deliver', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    const line = order.lines.find((l) => l.lineId === req.params.lineId);
    if (!line) return res.status(404).json({ error: 'Línea no encontrada' });
    assertLineActionAllowed(order, line, 'deliver');

    try {
      await deliverLines(order.odooOrderId, [{
        odooLineId: line.odooLineId, qty: line.qty, locationId: deliveryLocationId(line.location),
      }]);
    } catch (err) {
      return res.status(502).json({ error: `No se pudo marcar en Odoo: ${err.message}` });
    }
    res.json({ order: await applyOrderLineActions(order.id, [line.lineId], 'deliver', { user: feriaUserName(req) }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Anular una venta confirmada: primero en Odoo, después en la app (libera el
// stock reservado). Con algo ya entregado se rechaza: va por Odoo con la
// devolución.
router.post('/orders/:id/annul', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const first = await getOrderById(req.params.id);
    if (!first) return res.status(404).json({ error: 'Pedido no encontrado' });
    assertAnnullable(first);
    // Mismo candado por pedido que "Hecho": una entrega en curso termina antes
    // de que se mire si se puede anular (y al revés).
    const result = await withOrderLock(first.odooOrderId, async () => {
      const order = await getOrderById(first.id);
      assertAnnullable(order);
      // La app puede no saber que algo ya salió (un "Hecho" que se cortó a
      // mitad): se pregunta a Odoo, que es el que manda sobre el stock.
      if (await hasDeliveredMoves(order.odooOrderId)) {
        throw new Error('Parte del pedido ya se entregó en Odoo: anulalo en Odoo con la devolución correspondiente');
      }
      // Idem con la factura: puede estar emitida aunque la app no se enteró.
      const posted = (await findOrderInvoices(order.odooOrderId)).find((i) => i.state === 'posted');
      if (posted) throw new Error(`La venta ya tiene la factura ${posted.name}: anulala en Odoo con una nota de crédito`);
      try {
        await cancelSaleOrder(order.odooOrderId);
      } catch (err) {
        return { status: 502, error: `No se pudo cancelar en Odoo: ${err.message}` };
      }
      try {
        return { order: await closeConfirmedOrder(order.id, feriaUserName(req), 'Anulado desde caja') };
      } catch (err) {
        return { status: 500, error: `Se canceló en Odoo pero no se pudo actualizar la app (${err.message}). Se corrige sola en unos minutos.` };
      }
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ order: result.order });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reintenta la factura de una venta confirmada (AFIP caído, por ejemplo).
router.post('/orders/:id/invoice', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    assertInvoiceable(order);
    const result = await invoiceOrder(order);
    if (result.status === 'skipped') return res.status(400).json({ error: 'La facturación automática no está activada' });
    if (result.status === 'error') return res.status(502).json({ error: result.error });
    res.json({ order: await getOrderById(order.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Caja cambia el pago de un pedido sin confirmar: { paymentMethod } (un
// medio) o { payments: [{ method, amount }] } (dividido en varios).
router.patch('/orders/:id/payment', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const { payments, paymentMethod } = req.body ?? {};
    res.json({ order: await updateOrderPayments(req.params.id, payments ?? [{ method: paymentMethod }], feriaUserName(req)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Caja agrega un producto a un pedido sin confirmar.
router.post('/orders/:id/lines', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const { sku, condition, qty, location, delivery } = req.body ?? {};
    res.json({ order: await addOrderLine(req.params.id, { sku, condition, qty, location, delivery }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Estadísticas de ventas confirmadas: range = hoy | ayer | todo (día argentino).
router.get('/stats', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const range = ['hoy', 'ayer', 'todo'].includes(req.query.range) ? req.query.range : 'hoy';
    const orders = (await listOrderHistory(5000)).map((o) => ({ ...o, createdAtMs: o.createdAt?.toMillis?.() ?? 0 }));
    res.json({ range, stats: computeStats(orders, rangeBounds(range)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Caja del día: una sola abierta a la vez. Sin caja abierta no se confirman
// ventas (ver claimOrderForConfirm).
router.get('/cash/current', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json(await getCurrentCash());
  } catch (err) {
    console.error('[feria] cash/current error:', err.message);
    res.status(500).json({ error: 'No se pudo leer la caja' });
  }
});

router.post('/cash/open', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    await openCashSession({ openingCash: req.body?.openingCash, user: feriaUserName(req) });
    res.json(await getCurrentCash());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/cash/close', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const session = await closeCashSession({ countedCash: req.body?.countedCash, notes: req.body?.notes, user: feriaUserName(req) });
    res.json({ session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Salidas de efectivo de la caja abierta: gastos (con concepto) y retiros.
router.post('/cash/movements', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const { type, concept, amount } = req.body ?? {};
    await addCashMovement({ type, concept, amount }, feriaUserName(req));
    res.json(await getCurrentCash());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/cash/movements/:movementId/void', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    await voidOpenCashMovement(req.params.movementId, feriaUserName(req));
    res.json(await getCurrentCash());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Observación de la caja abierta (se puede ir escribiendo durante el día).
router.patch('/cash/notes', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    await updateCashNotes(req.body?.notes);
    res.json(await getCurrentCash());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/cash/sessions', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ sessions: await listCashSessions() });
  } catch (err) {
    console.error('[feria] cash/sessions error:', err.message);
    res.status(500).json({ error: 'No se pudo leer el historial de cajas' });
  }
});

// Observación de Caja sobre un pedido (en cualquier estado).
router.patch('/orders/:id/notes', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ order: await updateOrderNotes(req.params.id, req.body?.notes, feriaUserName(req)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Historial: todos los pedidos (pendientes, confirmados, cancelados, con error).
router.get('/history', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    // Los carritos (abiertos o vaciados) no son pedidos para Caja.
    res.json({ orders: (await listOrderHistory()).filter(isSentOrder) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cargar o corregir la dirección de envío (Caja o Logística).
router.patch('/orders/:id/shipping', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ order: await updateOrderShipping(req.params.id, req.body ?? {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/orders/:id/cancel', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ order: await cancelOrder(req.params.id, feriaUserName(req)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Pestaña Cancelados de Entregas: lo que hay que devolver a stock.
router.get('/logistics/cancelled', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ orders: await listCancelledItemsOrders() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders/:id/lines/:lineId/restock', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ order: await restockOrderLine(req.params.id, req.params.lineId, feriaUserName(req)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/logistics/orders', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ orders: await listLogisticsOrders() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Usuarios (solo el super admin, desde la pestaña Usuarios de Caja) ----
function usersRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req);
      res.json(await listUsers());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}
const superadmin = [requireFeriaAuth, requireSuperadmin];

router.get('/users', ...superadmin, usersRoute(async () => {}));
router.post('/users/sellers', ...superadmin, usersRoute((req) => createSeller(req.body ?? {})));
router.patch('/users/sellers/:id', ...superadmin, usersRoute((req) => updateSeller(req.params.id, req.body ?? {})));
router.delete('/users/sellers/:id', ...superadmin, usersRoute((req) => deleteSeller(req.params.id)));
router.post('/users/admins', ...superadmin, usersRoute((req) => createAdmin(req.body ?? {})));
router.patch('/users/admins/:id', ...superadmin, usersRoute((req) => updateAdmin(req.params.id, req.body ?? {})));
router.delete('/users/admins/:id', ...superadmin, usersRoute((req) => deleteAdmin(req.params.id)));

export default router;
