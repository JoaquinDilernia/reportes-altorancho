# Integración Meta Ads — Diseño

## Contexto

La responsable de pauta publicitaria de Altorancho arma a mano, todas las semanas, un
resumen de performance de Meta Ads (Facebook/Instagram) para la reunión semanal de números.
El objetivo de este proyecto es sumar esos datos directamente al dashboard ya existente
(`Reportes/`), leyendo la API de Meta en vez de armarlo a mano, usando exactamente el mismo
selector de fechas/período que ya maneja el resto del reporte (semana/mes/rango custom +
comparativas vs período anterior, mes anterior y año anterior).

Es el primer canal de pauta que se suma; Google Ads queda para una segunda etapa y no se
implementa en este diseño, pero el nombrado de colecciones/funciones deja lugar para
agregarlo después sin colisionar (`meta_ads_*` ahora, `google_ads_*` a futuro).

## Acceso verificado

Se generó un token de **System User** en el Business Manager de Meta con permiso `ads_read`
(no expira — token permanente de negocio, no de usuario). Verificado en vivo:

- Cuenta publicitaria: `act_227532872978810` ("ND - Shake - Altorancho"), moneda **ARS**,
  timezone **America/Argentina/Buenos_Aires** (coincide con el timezone que ya usa el resto
  del reporte para el bucketing de días — sin conflicto de zona horaria).
- Insights a nivel cuenta (`/act_.../insights`) y a nivel anuncio (`/act_.../ads` con
  `insights` anidado) funcionan con este token y devuelven spend, impressions, clicks, ctr,
  cpc, reach, `actions` (incluye `omni_purchase`, `omni_add_to_cart`,
  `omni_initiated_checkout`, `omni_landing_page_view`), `action_values` (valor monetario de
  esas acciones) y `purchase_roas` ya calculado por Meta.
- Los anuncios (`/act_.../ads`) traen `creative.thumbnail_url` — una URL firmada de Meta que
  **expira** — más `campaign.name` y `adset.name`.

## Alcance

- **Backend**: nuevo conector + sync job + agregación, sumado al mismo servicio Express
  existente (no es un servicio separado).
- **Frontend**: nueva sección en el Dashboard existente, alineada al mismo `PeriodSelector`
  de arriba (no un selector de fechas propio).
- Google Ads: **fuera de alcance**, próxima iteración.
- Desglose por campaña/adset (más allá del top de anuncios): fuera de alcance de esta
  primera versión — se puede sumar después si hace falta.
- Edición/gestión de campañas (crear, pausar, editar presupuesto): fuera de alcance, el
  dashboard es de solo lectura, igual que el resto del reporte.

## Modelo de datos

Dos colecciones nuevas en Firestore (mismo proyecto `pedidos-lett-2`, prefijo
`altorancho_reportes_` ya usado por el resto del proyecto):

- **`altorancho_reportes_meta_ads_daily`** — un doc por día (`YYYY-MM-DD` como id, también
  guardado como campo `date` para poder hacer range queries) con solo los totales de cuenta
  *sumables*: `spend`, `impressions`, `reach`, `clicks`, `purchases` (de `omni_purchase`),
  `purchaseValue` (de `action_values.omni_purchase`), `addToCart`, `initiateCheckout`,
  `landingPageViews`, `currency`. `ctr`/`cpc`/`roas` deliberadamente NO se guardan por día —
  son ratios, y sumar/promediar ratios diarios da un número distinto (e incorrecto) al ratio
  del período completo; se recalculan siempre a partir de los totales ya sumados en
  `computeAdTotals`.
- **`altorancho_reportes_meta_ads_ad_daily`** — un doc por anuncio+día (id
  `{adId}_{YYYY-MM-DD}`) con las mismas métricas sumables más `adId`, `adName`,
  `campaignName`, `adsetName`. Solo se sincroniza para una ventana móvil reciente (ver más
  abajo); no hace falta histórico completo de anuncios viejos para el "top de anuncios"
  semanal.

No se persiste `thumbnail_url` (expira) — se resuelve en el momento vía endpoint propio (ver
"Imagen del anuncio").

## Sync

Nuevo `backend/meta.mjs` (conector) + `backend/sync/metaAds.mjs` (`syncMetaAds()`), sumado a
`runFullSync()` en `index.mjs` junto a los sync de ecommerce/locales/mayorista, con el mismo
intervalo de cron (`SYNC_INTERVAL_HOURS`).

