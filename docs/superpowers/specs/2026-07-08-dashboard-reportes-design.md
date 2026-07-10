# Dashboard de Reportes Altorancho — Diseño

## Contexto

Altorancho (muebles y decoración) tiene varios canales de venta: ecommerce (Tienda Nube),
locales físicos (Lomas de San Isidro, Belgrano, Alcorta) y venta mayorista. Todo el negocio
corre sobre Odoo como ERP, salvo el ecommerce que además vive en Tienda Nube.

Hoy existe una reunión semanal (y un cierre mensual) donde se repasan números de ecommerce
comparando el período actual contra el período anterior, el mismo período del mes anterior
y el mismo período del año anterior. El reporte actual (ver `JUNIO_extracted/*.png` en la
raíz del proyecto, exportado del panel de estadísticas nativo de Tienda Nube) cubre:
facturación y ventas por día, resumen del período con ticket promedio y facturación por
producto, comparativas vs mes anterior y vs año anterior, top productos por unidades y por
facturación (con stock actual y velocidad de venta), ventas por categoría, embudo de
conversión, medios de pago, top provincias por envío, y unos gráficos armados a mano para
locales (Lomas/Belgrano) con ventas por día y ticket promedio.

El objetivo de este proyecto es reemplazar ese proceso manual (screenshots del panel de
Tienda Nube + armado manual de gráficos de locales) por un dashboard propio que conecte
directamente a las APIs de Tienda Nube y Odoo, sume mayorista (hoy casi no se mira en
detalle) y mejore la calidad de los datos de locales (hoy limitados porque desde el ERP no
se sacan buenas métricas).

## Alcance

Proyecto fullstack independiente (no depende de otros proyectos del monorepo de carpetas,
aunque reutiliza el *patrón* de conexión a Odoo ya validado en `odoo-sync-server`):

- **Backend**: Node.js + Express, desplegado en Railway. Cron de sincronización + API de
  reportes.
- **Base de datos**: Firebase Firestore (mismo proveedor que ya usa el usuario en otros
  proyectos).
- **Frontend**: React + Vite (JSX + CSS plano, sin framework de estilos), desplegado como
  build estático en Hostinger o GoDaddy.
- **Usuario**: uso individual (una sola persona), sin necesidad de multi-usuario ni roles.

Fuera de alcance para esta primera versión:
- Multi-usuario / roles / permisos.
- Edición de datos (el dashboard es solo de lectura).
- Reemplazo del bot de atención al cliente o de la herramienta de "lectores" en locales
  (herramientas separadas, no relacionadas con este reporte).
- Embudo de conversión de Tienda Nube (carritos creados, clicks en compra, etc.) — **riesgo
  abierto**: no está confirmado que la API pública de Tienda Nube exponga estos datos de
  analytics/tráfico (la API típica cubre órdenes, productos, clientes). Se debe confirmar
  durante la exploración técnica de la API, antes o al comienzo de la implementación. Si no
  está disponible, este bloque queda fuera y se sigue mirando en el panel nativo de Tienda
  Nube aparte.

## Arquitectura

```
Odoo API (JSON-RPC)  ─┐
                       ├─> Backend (Node/Express, Railway)
Tienda Nube API (REST)─┘        │
                                 │  cron de sync (incremental)
                                 ▼
                          Firestore (órdenes normalizadas)
                                 │
                                 │  endpoint de reporte (agregación)
                                 ▼
                        Frontend React (Hostinger/GoDaddy)
                        Vista semanal / mensual + comparativas
```

El cron corre cada pocas horas (a definir el intervalo exacto en implementación, ej. 3-6hs)
y sincroniza, por canal:
1. **Ecommerce** — órdenes de Tienda Nube vía su API REST.
2. **Locales** — cada local (Lomas, Belgrano, Alcorta) es, según el usuario, un punto de
   venta (POS) distinto en Odoo. Se debe confirmar el modelo exacto explorando la API de
   Odoo al inicio de la implementación (`pos.order` con `config_id` distinto por local es la
   hipótesis de partida).
   Trae órdenes de `pos.order` (+ `pos.order.line`) filtradas por punto de venta.
