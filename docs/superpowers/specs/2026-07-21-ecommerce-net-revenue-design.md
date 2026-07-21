# Ecommerce: facturación neta sin IVA + envío separado — Diseño

## Contexto

El jefe de Joaquín marcó un problema con el reporte actual: los números de ecommerce
(hoy sincronizados desde la API REST de Tiendanube) son "brutos" — incluyen IVA y el
costo de envío cobrado al cliente, que no es ganancia real sino un gasto que se traslada.
Quiere poder analizar ecommerce con el valor neto (sin IVA) y ver el envío facturado
como algo separado de la venta de productos.

Investigando en vivo contra Odoo se confirmó que **ya existe todo lo necesario del lado
de Odoo**, sin integrar nada nuevo: hay un conector Tiendanube↔Odoo funcionando hace
tiempo que sincroniza cada orden de Tiendanube como un `sale.order` bajo el equipo de
ventas `Tienda Nube` (`team_id=1`), con:
- `amount_untaxed` / `amount_tax`: neto y IVA ya calculados por Odoo.
- Una línea de producto fija para el envío (`product_id=4`, código `Delivery_007`,
  presente en todas las órdenes de Tiendanube, incluso con neto $0 en envío gratis)
  con su propio `price_subtotal` neto — no hay que adivinar el envío por texto.
- Campos `tiendanube_gateway_name`, `tiendanube_order_payment_status`,
  `tiendanube_order_status` — equivalentes exactos a lo que hoy se lee de la API REST
  de Tiendanube (gateway, estado de pago, estado de la orden).
- Provincia de envío disponible vía `partner_shipping_id → res.partner.state_id`.

Es decir, Odoo tiene un superset estricto de lo que hoy aporta la API de Tiendanube para
este canal, con la ventaja adicional del desglose neto/IVA/envío. Por eso el alcance de
este cambio no es "agregar un dato": es reemplazar por completo la fuente de datos del
canal ecommerce, migrándolo al mismo patrón que ya usan Locales y Mayorista (Odoo vía
JSON-RPC), en vez de seguir dependiendo de la API REST de Tiendanube para las ventas.

También se detectó que, bajo ese mismo equipo `Tienda Nube` en Odoo, conviven 1.676
órdenes cargadas a mano directamente en Odoo (numeradas `S0xxxx`, no `TN...`) que no
corresponden a compras reales de la tienda online — algunas con montos grandes. Se
distinguen limpio por el campo `tiendanube_order_id`, que solo está cargado en las
órdenes realmente sincronizadas desde Tiendanube.

## Decisiones tomadas con el usuario

1. **Reemplazo completo de la fuente**, no una fuente secundaria de enriquecimiento:
   ecommerce pasa a sincronizarse 100% desde Odoo (`sale.order`, `team_id=1`), igual
   que Mayorista y Locales. Se deja de usar la API REST de Tiendanube para ventas (el
   catálogo de productos sigue viniendo de Tiendanube — eso no cambia).
2. **El cambio a neto sin IVA es solo para ecommerce.** Locales y Mayorista siguen
   usando `amount_total` (bruto) como hasta ahora — no se tocan.
3. **Solo cuentan como ecommerce las órdenes con `tiendanube_order_id` cargado.** Las
   1.676 órdenes manuales bajo el mismo equipo quedan afuera del canal.
4. **El envío se resta de "Facturación" y se muestra en una tarjeta KPI aparte**
   ("Envíos facturados"), en vez de sumarse a la venta o solo anotarse al margen.

### Consecuencia aceptada, no un bug a resolver

Con esto, la vista "Consolidado" (que suma todos los canales) queda mezclando ecommerce
en neto sin IVA con Locales/Mayorista en bruto con IVA. El total de "Facturación" en
Consolidado deja de ser 100% comparable canal a canal — no porque un canal venda menos,
sino porque se mide distinto. Es la consecuencia directa de la decisión #2 de arriba,
tomada conscientemente por el usuario. Si más adelante quieren que Consolidado sea
homogéneo, el camino sería extender el mismo cambio (neto sin IVA) a Locales y Mayorista
como un proyecto aparte.

## Cambios de diseño

### 1. `backend/sync/ecommerce.mjs` — reescritura completa

Mismo esqueleto que `backend/sync/mayorista.mjs`:
- `authenticate()` contra Odoo.
- Incremental por `write_date` (no `date_order`), con el mismo motivo ya documentado en
  mayorista/locales: una orden creada en una corrida y confirmada/pagada después no debe
  quedar huérfana del sync si su `date_order` cae antes del `since`.
- Domain: `[['team_id', '=', 1], ['tiendanube_order_id', '!=', false], ['write_date', '>=', since]]`.
- Fields de la orden: `id, name, date_order, amount_total, amount_untaxed, amount_tax,
  state, order_line, tiendanube_order_id, tiendanube_order_payment_status,
  tiendanube_gateway_name, partner_shipping_id`.