**Diferencia clave respecto al patrón de Tiendanube/Odoo**: esos syncs son incrementales
("traer lo nuevo desde el último sync"). Meta Ads no puede serlo de la misma forma porque
las conversiones se atribuyen con ventanas retroactivas (click de hasta 7 días) — los
números de un día pueden seguir cambiando días después. Por eso `syncMetaAds()` **siempre
re-trae y sobrescribe (upsert) los últimos ~30 días completos**, tanto a nivel cuenta como a
nivel anuncio, cada vez que corre. Días más viejos que la ventana no se vuelven a tocar.

**Backfill histórico** (`backfill.mjs`, extendido): trae histórico completo a nivel cuenta
(`meta_ads_daily`) para que las comparativas vs año anterior tengan datos, igual que ventas.
El backfill a nivel anuncio (`meta_ads_ad_daily`) se limita a la misma ventana de ~30 días —
no tiene sentido para la reunión semanal ver "top anuncios" de hace un año, y muchos
anuncios viejos ya ni tienen creative disponible.

## Imagen del anuncio

Nuevo endpoint `GET /api/ad-image/:adId`, mismo patrón que el ya existente
`/api/product-image/:sku`: no requiere auth (un `<img src>` no puede mandar el header
Authorization, y no es información sensible — mismo razonamiento ya aplicado ahí). En cada
request, pide a Meta la `thumbnail_url` vigente para ese `adId` y devuelve la imagen
(proxeada, no un redirect, para no exponer la URL firmada de Meta al navegador) con
`Cache-Control: public, max-age=86400`.

## Agregación y endpoint de reporte

Nuevo `backend/aggregateAds.mjs`:
- `computeAdTotals(dailyRows)` — suma spend/impressions/reach/clicks/purchases/etc. del
  rango; ctr, cpc y roas se recalculan sobre el total sumado (no se promedian los ctr/cpc
  diarios).
- `computeAdDailyBreakdown(dailyRows)` — serie diaria de gasto (y compras) para el gráfico.
- `computeTopAds(adDailyRows, { limit })` — agrupa por `adId` dentro del rango, suma sus
  métricas, ordena por gasto descendente.

`GET /api/report` (existente) se extiende: cada rango (`current`, `prevPeriod`, `prevMonth`,
`prevYear`) ya se resuelve una sola vez en `getPeriodRanges` y se le pasa a
`buildTotalsSection` — se agrega en paralelo un `buildAdsSection(range)` análogo que consulta
`meta_ads_daily` por ese mismo `range.start`/`range.end`, garantizando que ventas y Meta Ads
usen exactamente las mismas fechas. El resultado se cuelga en `current.metaAds` +
`comparisons.*.metaAdsDeltas`, mismo shape que ya existe para `totals`/`deltas` de ventas.

## Frontend

Nueva sección "Meta Ads" en `Dashboard.jsx`, debajo de las secciones de ventas existentes.
No se filtra por los tabs de canal (`ChannelTabs`) — es gasto de cuenta completa, no
desglosado por canal de venta — pero sí respeta el mismo `PeriodSelector` de arriba.

- KPI cards (reutilizando `KpiCards`/`DeltaBadge`): gasto, impresiones, alcance, clics, CTR,
  CPC, compras, valor de compras, ROAS, agregados al carrito, checkouts iniciados, vistas de
  landing — cada una con su delta vs período/mes/año anterior.
- Gráfico diario de gasto (reutilizando el patrón de `DailyChart`).
- Tabla "Top anuncios" (nuevo `TopAdsTable.jsx`, calcado de `TopProductsTable.jsx` que ya
  muestra imágenes en tabla): miniatura (`<img src="/api/ad-image/:adId">`), nombre del
  anuncio, campaña, gasto, compras, ROAS.

## Riesgos / decisiones abiertas

- Rate limits de la Marketing API: para una sola cuenta con sync cada pocas horas, el volumen
  es bajo (insights diarios de cuenta + de un puñado de anuncios); no se anticipa problema,
  no se agrega manejo especial de rate limiting en esta primera versión.
- **"Alcance" está sumado por día, no es alcance único del período.** Meta's `reach` es
  personas únicas, no un evento sumable — sumar 7 días de `reach` sobrescuenta a cualquiera
  que haya visto el anuncio más de un día esa semana (potencialmente varias veces el número
  real). Se etiqueta como "Alcance (suma diaria)" en el frontend para no inducir a error. El
  fix correcto (una consulta aparte a nivel cuenta sin `time_increment` para el rango
  completo) queda como mejora futura, no bloqueante para esta primera versión.
- Si en el futuro se gestiona más de una cuenta publicitaria (por ejemplo, otra marca), el
  modelo de datos actual asume una sola `META_AD_ACCOUNT_ID` — habría que agregar un campo
  `accountId` a los documentos. No se resuelve ahora (YAGNI), se deja anotado.
