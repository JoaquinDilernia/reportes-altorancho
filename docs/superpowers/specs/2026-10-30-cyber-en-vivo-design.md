# Cyber en vivo: rediseño del tab Cyber/Black (diseño)

## Contexto y por qué

El Cyber 2026 arrancó el jueves 29/10 a las 21 h y va hasta el 15/11, con días oficiales del 2 al 4/11. Marketing lo sigue desde el tab **Cyber / Black** del dashboard (`frontend/src/components/EventPanel.jsx`, backend `backend/events.mjs` + `backend/eventReport.mjs`, endpoint `GET /api/event?event=cyber|black`). Ahora también lo van a mirar los jefes.

Esto pidió marketing, textual:
- "metele algún chiche como de calculador tipo manija de ir viendo cómo sube o cuando vamos pasando algún objetivo"
- "¿qué onda tema objetivos? eso de vendimos 30 sillas, quiero vender x, o mismo fact por día"

Hoy el tab tiene mucha información de planificación y contexto (supuestos de inflación, plan de inversión, recap completo de 2025, top productos), y lo que está pasando ahora queda perdido entre todo eso. El objetivo es **dar vuelta la página**: arriba se ve en un golpe de vista cómo venimos ahora contra el piso, contra el objetivo y contra el año pasado. La pauta de Meta y Google va al lado. El resto se pliega.

Como es un evento, la página **tiene que verse distinta al resto del reporte** y ser "copada": tener movimiento, festejar y sentirse en vivo. Los primeros bocetos con la estética normal del reporte se descartaron por "muy básicos".

## Objetivos

1. Al entrar, un **contador de facturación** que se mueve y se actualiza casi en vivo, cada pocos minutos.
2. **Piso / objetivo / cómo vamos**, por evento y por día:
   - **Piso** = facturación del mismo día de 2025 (alineado al día oficial, como ya hace `alignEventDays`) × inflación interanual.
   - **Objetivo (techo)** = piso × (1 + crecimiento real). Hoy es web +10% y locales +5% (`TARGET_REAL_GROWTH`).
   - Cada día y el total del evento se clasifican en **bajo piso / entre piso y objetivo / sobre objetivo**.
   - **Proyección de cierre** ("si seguimos así cerramos en $X"), comparada con el piso y el objetivo.
3. **Festejos** al cruzar una meta: piso del día, objetivo del día, piso del evento y objetivo del evento.
4. **Ventas en vivo**: un feed con las últimas ventas (producto, canal/lugar, monto) y una cinta de noticias con hitos y alertas.
5. **Categorías**: unidades y facturación de Cyber 2025 contra 2026 **sin objetivo** (marketing no tiene objetivos por categoría y depende mucho de la disponibilidad), con el **stock actual** al lado y un aviso cuando el stock no alcanza para igualar lo de 2025.
6. **La tabla día por día de pauta + venta**, que **va sí o sí** porque es lo que más les interesa. Por día:
   - Meta: inversión 2025, inversión 2026, ROAS 2025, ROAS 2026
   - Google: inversión 2025, inversión 2026, ROAS 2025, ROAS 2026
   - Facturación 2025 ajustada por inflación (piso), objetivo 2026, real 2026 y estado
   - Fila de totales "a hoy" arriba. Hoy resaltado y "en curso". Los días que vienen muestran lo de 2025 y la inversión del plan; lo real queda vacío. Los días oficiales van destacados.
   - Reemplaza a las dos tablas que hay hoy (la de venta día por día y la de pauta 2025 en `InvestmentPlan.jsx`).

## No objetivos

- No se cargan objetivos a mano, ni por categoría ni por total. Los objetivos siguen saliendo de la fórmula.
- No se toca el resto del dashboard: ni los otros tabs ni la estética general.
- No se cambia cómo se calcula el plan de inversión (`buildInvestmentPlan`). Solo se pliega y se lee de ahí la inversión planeada por día.

## Anti-objetivos (fracaso aunque funcione)

- **Un contador "en vivo" que muestre números inventados o interpolados.** Lo que se muestra es siempre venta real sincronizada. La animación es solo la transición entre el valor anterior y el nuevo.
- Que lo importante quede enterrado otra vez: arriba va solo lo que está pasando ahora.
- Que se vea como un reporte más.
- Romper el seguimiento del Cyber que ya está en curso. Hay que deployar con cuidado, porque se está usando en vivo.

## Diseño visual (aprobado sobre boceto)

Boceto aprobado: `.superpowers/brainstorm/2026-1793365104/content/mix-v3.html`. Es la mezcla de tres direcciones:

- **Estética "estadio de noche"**: fondo oscuro azul profundo con un degradé radial, paneles translúcidos y acentos brillantes (menta → celeste para el progreso, verde lima para "en vivo" y lo real, naranja para la marca y las categorías, rojo para el punto "en vivo" y lo que está bajo el piso). El tab de evento tiene su propio tema, separado del resto del reporte.
- **Arriba (hero)**:
  - Marca "Alto**Cyber** 26" (o "Alto**Black** 26"), indicador "en vivo · día · hace N min", selector Cyber/Black y selector Total / Web / Locales.
  - **Contador de dígitos giratorios** (estilo cartel de aeropuerto) con la facturación del evento hasta ahora. Debajo: ventas, ticket promedio y % real contra los mismos días de 2025.
  - **Pista con corredor**: la barra de avance con banderas en el piso y el objetivo del evento.
  - Cuatro tarjetas: Hoy (% del objetivo del día), "Si seguimos así" (proyección y estado), pauta invertida contra el plan, y ROAS Meta · Google contra 2025.
  - Al costado: **anillo de "objetivo de hoy"**, web contra locales con su estado, hoy contra el mismo día de 2025, y el **feed de últimas ventas** (entran animadas desde arriba).
- **Cinta de noticias** (verde lima) arriba de todo, con hitos y alertas generados a partir de los datos: metas cruzadas, el producto más vendido hoy, la hora pico, las alertas de stock y cuánto falta para el piso o el objetivo.
- **Cartel de festejo** que baja desde arriba al cruzar una meta.
- **Categorías**: barras de unidades 2025 (gris) contra 2026 (naranja), "vendidas / 2025 u · stock N" y el aviso "no alcanza p/ igualar". Al pasar el mouse se ve la facturación ajustada contra la real y el top 5 de productos de la categoría.
- **Pauta acumulada contra el plan**: Meta y Google, con lo invertido, la barra contra el plan y el ROAS contra 2025.
- **Tabla día por día**, según el objetivo 6. La **inversión 2025 se muestra ajustada por inflación** (con el mismo factor del día que usa la venta), así inversión y facturación 2025 están en la misma moneda que 2026. El ROAS no cambia. Una nota lo aclara. *(Decisión mía.)*
- **Plegado abajo de todo**: plan de inversión (lo que hoy es `InvestmentPlan`), supuestos (lo que hoy es `Assumptions`) y "cómo fue Cyber 2025" (lo que hoy es `PastEventRecap`, con top productos). Todo existe hoy y se reutiliza.

El selector Total / Web / Locales filtra el hero, las categorías y la columna de facturación de la tabla. La pauta es siempre de web.

## Datos

### Venta casi en vivo

- Las ventas web llegan a Firestore por `syncEcommerce` (Odoo `sale.order` con `tiendanube_order_id`, incremental por `write_date`). Las de los locales llegan por `syncPosLocales` (POS propio, también incremental) y por `syncLocales` (POS viejo de Odoo). Hoy el cron completo corre cada 4 h (`SYNC_INTERVAL_HOURS`).
- **Nuevo**: mientras hay un evento activo (hoy entre `current.start` y `current.end` de algún `EVENTS`), un cron liviano cada **pocos minutos (5 por defecto)** corre solo los syncs incrementales de venta: `syncEcommerce`, `syncLocales` y `syncPosLocales`, con el `categoryBySku` ya cacheado. Los tres filtran por `write_date`, así que cada corrida trae pocas órdenes. No se queda esperando al sync completo y no se superpone con él (mismo lock `syncRunning` o uno propio).
- **Verificado en vivo (30/10)**: los locales **siguen vendiendo casi todo por el POS viejo de Odoo** (`pos.order`). Desde el 16/10 hubo unas 1.280 órdenes en Lomas y Belgrano, contra 8 del POS propio desde el 23/10. Por eso `syncLocales` tiene que estar en el cron rápido. Si no, la vista de Locales se atrasaría horas.
- El reporte de evento usa un caché en memoria de 10 min (`CACHE_TTL_MS`) que hay que dividir: la parte **en vivo** (ventas del período actual, ads del período actual y stock) se recalcula cada pocos minutos; la parte **pesada y fija** (2025, inflación, baseline, plan) se puede cachear más tiempo.
- El frontend vuelve a pedir los datos cada N minutos (alineado al cron) y anima la transición del valor viejo al nuevo. Muestra "actualizado hace N min" con la hora real del último sync (`sync_metadata.ecommerce.lastSyncedAt`).
- **Verificado en vivo (30/10, 13:13 UTC)**: las órdenes de Tiendanube aparecen en Odoo casi en el momento. Hubo 52 en las últimas 12 h y la más reciente tenía 3 minutos. Leer desde Odoo cada pocos minutos alcanza, no hace falta ir a la API de Tiendanube.

### Pauta en vivo

- Meta y Google ya tienen sync diario (`syncMetaAds` y `syncGoogleAds`, que reescriben los últimos días). Durante el evento se corren más seguido que cada 4 h, por ejemplo cada 30 min (queda a criterio del builder, cuidando los rate limits). Google sigue midiéndose con GA4 (google / cpc), como quedó en `8cc86d7`. **El ROAS de Google que se muestra (en la tabla, en las tarjetas y en la pauta acumulada) es el total, con marca incluida.** Lo decidió Joaquín el 30/10. No se agrega la columna "sin marca".