- Fetch de líneas vía `sale.order.line` `read` (patrón `chunk`/`CHUNK_SIZE` ya existente),
  con fields `order_id, product_id, product_uom_qty, price_unit, price_subtotal`.
- Fetch de provincia: batch-read de `res.partner` sobre los `partner_shipping_id` únicos
  de la página (mismo patrón que `fetchPaymentMethodByOrderId` en `locales.mjs`), leyendo
  `state_id`.

### 2. `normalizeOdooEcommerceOrder` — nuevo normalizador en `normalize.mjs`

Por cada orden:
- **`status`**: `state === 'cancel'` → `cancelled`; si no,
  `tiendanube_order_payment_status === 'paid'` → `completed`; si no, `pending`. Mismo
  criterio de negocio que ya aplicaba `normalizeTiendanubeOrder`, ahora leído de Odoo.
- **`total`** (alimenta la tarjeta "Facturación" y el resto de los cálculos de
  `aggregate.mjs` que suman `sale.total`): `amount_untaxed` menos el `price_subtotal` de
  la línea de envío. Neto, sin IVA, sin envío — la venta real de productos.
- **`shippingRevenue`** (campo nuevo en el doc de venta): el `price_subtotal` de la línea
  de envío (identificada por `product_id === 4`, SKU `Delivery_007`). `0` si por algún
  motivo no aparece la línea.
- **`paymentMethod`**: `tiendanube_gateway_name`.
- **`shippingProvince`**: nombre de provincia resuelto desde `partner_shipping_id`.
- **`items`**: todas las líneas de producto **excepto** la línea de envío y las líneas de
  nota/sección sin `product_id` (mismo filtro que ya usa `mayorista.mjs`). Por línea:
  `sku` (vía `extractSkuFromDisplayName`), `name`, `category` (vía `categoryBySku`), `qty:
  product_uom_qty`, `unitPrice: price_subtotal / qty`. Se usa el neto dividido por
  cantidad (no `price_unit`, que en Odoo puede ser el precio de lista antes de descuento)
  para que el cálculo `qty × unitPrice` que ya hace todo `aggregate.mjs` (Top productos,
  categorías) reproduzca el neto real de la línea sin cambiar esa lógica en ningún otro
  lado.

### 3. `backend/aggregate.mjs` — nueva métrica

`computeShippingRevenue(salesDocs)`: suma `shippingRevenue` (default 0) sobre las ventas
`completed`, mismo filtro que ya usa `computeTotals`. Se agrega al bundle de
`buildTotalsSection` en `index.mjs`, con sus 3 comparaciones (prevPeriod/prevMonth/prevYear),
igual que el resto de las métricas.

### 4. Frontend — tarjeta KPI nueva

"Envíos facturados" en la fila de KPIs del Dashboard, junto a las existentes, alimentada
por `shippingRevenue`. Se muestra igual en todas las vistas de canal; en Locales/Mayorista
naturalmente da $0 (no tienen envío), lo cual es correcto y no requiere ocultar la tarjeta.

### 5. Backfill histórico (`backend/backfill.mjs`)

Como la fuente cambia completamente, hay que re-correr el backfill del canal ecommerce
contra Odoo. Dos ajustes:
- `backfill.mjs` hoy llama `syncEcommerce(categoryBySku, monthsAgoISO(months))` con un
  `since` en formato ISO (estilo API de Tiendanube). Pasa a usar `monthsAgoOdoo(months)`
  (el mismo formato `YYYY-MM-DD HH:MM:SS` que ya usan `syncLocales`/`syncMayorista`).
- Reutilizar el mismo esquema de id de documento (`ecommerce_<sourceId>`, con `sourceId =
  tiendanube_order_id`) para que el backfill **actualice en su lugar** los documentos
  existentes en Firestore en vez de duplicarlos, ya que `saveSalesDocs` sobrescribe por
  id completo (`batch.set`, sin merge).
  **Punto a verificar al implementar** (no confirmado en la exploración): que
  `tiendanube_order_id` sea numéricamente el mismo id que la API REST de Tiendanube
  exponía como `order.id` y que se usó hasta ahora para nombrar esos documentos. Si no
  coincide, los documentos viejos quedan huérfanos y conviene borrar la colección
  `altorancho_reportes_sales` con `channel: 'ecommerce'` antes de re-correr el backfill,
  en vez de dejarlos duplicados.

## Fuera de alcance

- Extender el cambio a neto sin IVA a Locales/Mayorista (ver "Consecuencia aceptada"
  arriba).
- Cambiar el catálogo de productos (`sync/products.mjs`) — sigue viniendo de Tiendanube,
  no de Odoo.
- Tocar el desglose de stock por depósito agregado en la sesión anterior — no tiene
  relación con este cambio.