3. **Mayorista** — órdenes de venta en Odoo distinguidas de venta minorista/local. El
   usuario no tiene certeza del campo exacto (lista de precios, equipo de ventas, o
   etiqueta de cliente); se confirma explorando la API de Odoo al inicio de la
   implementación, antes de fijar el filtro definitivo.
4. **Products** — sincroniza catálogo (SKU, nombre, categoría, stock actual) para poder
   enriquecer el ranking de top productos con stock y velocidad de venta.

Cada sync es **incremental**: solo trae órdenes nuevas o modificadas desde el último sync
exitoso (registrado en `sync_metadata`), para no reprocesar el histórico completo en cada
corrida.

Además del cron, existe un **script de backfill standalone** (`backfill.mjs`, se corre
manualmente una vez, no forma parte del cron) que trae ~13-14 meses de histórico hacia
atrás en el momento de poner el proyecto en marcha, para que las comparativas contra el
año anterior funcionen desde el primer día de uso del dashboard.

## Modelo de datos (Firestore)

### Colección `sales`
Un documento por orden/venta, sin importar el canal de origen:

```js
{
  id: "tn_1234567",              // prefijo por canal + id original, evita colisiones
  channel: "ecommerce",          // ecommerce | local_lomas | local_belgrano | local_alcorta | mayorista
  sourceId: "1234567",           // id original en Odoo/Tienda Nube
  date: Timestamp,               // fecha de la orden
  status: "completed",           // completed | cancelled | pending (normalizado entre ambas fuentes)
  total: 281463,
  paymentMethod: "mercado_pago", // rico en ecommerce; en locales puede ser "efectivo"/"tarjeta"/null si no aplica
  shippingProvince: "Capital Federal", // solo ecommerce; null en el resto
  items: [
    { sku: "BTE249MB", name: "Silla Budapest Verde", category: "Sillas", qty: 1, unitPrice: 86990 }
  ],
  updatedAt: Timestamp
}
```

### Colección `products`
Un documento por SKU. Es estado actual (no histórico), se pisa en cada sync:

```js
{ sku: "BTE249MB", name: "Silla Budapest Verde", category: "Sillas", currentStock: 12 }
```

### Colección `sync_metadata`
Mismo patrón que ya usa `odoo-sync-server`: último sync por canal, cantidad sincronizada,
errores. Permite mostrar en el dashboard "última actualización: hace 2hs" y detectar fallas.

## Backend

Estructura de carpetas:

```
/backend
  odoo.mjs           # conexión a Odoo (JSON-RPC), reutiliza el patrón de odoo-sync-server
  tiendanube.mjs     # conexión a Tienda Nube (REST + token)
  firebase.mjs       # lectura/escritura a Firestore
  /sync
    ecommerce.mjs
    locales.mjs      # las 3 sucursales
    mayorista.mjs
    products.mjs
  /reports
    aggregate.mjs    # calcula totales, AOV, top productos, etc. sobre `sales`
  backfill.mjs        # script standalone, no corre en el cron
  index.mjs           # servidor Express + cron + rutas
```

### Endpoint principal

```
GET /api/report?period=week&date=2026-07-06&channels=ecommerce,local_lomas,local_belgrano,local_alcorta,mayorista
```

Devuelve, en una sola respuesta, todo lo que la vista necesita:
- Totales del período: facturación, unidades, órdenes, ticket promedio, facturación
  promedio diaria.
- Comparación automática contra: período anterior, mismo período del mes anterior, mismo
  período del año anterior (los 3 siempre calculados, sin necesidad de un segundo request).
- Top productos (por unidades y por facturación), enriquecido con stock actual y
  velocidad de venta desde `products`.
- Ventas por categoría.
- Medios de pago (solo tiene datos reales en ecommerce).
- Top provincias por envío (solo ecommerce).
- Desglose por canal/local (para comparar Lomas/Belgrano/Alcorta/mayorista entre sí).

