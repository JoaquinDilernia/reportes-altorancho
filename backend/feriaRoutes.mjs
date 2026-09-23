import { Router } from 'express';
import { requireFeriaAuth, requireFeriaRole, validateSellerPin, validateCajaCredentials, generateToken } from './feriaAuth.mjs';
import {
  createOrder, listOrdersByStatus, getOrderById,
  updateOrderPayment, markOrderError,
  applyOrderLineActions, cancelOrder, listLogisticsOrders, updateOrderShipping,
  addOrderLine, listOrderHistory,
} from './feriaOrders.mjs';
import { deliverLines } from './feriaDelivery.mjs';
// createInvoiceForOrder sigue existiendo en feriaOdoo.mjs pero no se usa: la
// facturación automática está deshabilitada por ahora (ver feriaConfirm.mjs).
import { confirmOrder } from './feriaConfirm.mjs';
import { assertLineActionAllowed } from './feriaLines.mjs';
import { findPartnerByDoc } from './feriaOdoo.mjs';
import { searchFeriaProducts, getFeriaProduct, setRebajaActiva } from './feriaProducts.mjs';
import { getAvailability, getDb, feriaLocationIds } from './feriaStock.mjs';
import { PUBLIC_PRICE_OPTIONS, tablePrice, computeFinalPrice, activeRebajaField } from './feriaPricing.mjs';

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
    const token = generateToken({ role: 'caja', id: user.id, email: user.email, name: user.name });
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
      ? { disponible: true, precioTabla: tablePrice(product, condition, rebajaActiva), rebajaActiva }
      : { disponible: false, precioTabla: null, rebajaActiva: 0 };
  }
  return conditions;
}

router.get('/products/search', requireFeriaAuth, async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (!q) return res.json({ products: [] });
    const found = searchFeriaProducts(q);

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

router.patch('/products/:sku/rebaja', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    const { condition, level } = req.body;
    await setRebajaActiva(req.params.sku, condition, level);
    const product = getFeriaProduct(req.params.sku);
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
    const products = searchFeriaProducts(q).map((p) => {
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

router.get('/orders', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ orders: await listOrdersByStatus(req.query.status || 'pendiente') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:id', requireFeriaAuth, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ order });
});

router.patch('/orders/:id/payment', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    await updateOrderPayment(req.params.id, req.body);
    res.json({ order: await getOrderById(req.params.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (order.status === 'cancelado') return res.status(400).json({ error: 'El pedido está cancelado' });

  // Pedido ya confirmado/facturado: doble click o cajero reabriendo — inocuo.
  if (order.invoiceId || order.status === 'facturado' || order.status === 'confirmado') {
    return res.json({ order });
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
        odooLineId: line.odooLineId, qty: line.qty, locationId: feriaLocationIds()[line.location],
      }]);
    } catch (err) {
      return res.status(502).json({ error: `No se pudo marcar en Odoo: ${err.message}` });
    }
    res.json({ order: await applyOrderLineActions(order.id, [line.lineId], 'deliver', { user: feriaUserName(req) }) });
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

// Historial: todos los pedidos (pendientes, confirmados, cancelados, con error).
router.get('/history', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ orders: await listOrderHistory() });
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

router.get('/logistics/orders', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  try {
    res.json({ orders: await listLogisticsOrders() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
