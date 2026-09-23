import { Router } from 'express';
import { requireFeriaAuth, requireFeriaRole, validateSellerPin, validateCajaCredentials, generateToken } from './feriaAuth.mjs';
import {
  createOrder, listOrdersByStatus, getOrderById,
  updateOrderPayment, saveOdooOrderId, markOrderConfirmed, markOrderError,
} from './feriaOrders.mjs';
// createInvoiceForOrder sigue existiendo en feriaOdoo.mjs pero no se importa:
// la facturación automática está deshabilitada por ahora (ver más abajo, en
// /orders/:id/confirm). Volver a importarla al reactivarla.
import {
  findOrCreatePartner, findPartnerByDoc, findSalesTeamId, findPricelistId, findProductIdBySku,
  findPaymentMethodId, buildSaleOrderPayload, createSaleOrder, confirmSaleOrder,
} from './feriaOdoo.mjs';
import { searchFeriaProducts, getFeriaProduct, setRebajaActiva } from './feriaProducts.mjs';
import { getAvailability, getDb } from './feriaStock.mjs';
import { PAYMENT_METHODS, tablePrice, computeFinalPrice, activeRebajaField, odooLinePricing } from './feriaPricing.mjs';

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
          Object.entries(PAYMENT_METHODS).map(([method, info]) => [
            method,
            { label: info.label, precio: computeFinalPrice(p, condition, rebajaActiva, method) },
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

// Confirma el pedido: crea (o busca) el partner, resuelve el product_id de
// Odoo de cada línea por SKU, y arma y crea el sale.order con la pricelist y
// el Equipo de ventas de la feria, y lo confirma. NO factura: la facturación
// automática está deshabilitada por ahora (ver el comentario más abajo), así
// que todo pedido confirmado queda en estado 'confirmado', nunca 'facturado'.
// Se puede llamar de nuevo sin problema si quedó en 'error' — es idempotente
// respecto de la creación del pedido en Odoo: si esta orden ya tiene un
// odooOrderId guardado (de un intento anterior que llegó a crear el pedido
// pero falló después), un reintento NO vuelve a crear el sale.order. Sin
// esto, reintentar crearía un pedido duplicado en Odoo con plata real ya
// cobrada.
router.post('/orders/:id/confirm', requireFeriaAuth, requireFeriaRole('caja'), async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

  // Pedido ya terminado (facturado): no se toca Odoo de nuevo. Un doble
  // click o un cajero reabriendo un pedido completo tiene que ser inocuo —
  // ni una segunda factura, ni pasar a 'error' una venta ya cerrada.
  if (order.invoiceId || order.status === 'facturado') {
    return res.json({ order });
  }

  try {
    let odooOrderId = order.odooOrderId;

    if (!odooOrderId) {
      const partnerId = await findOrCreatePartner({
        name: order.customer.name, docNumber: order.customer.docNumber,
      });
      const teamId = await findSalesTeamId(process.env.ODOO_FERIA_TEAM_NAME);
      const pricelistId = await findPricelistId(process.env.ODOO_FERIA_PRICELIST_NAME);
      if (!pricelistId) throw new Error(`Pricelist de feria no encontrada en Odoo: "${process.env.ODOO_FERIA_PRICELIST_NAME}"`);
      const odooPaymentName = PAYMENT_METHODS[order.paymentMethod]?.odooName;
      const paymentMethodId = await findPaymentMethodId(odooPaymentName);
      if (!paymentMethodId) throw new Error(`Medio de pago no encontrado en Odoo: "${odooPaymentName ?? order.paymentMethod}"`);

      const resolvedLines = [];
      for (const line of order.lines) {
        const productId = await findProductIdBySku(line.sku);
        if (!productId) throw new Error(`SKU no encontrado en Odoo: ${line.sku}`);
        resolvedLines.push({ productId, qty: line.qty, ...odooLinePricing(line, order.paymentMethod) });
      }

      const vals = buildSaleOrderPayload({ partnerId, pricelistId, teamId, paymentMethodId, lines: resolvedLines });
      odooOrderId = await createSaleOrder(vals);
      // El id se guarda ANTES de confirmar: si confirmSaleOrder falla, el
      // pedido de Odoo YA existe, y sin el id guardado un reintento del
      // cajero crearía un segundo sale.order por una venta ya hecha.
      await saveOdooOrderId(order.id, odooOrderId);
    }

    // Fuera del if a propósito: se confirma en TODOS los intentos, no solo
    // cuando el pedido se acaba de crear. Si confirmSaleOrder falló en un
    // intento anterior, el odooOrderId ya está guardado y el reintento se
    // saltea la creación — si el confirm también quedara adentro del if, ese
    // sale.order se quedaría como presupuesto en borrador para siempre.
    // Re-confirmar uno ya confirmado es un no-op seguro en Odoo (chequea el
    // state y no hace nada si ya está en 'sale').
    await confirmSaleOrder(odooOrderId);

    // Facturación automática deshabilitada temporalmente: falló en producción
    // contra Odoo real y el mecanismo exacto (cron vs. disparo al confirmar,
    // ver spec) todavía no está resuelto. El pedido se crea y confirma en Odoo
    // igual, con el precio correcto — solo se deja de intentar generar la
    // factura. Reactivar cuando se resuelva el mecanismo de facturación.
    await markOrderConfirmed(order.id, { odooOrderId, invoiceId: null });
    res.json({ order: await getOrderById(order.id) });
  } catch (err) {
    // markOrderError escribe en Firestore: si lo que está caído es Firestore,
    // tirar acá adentro del catch sería un rechazo sin manejar en un handler
    // async de Express 4 — es decir, voltear el proceso entero justo cuando
    // ya hay un error en curso. Se registra y se sigue: al cajero le importa
    // recibir el 502, no que el pedido haya quedado marcado.
    try {
      await markOrderError(order.id, err.message);
    } catch (markErr) {
      console.error('[feria] no se pudo marcar el pedido como error:', markErr.message);
    }
    res.status(502).json({ error: `No se pudo confirmar en Odoo: ${err.message}` });
  }
});

export default router;