Se prefiere un único endpoint "bundle" en lugar de varios endpoints granulares, porque el
dashboard siempre carga todas las secciones juntas para la reunión — no tiene sentido
multiplicar round-trips.

### Autenticación

Un solo usuario, sin necesidad de sistema de roles. Pantalla de login con una sola
contraseña (variable de entorno en el backend). El login devuelve un token que el frontend
guarda y envía en cada request subsiguiente (mismo patrón de "Bearer secret" que ya usa
`odoo-sync-server`, pero con una pantalla de login en vez de un header manual).

## Frontend

> Actualizado 2026-07-10, después de tener el backend funcionando en local con datos
> reales — la forma exacta de `/api/report` ya está confirmada (ver más abajo), y se
> definió la identidad visual completa con la skill de dataviz.

React + Vite (JSX + CSS plano). Gráficos con **Recharts**. Sin librería de manejo de estado
(alcanza con hooks de React dado el uso: una sola persona, un par de veces por semana).

### Forma real de la respuesta de `/api/report` (confirmada contra datos reales)

```js
{
  ok: true,
  range: { start: '2026-07-06', end: '2026-07-12' },
  current: {
    totals: { revenue, units, orders, avgTicket, daysInRange, avgDailyRevenue },
    dailyBreakdown: [{ date: '2026-07-06', revenue, units, orders }],
    topProductsByUnits: [{ sku, name, unitsSold, revenue, currentStock }],
    topProductsByRevenue: [{ sku, name, unitsSold, revenue, currentStock }],
    categories: [{ category, units, revenue }],
    paymentMethods: [{ method, revenue }],
    provinces: [{ province, orders }],
  },
  comparisons: {
    prevPeriod: { range, totals, deltas: { revenue: {value,pct}, units, orders, avgTicket, avgDailyRevenue } },
    prevMonth:  { range, totals, deltas },
    prevYear:   { range, totals, deltas },
  },
}
```

`deltas.*.pct` es `null` cuando el período anterior fue 0 (evita división por cero) — el
componente que muestra el badge debe contemplar ese caso (mostrar "—" o similar en vez de
un porcentaje).

### Identidad visual

Paleta validada con la skill de `dataviz` (contraste y separación segura para daltonismo,
no elegida a ojo) a partir de los colores de marca (blanco, `#353434`, beige) + Poppins.

**Tokens de diseño** (como variables CSS, ver `frontend/src/styles/tokens.css` en el plan
de implementación):

| Rol | Hex | Uso |
|---|---|---|
| `--surface-page` | `#FFFFFF` | fondo general |
| `--surface-card` | `#F0E6D8` | fondo de tarjetas/secciones (el beige de marca) |
| `--ink-primary` | `#353434` | texto principal, títulos |
| `--ink-secondary` | `#6B6968` | texto secundario, ejes, labels |
| `--delta-positive` | `#0CA30C` | badge de variación positiva |
| `--delta-negative` | `#D03B3B` | badge de variación negativa |
| `--channel-mayorista` | `#2A78D6` | acento canal Mayorista |
| `--channel-ecommerce` | `#1BAF7A` | acento canal Ecommerce |
| `--channel-lomas` | `#008300` | acento canal Lomas |
| `--channel-belgrano` | `#4A3AA7` | acento canal Belgrano |
| `--channel-alcorta` | `#EB6834` | acento canal Alcorta |

`--channel-ecommerce` y `--channel-alcorta` dan por debajo de 3:1 de contraste sobre el
beige de fondo — por eso ningún componente puede depender solo del color: siempre van con
label de texto visible al lado (nombre del canal, no solo un punto de color), tal como ya
estaba planeado en los componentes de abajo.

Tipografía: **Poppins** en todo (Google Fonts), peso 600/700 para títulos y números
grandes (KPIs), 400/500 para el resto.

