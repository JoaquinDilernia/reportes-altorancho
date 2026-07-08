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

React + Vite (JSX + CSS plano). Gráficos con **Recharts**. Sin librería de manejo de estado
(alcanza con hooks de React dado el uso: una sola persona, un par de veces por semana).

### Páginas
- `Login` — contraseña.
- `Dashboard` — la vista principal.

### Controles del dashboard
- Selector de período: **Semana** / **Mes**, con navegación al período anterior/siguiente.
- Tabs de canal: **Consolidado** / Ecommerce / Lomas / Belgrano / Alcorta / Mayorista.
- Las 3 comparativas (vs período anterior, vs mismo período mes anterior, vs mismo período
  año anterior) se muestran siempre juntas, igual que en el reporte actual.

### Secciones (componentes)
- `KpiCards` — facturación total, facturación promedio diaria, ventas/órdenes, unidades,
  ticket promedio, productos por venta, cada una con badge de variación % (verde/rojo).
- `DailyChart` — barras de facturación por día del período.
- `TopProductsTable` — ordenable por vendidos o por facturación, con stock y velocidad de
  venta.
- `CategoryBreakdown` — desglose por categoría/subcategoría.
- `PaymentMethodsChart` — donut de medios de pago.
- `ProvincesChart` — top provincias (ecommerce).
- `LocalesPanel` — una tarjeta por local para compararlos entre sí.
- `MayoristaPanel` — mismo esquema para mayorista.

### Estructura de carpetas

```
/frontend/src
  api/report.js          # fetch al backend + manejo de token
  auth/                  # login + guardado de token (localStorage)
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

1. **Embudo de conversión de Tienda Nube**: confirmar si la API pública lo expone; si no,
   queda fuera del alcance de v1.
2. **Modelo exacto de locales en Odoo**: confirmar que cada local es un `pos.order.config_id`
   distinto explorando la API antes de escribir el sync de locales.
3. **Distinción de mayorista en Odoo**: confirmar el campo/filtro exacto (lista de precios,
   equipo de ventas, o etiqueta de cliente) explorando la API antes de escribir el sync de
   mayorista.
4. **Volumen de backfill**: 13-14 meses de histórico en 5 canales — estimar tiempo real de
   backfill contra las APIs (especialmente Odoo, que pagina de a 1000 registros) antes de
   asumir que corre en un solo batch corto.
