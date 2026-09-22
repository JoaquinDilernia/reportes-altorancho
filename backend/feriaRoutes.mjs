import { Router } from 'express';
import { requireFeriaAuth, requireFeriaRole, validateSellerPin, validateCajaCredentials, generateToken } from './feriaAuth.mjs';
import {
  createOrder, listOrdersByStatus, getOrderById,
  updateOrderPayment, saveOdooOrderId, markOrderConfirmed, markOrderError,
} from './feriaOrders.mjs';
import {
  findOrCreatePartner, findPartnerByDoc, findSalesTeamId, findPricelistId, findProductIdBySku,
  buildSaleOrderPayload, createSaleOrder, confirmSaleOrder, createInvoiceForOrder,
} from './feriaOdoo.mjs';
import { searchFeriaProducts, getFeriaProduct, setRebajaActiva } from './feriaProducts.mjs';
import { PAYMENT_METHODS, tablePrice, computeFinalPrice, activeRebajaField } from './feriaPricing.mjs';

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
    const products = searchFeriaProducts(q).map((p) => ({
      sku: p.sku, modelo: p.modelo, color: p.color, stock: p.stock ?? null,
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
// Odoo de cada línea por SKU, arma y crea el sale.order con la pricelist y
// el Equipo de ventas de la feria, lo confirma, y factura si corresponde.
// Se puede llamar de nuevo sin problema si quedó en 'error' — es idempotente
// respecto de la creación del pedido en Odoo: si esta orden ya tiene un
// odooOrderId guardado (de un intento anterior que llegó a crear el pedido
// pero falló después, típicamente al facturar), un reintento NO vuelve a
// crear el sale.order — salta directo a facturar. Sin esto, reintentar tras
// una factura fallida crearía un pedido duplicado en Odoo con plata real ya
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

      const resolvedLines = [];
      for (const line of order.lines) {
        const productId = await findProductIdBySku(line.sku);
        if (!productId) throw new Error(`SKU no encontrado en Odoo: ${line.sku}`);
        resolvedLines.push({ productId, qty: line.qty, unitPrice: line.unitPrice, discountPct: 0 });
      }

      const vals = buildSaleOrderPayload({ partnerId, pricelistId, teamId, lines: resolvedLines });
      odooOrderId = await createSaleOrder(vals);
      // El id se guarda ANTES de confirmar: si confirmSaleOrder falla, el
      // pedido de Odoo YA existe, y sin el id guardado un reintento del
      // cajero crearía un segundo sale.order por una venta ya hecha.
      // Guardándolo acá, el reintento solo vuelve a confirmar el mismo
      // pedido (confirmar uno ya confirmado es un no-op seguro en Odoo).
      await saveOdooOrderId(order.id, odooOrderId);
      await confirmSaleOrder(odooOrderId);
    }

    // createInvoiceForOrder devuelve null tanto "no se pidió factura" como
    // "se pidió pero Odoo no pudo generarla" (ver feriaOdoo.mjs). Si el
    // cajero pidió facturar, un null acá NO es un éxito silencioso — el
    // pedido ya quedó creado y confirmado en Odoo, pero sin factura, y eso
    // tiene que verse como error para que el cajero lo note y reintente
    // (en vez de creer que ya está todo listo). El reintento, gracias al
    // odooOrderId ya guardado, solo va a reintentar la factura.
    let invoiceId = null;
    if (order.invoiceType) {
      invoiceId = await createInvoiceForOrder(odooOrderId);
      if (!invoiceId) {
        await markOrderError(order.id, `Pedido #${odooOrderId} ya creado y confirmado en Odoo, pero no se pudo generar la factura ${order.invoiceType}. Reintentar solo reintenta la factura, no crea un pedido nuevo.`);
        return res.status(502).json({ error: `Pedido creado en Odoo (#${odooOrderId}) pero falló la factura — reintentar.` });
      }
    }

    await markOrderConfirmed(order.id, { odooOrderId, invoiceId });
    res.json({ order: await getOrderById(order.id) });
  } catch (err) {
    await markOrderError(order.id, err.message);
    res.status(502).json({ error: `No se pudo confirmar en Odoo: ${err.message}` });
  }
});

export default router;