### Páginas
- `Login` — logo centrado sobre fondo beige, tarjeta blanca con el campo de contraseña.
- `Dashboard` — la vista principal.

### Layout del Dashboard
- Header fijo: logo + selector de período (semana/mes, con flechas prev/next) + tabs de
  canal (Consolidado / Ecommerce / Lomas / Belgrano / Alcorta / Mayorista), cada tab usa
  el color de canal correspondiente como acento cuando está activo.
- Fondo de página blanco, cada sección en una tarjeta con fondo `--surface-card` (beige) y
  borde sutil.
- Las 3 comparativas se muestran siempre juntas como badges verde/rojo al lado de cada KPI.

### Secciones (componentes)
- `KpiCards` — facturación total, facturación promedio diaria, ventas/órdenes, unidades,
  ticket promedio, productos por venta, cada una con badge de variación % (verde/rojo,
  usando `--delta-positive`/`--delta-negative`, mostrando "—" cuando `pct` es `null`).
- `DailyChart` — barras de facturación por día del período. En la vista "Consolidado" las
  barras usan `--ink-primary` (neutro); al elegir un canal específico, toman el color de
  ese canal. Barras finas, puntas redondeadas, tooltip al pasar el mouse.
- `TopProductsTable` — ordenable por vendidos o por facturación, con stock y velocidad de
  venta (`currentStock` puede ser `null` para productos que no están en Tienda Nube — mostrar
  "—", no "0").
- `CategoryBreakdown` — desglose por categoría (lista `categories`, ya viene ordenada por
  facturación desde el backend).
- `PaymentMethodsChart` — donut de medios de pago, con leyenda de texto (no solo colores).
- `ProvincesChart` — top provincias (solo tiene datos en ecommerce; ocultar la sección si
  `provinces` viene vacío, por ejemplo al mirar un canal que no es ecommerce).
- `LocalesPanel` — una tarjeta por local (Lomas/Belgrano/Alcorta), cada una con el color de
  ese canal, para comparar entre sí.
- `MayoristaPanel` — mismo esquema para mayorista, en azul.

### Estructura de carpetas

```
/frontend/src
  api/report.js          # fetch al backend + manejo de token
  auth/                  # login + guardado de token (localStorage)
  styles/tokens.css       # variables CSS de la tabla de arriba
  components/            # los componentes de arriba
  pages/Login.jsx
  pages/Dashboard.jsx
  App.jsx
```

## Deploy

- **Backend**: Railway, con variables de entorno para credenciales de Odoo, Tienda Nube,
  Firebase y la contraseña del dashboard.
- **Frontend**: `vite build` genera `dist/` estático, se sube por FTP/cPanel a Hostinger o
  GoDaddy. La URL del backend se configura en build time vía `VITE_API_URL`.

## Riesgos y puntos a confirmar en la implementación

1. ~~**Embudo de conversión de Tienda Nube**~~ — confirmado que la API de Órdenes/Productos
   no lo expone. Queda fuera de alcance, como estaba previsto.
2. ~~**Modelo exacto de locales en Odoo**~~ — confirmado en vivo: `pos.order.config_id`
   2=Lomas, 5=Belgrano, 7=Alcorta.
3. ~~**Distinción de mayorista en Odoo**~~ — confirmado en vivo: `sale.order.team_id` = 8.
4. **Volumen de backfill** — resuelto parcialmente: se detectó y corrigió un bug real donde
   el backfill completo (14 meses) hubiera fallado por llamadas RPC sin loteo a Odoo: ver
   `docs/superpowers/plans/2026-07-08-backend-pipeline-plan.md`. **El backfill completo de
   14 meses todavía no se corrió** (solo se probó a 1 mes) — hacerlo una vez antes de ir a
   producción, para que las comparativas de "año anterior" tengan datos.
5. **Backend está terminado y verificado en local con datos reales** (2026-07-08/10). El
   frontend es el trabajo pendiente — ver la sección "Frontend" arriba para el diseño ya
   validado con el usuario.