### Categorías

- La categoría de Tiendanube **no sirve**: en 1.483 productos la primera categoría es "Alto Cyber.". Se usa la jerarquía **"Biblia" de Odoo** (`product.template.categ_id`, por ejemplo `All / Biblia/ MUEBLES / SILLAS / SILLA / SILLA / TUBE`), que hoy no se guarda en `products`. Hay que agregar el path (o los niveles) en `sync/products.mjs`.
- Agrupación pedida: **Sillas** (MUEBLES / SILLAS: silla, sillón, poltrona, reposera), **Iluminación inalámbrica** (productos con "INALÁMBRIC" en el nombre, unos 190, hoy mezclados dentro de VELADOR), **Iluminación** (el resto de ILUMINACION), **Muebles por tipo** (escritorio, cómoda, mesa de comedor, mesa ratona, mesa de luz, mesa de arrime, consola, banco/banqueta, etc.) y **Textil, Deco y Bazar** como grupos generales. Qué tipos de muebles se muestran por separado y cuáles van a "otros muebles" lo decide el builder según el volumen de 2025, en un mapeo fijo y fácil de editar.
- Por categoría: unidades y facturación del período de 2025 alineado hasta hoy y del evento 2025 completo, unidades y facturación de 2026 a hoy, y la facturación de 2025 ajustada por inflación.
- Se sacan las líneas de descuento de Tiendanube (`withoutDiscountLines`).
- **Stock**: suma de `stockByLocation` del producto en todos los depósitos que ya se sincronizan (locales, EC, depósito Rolón y mayorista). Es decisión del builder si mayorista entra, pero tiene que quedar explícito en una nota. Se actualiza con el sync de productos.
- **Aviso "no alcanza"**: unidades 2026 vendidas + stock < unidades del evento 2025 completo.

### Feed de últimas ventas y cinta

- Feed: las N ventas más recientes del evento (web y locales), con el producto principal (o "N productos"), el canal (y la provincia si es web, que ya está en el doc), el monto y hace cuánto. **No se muestran datos personales del cliente.**
- Cinta: frases armadas en el backend o el frontend a partir de datos reales (metas cruzadas y a qué hora, el producto más vendido hoy en unidades, la hora pico, las alertas de stock y cuánto falta para la próxima meta).

### Proyección de cierre

Lo vendido hasta ahora + lo que falta de los días que vienen, proyectado como el objetivo de esos días × el ritmo actual contra el objetivo (lo real a hoy ÷ el objetivo de los días jugados). Para el día en curso se usa la parte proporcional del objetivo. El método exacto lo decide el builder, pero tiene que ser simple de explicar en una línea en "Supuestos".

### Festejos

Se disparan en el frontend cuando, entre una actualización y la siguiente (o al entrar), un valor cruza un umbral: piso del día, objetivo del día, piso del evento y objetivo del evento. Al entrar, si ya se cruzó antes, se muestra una vez por sesión del navegador, no en cada refresco.

## Lo que queda a criterio del builder

- La estructura de componentes, si el tema oscuro se aplica con un wrapper con variables CSS propias, y si las animaciones se hacen a mano o con alguna librería liviana. Respetar `prefers-reduced-motion`.
- La forma exacta del endpoint (un `/api/event` ampliado o uno nuevo `/api/event/live` liviano para el polling).
- El mapeo exacto de categorías y la frecuencia exacta de los crons.
- El comportamiento en celular: la página tiene que poder leerse, aunque el uso principal es en desktop.

## Deploy (cómo llega a producción)

- **Backend**: Railway hace auto-deploy en cada push a `main`. No hay staging. Por eso todo cambio de backend tiene que ser **aditivo**: el frontend que está publicado hoy tiene que seguir funcionando con el `/api/event` nuevo. Se agregan campos, no se renombran ni se borran. Cada paso se verifica en vivo después del push.
- **Frontend**: es un build estático que Joaquín sube a mano a reportes.techdi.com.ar. La página nueva recién se ve cuando él sube el `dist` nuevo, así que se puede probar entera en local contra el backend de Railway antes de publicarla. Se reemplaza `EventPanel` directamente, sin flag.

## Restricciones

- Hay que mantener los criterios del reporte: web sin IVA ni envío, locales con IVA, y días en hora de Argentina (`argDay`).
- Black usa la misma página (su `EVENTS.black`). Antes de que empiece, la parte en vivo se ve vacía o en modo "cuenta regresiva".
- El build del frontend tiene que apuntar a la API de Railway, no a localhost. Verificar `dist` antes de entregar.
- Se trabaja en `main`, sin worktree. Los tests de lógica pura van en `backend/test/events.test.mjs` (se corren con `node --test`).
