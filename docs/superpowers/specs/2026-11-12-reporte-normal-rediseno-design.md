# Reporte normal (fuera de eventos): rediseño (diseño)

## Contexto y por qué

El reporte (`reportes.techdi.com.ar`, frontend `frontend/src/pages/Dashboard.jsx`, backend `GET /api/report`) se usa en dos ritmos:

- **Reunión semanal** (Joaquín con sus jefes): se mira la semana anterior en este orden: consolidado → web → local por local. La chica de pauta presenta su propio reporte aparte, pero sirve tener la info de pauta a mano.
- **Reunión mensual** a fin de mes: el mismo recorrido con el mes.
- **Fuera de las reuniones**: alguien lo abre para mirar una fecha puntual o buscar algo (un producto, un día).

Hoy el reporte cuenta qué se vendió (facturación por día, productos vendidos, categorías, medios de pago), pero según Joaquín "nos falta ver cosas importantes para tomar decisiones". Durante el Cyber 2026 se sumaron cosas que a los jefes les interesaron mucho: comportamiento web de GA4, Clarity y ventas por origen del producto (fábrica / proveedor nacional / importado, pedido de Luli, jefa de producto). Además, el diseño "quedó viejo".

El objetivo es que el reporte **ayude a decidir**. Las decisiones que más se repiten son estas (propuestas por Claude y aceptadas por Joaquín como hipótesis de trabajo):

1. **Qué reponer o empujar**: productos, categorías, origen.
2. **Qué hacer con un local que viene flojo.**
3. **Si la web convierte bien o hay algo trabado.**

A eso Joaquín sumó como **importante** el stock entre depósitos. La web vende más que los locales, así que un producto que se venía vendiendo en la web y se queda sin stock web, teniendo unidades en Rolón o en un local, es venta perdida que hay que ver enseguida. Agregó que el tema depósitos/ubicaciones "es medio quilombo" y pidió entenderlo y mejorarlo.

## Objetivos

- Reorganizar el reporte por **tema**, siguiendo el recorrido de la reunión, en lugar de una pestaña por canal.
- Un **Resumen** que arranque con "lo que hay que mirar": alertas armadas con reglas fijas, cada una con link a su pestaña.
- Sumar a la operación normal lo que se probó en el Cyber: GA4, Clarity, origen del producto y Google Ads junto a Meta.
- **Stock por depósito bien leído**, y una vista de "pasar a la web".
- Diseño moderno con la marca.
- Que siga sirviendo para búsquedas puntuales: rango libre y un buscador de producto.

## No objetivos

- Reemplazar el reporte de la chica de pauta. La pestaña Pauta es para tener la info a mano, no un panel de gestión de campañas.
- Tocar la pestaña Cyber/Black más allá de moverla de lugar. Queda como está mientras dure el evento y después se va. Joaquín: "después chau también".
- Escribir en Odoo, Tienda Nube o Clarity. Todo es solo lectura, salvo las colecciones propias en Firestore.
- Ordenar los depósitos en Odoo. El reporte los interpreta tal como están.

## Anti-objetivos (cosas que lo harían fallar aunque funcione)

- Números que no coinciden con la fuente. Ya pasó dos veces en este proyecto: la falta de Feria en Mayorista y el estado de pago de ecommerce. Las métricas nuevas se verifican en vivo contra Odoo, GA4 o Tienda Nube antes de darlas por buenas.
- Alertas que "gritan" siempre. Si todas las semanas aparecen las mismas 10, nadie las mira. Tienen que ser pocas, concretas y accionables.
- Métricas rotas de GA4 presentadas como ciertas (ver "Verdades sobre los datos").
- Que el reporte actual deje de funcionar mientras se construye el nuevo.
- Gastar de más la cuota de la API de Clarity (~10 llamadas por día) o la de GA4.

## Lo que decidió Joaquín

- **Estructura de pestañas por tema**, opción "A" de las maquetas: **Resumen · Web · Locales · Producto · Pauta · Mayorista**. Más **Cyber/Black** como pestaña aparte mientras haya evento.
- **Feria sale como pestaña.** Supuesto de Claude, avisado y sin objeción: las ventas de feria siguen contando dentro de Mayorista y del total, como se resolvió en agosto (`feria` es un canal aparte en los datos).
- **Estética:** colores de la marca, **blanco y gris `#353434`**. "Podés usar cualquier tipo de label": se permiten etiquetas y estados de color (verde, rojo, ámbar, azul). Tipografía: Poppins, la que ya usa el reporte.
- **Stock:**
  - Rolón es el depósito central.
  - El stock web y el stock mayorista están físicamente en Rolón.
  - Cada local tiene su mini depósito (*Stock*) y lo exhibido (*Exhibición*).
- **Orden de construcción** (aceptado: "dalee perfece vamos con eso"):
  1. Base nueva + Resumen
  2. Producto y stock
  3. Web (GA4 + Clarity)
  4. Locales
  5. Pauta + Mayorista

  Cada parte se puede usar apenas está lista; mientras tanto, lo viejo sigue funcionando.
- La maqueta del Resumen (`.superpowers/brainstorm/293-1794494381/content/resumen.html`) es la referencia visual aprobada en dirección general. Su contenido se ajustó después con lo de stock.

## Verdades sobre los datos (verificadas en vivo el 2026-11-12)

### Depósitos en Odoo

Los ids son de `stock.location`, los que importan.

| Depósito Odoo | Ubicación (`id`) | Físicamente | Uso |
|---|---|---|---|
| E Commerce | EC/Stock (150) | Rolón | Lo que vende la web |
| Mayorista | MAY/Stock (168) | Rolón | Mayorista (14.280 u.) |
| Rolón Local | RL/Stock (174) | Rolón | Reserva central (~9.150 u., ~410 productos) |
| Stock Alcorta en Rolón | AL/RL/Stock (407) | Rolón | Reserva de Alcorta |
| Las Lomas | LL/Stock (8) + LL/Exhibicion (324) | Local | Mini depósito + exhibido |
| Belgrano | BL/Stock (372) + BL/Exhibicion (379) | Local | Ídem |
| Alcorta | AL/Stock (397) + AL/Exhibición (415) | Local | Ídem |
| X/Salida (153, 171, 177, 375, 11…) | — | — | Mercadería saliendo / reservada |

- **Se ignoran** Producto (Prod/Stock 330: ~40.000 bolsas de packaging), Marketing, Exposiciones, Fallados, Reparaciones, Insumos Rolón, Insumos Roma, RMA/* y las ubicaciones virtuales.
- **Hoy el sync** (`backend/sync/products.mjs`, `LOCATION_CHANNELS`) solo lee los *Stock* (8, 372, 397, 168, 150, 174). Le faltan Exhibición (~800 u. en los tres locales) y Alcorta en Rolón.
- **Basura conocida:**
  - Las gift cards (`GFT*`) tienen 100.000.000 u. cada una en EC/Stock.
  - "Envío particular pos" (`[EnvioParticular]`) tiene −8.315 en LL/Stock, y por eso el total de Lomas da negativo.
  - Hay negativos reales chicos (−3 a −10) en algunos productos.
  - Se excluyen gift cards y productos de servicio o envío. Los negativos se cuentan como 0 en los totales.
- **Stock web:** Tienda Nube (`products.currentStock`) coincide con Odoo EC/Stock en el 85% de los SKU. Donde difieren, Tienda Nube suele estar 1–2 u. abajo (reservas). **Para "le queda stock web" se usa Tienda Nube**, que es lo que la web puede vender.

### Origen del producto

- Campo `product.template.clasificacion_origen` (m2m `clasificacion.origen`): Proveedor Nacional 4.603 · Importado 1.257 · Fábrica 846 · Otro 55 · vacío 232. También existen DUAL y RUSTIC TRAIL, con muy pocos productos, que van a "Otro".
- País: `origen` (m2m `origen.model`): China, Vietnam, India, URUN, etc.
- Ya está implementado para el Cyber: `backend/productOrigin.mjs` (lectura directa con cache de 6 h) y `backend/eventOrigins.mjs` (resumen puro). Se reutilizan.

### GA4 (`backend/ga4.mjs`, `backend/eventBehavior.mjs`)

- La `sessionConversionRate` de GA4 está **rota** en esta propiedad (da 73% en 2026). La conversión siempre se calcula como compras ÷ sesiones.
- Los eventos de checkout (`begin_checkout`, `add_shipping_info`, `add_payment_info`) cambiaron su medición entre 2025 y 2026: hay menos que el año pasado con más compras. **No se muestran** ni se comparan.
- `itemCategory` es la categoría de Tienda Nube ("Alto Cyber." para casi todo), así que no sirve. Los ítems se cruzan por nombre (`itemName` = nombre en Tienda Nube) con los productos del catálogo; el 97% de las vistas cruza. Las categorías salen de Odoo con `eventCategoryOf`.
- Los nombres de ítems de 2025 muchas veces ya no existen en el catálogo, así que **no hay comparación interanual por categoría**. Las comparaciones por día y por fuente sí funcionan.
- GA4 tiene unas horas de demora. `purchaseRevenue` de GA4 ≠ facturación de Odoo (incluye IVA y envío). La facturación siempre sale de Odoo; GA4 solo aporta comportamiento.
- La cuenta de servicio y la propiedad ya están en Railway (`GA4_SERVICE_ACCOUNT`, `GA4_PROPERTY_ID`).

### Clarity (`backend/clarity.mjs`)

- La API Data Export solo devuelve los **últimos 1–3 días** y permite ~10 llamadas por día por proyecto. No incluye mapas de calor ni grabaciones.
- El tag se había caído con un cambio de plantilla de Tienda Nube y se reinstaló el 2026-11-12 por GTM (`GTM-5FWFPH3P`, proyecto `gqkzzchnqe`). No hay datos anteriores.
- El token está en Railway (`CLARITY_API_TOKEN`) y en `backend/.env`.

### Google Ads / Meta

- Meta: `backend/meta.mjs`, ventana `1d_click`, colecciones de Firestore diarias y por anuncio.
- Google: `backend/googleAds.mjs` + `sync/googleAds.mjs`. El valor de Google = `purchaseRevenue` de GA4 para `google / cpc` (así lo mide marketing). La búsqueda de marca (`_brand_`) va aparte porque infla el ROAS.

## Diseño

### Estructura y navegación

- Barra superior gris `#353434` con la marca, las pestañas y un **buscador de producto/SKU** a la derecha.
- Debajo, el **selector de período** (Semana · Mes · Rango), con flechas para moverse y la leyenda de contra qué se compara: período anterior y mismo período del año anterior ajustado por inflación, igual que hoy.
- La pestaña y el período elegidos viven en la URL (query string), así un link lleva a la misma vista. Las alertas usan esto para "Ver X ›".
- El **asistente IA** (botón "Analizar con IA" + chat flotante) se mantiene, con el estilo nuevo.

### Resumen

- **5 números grandes**: facturación total, ventas (pedidos), ticket promedio, conversión web (GA4: compras ÷ sesiones) e inversión en pauta (Meta + Google, con ROAS combinado).
  - Cada uno con su variación contra el período anterior, su variación contra el año anterior (ajustada para montos) y una mini tendencia de las últimas 8 semanas (o 12 meses en modo Mes).
- **"Para mirar"**: entre 3 y 6 alertas como máximo, ordenadas por importancia. Incluye al menos una positiva ("Bien") si la hay.
  - Cada alerta lleva etiqueta de tipo (Local, Stock, Web, Producto, Pauta), título con el número y una línea de contexto. Se cliquea para ir a su pestaña.
  - Las reglas, iniciales y ajustables (los umbrales van en un solo archivo de configuración):
    - **Local flojo**: un local vende ≥15% menos que su promedio de las 8 semanas anteriores (en modo Mes: de los 3 meses anteriores, ajustado). Explica si bajaron los tickets o el ticket promedio.
    - **Pasar a la web**: N productos con cobertura de stock web < 7 días (ver Producto). El título muestra cuántos están en Rolón.
    - **Mucho tráfico, poca venta (web)**: los productos con más vistas y peor % de compra (umbral como en el Cyber: ≥ 2.000 vistas por semana; se escala por la duración del período).
    - **Fuente que no convierte**: una fuente con ≥ 10% de las sesiones y conversión < 1/3 del promedio.
    - **Frustración (Clarity)**: una página con muchas sesiones y rage clicks ≥ 5% o clics muertos ≥ 20%.
    - **Origen o categoría que se mueve**: el origen o categoría con mayor variación real interanual (positiva o negativa) si supera ±20%.
- **Por canal**: Web, Lomas, Belgrano, Alcorta y Mayorista (con feria adentro). Cada uno con facturación, barra proporcional, variación y % del total.
- **Facturación por día**: barras apiladas por canal, con referencia del mismo día del año anterior ajustado. En modo Mes son días del mes; en rangos largos se agrupa por semana.

### Producto (incluye stock)

- **Categorías**: las de Odoo con `eventCategoryOf`, con facturación, unidades, variación y stock. Respeta un filtro de canal (Todos / Web / Locales / Mayorista).
- **Por origen**: la tabla del Cyber (`OriginsTable`) adaptada al período: facturación, unidades, pedidos y ticket contra el año anterior ajustado, con importado abierto por país.
- **Más vendidos**: por modelo (SKU reducido, como en el Cyber), con stock total y por depósito.
- **Pasar a la web** (el corazón del pedido de stock):
  - Productos con venta web en las últimas 4 semanas cuya **cobertura web** (stock web de Tienda Nube ÷ venta web diaria promedio de las últimas 4 semanas) sea **< 7 días**, incluido el stock 0.
  - Columnas: producto, venta web por semana, stock web, días de cobertura, dónde hay (Rolón Local · Mayorista · Alcorta en Rolón · cada local con Stock y Exhibición por separado) y venta perdida estimada por día (venta diaria promedio en $).
  - Orden: primero lo que se puede reponer **desde Rolón** (Rolón Local, Mayorista o Alcorta en Rolón), después lo que solo está en locales, y al final lo que no está en ningún lado (para recompra). Dentro de cada grupo, por venta perdida.
  - Supuesto de Claude, sin corregir: el stock de Mayorista se puede pasar a la web.
  - Decisión de Claude: lo que está en **Exhibición** cuenta como "está en un local". Si un producto solo está exhibido (sin unidades en el mini depósito), se marca "solo exhibición", y entra en "no está en ningún lado / recomprar" únicamente si tampoco hay exhibición.
- **Mucho stock, poca venta** (decisión de Claude, avisada): productos con stock total alto y cobertura muy larga (> 180 días al ritmo de las últimas 8 semanas, o sin ventas), ordenados por stock valorizado si hay costo disponible y si no por unidades. Sirve para empujarlos con pauta o con precio.
- **Stock por depósito**: tabla resumen por depósito (unidades, productos, unidades en exhibición) con la estructura de arriba, para entender "dónde está todo".

### Web

- **Venta web**: números de Odoo y facturación por día.
- **Comportamiento (GA4)**, reutilizando `eventBehavior.mjs` generalizado a cualquier rango:
  - sesiones, conversión, páginas y tiempo por sesión;
  - embudo (sesiones → vieron producto → carrito → compra);
  - fuentes con conversión;
  - celular contra compu;
  - nuevos contra recurrentes;
  - categorías vistas contra compradas;
  - productos con mucho interés y poca venta, más vistos y mejor conversión;
  - búsquedas;
  - páginas de entrada;
  - horas;
  - regiones.

  Comparación contra el período anterior y el año anterior donde los datos lo permiten (ver Verdades).
- **Experiencia (Clarity)**: rage clicks, clics muertos, quickbacks, scroll y tiempo activo, totales y por página, **para el período elegido** a partir de las fotos diarias. Link a Clarity para los mapas de calor.

### Locales

- **Los tres lado a lado**: facturación, tickets, ticket promedio, unidades por ticket, variaciones y % del total de locales.
- **Por día** (una línea o barra por local) y **por hora** (de la hora del pedido de POS).
- **Selector para entrar a un local**: más vendidos, categorías, origen, medios de pago y stock del local (mini depósito + exhibición). Lo que hoy muestra `LocalesPanel` se mantiene dentro de esta vista.

### Pauta

- **Meta y Google juntos**: inversión, valor atribuido, ROAS y costo por compra de cada uno y combinado. Google con y sin marca. Por día.
- **Mejores y peores anuncios de Meta** (lo que hoy está en la pestaña Meta Ads) y **campañas de Google**.
- Mismo criterio de atribución que hoy: Meta `1d_click`, Google por GA4 `google / cpc`.
- El ROAS de Google en los números principales (Pauta y el KPI del Resumen) es **total, incluida la búsqueda de marca**. Joaquín lo decidió así para el Cyber. El "sin marca" se muestra al lado, en Pauta.

### Mayorista

- Lo que hoy muestra `MayoristaPanel` (incluye "total cobrado" contra facturado), con el estilo nuevo, más feria adentro, desglosada por equipo de venta (las 6 ferias que se sumaron en agosto).

### Stock: siempre "a hoy" (decisión de Claude)

- Odoo y Tienda Nube solo dan el stock actual. Todo lo de stock (columnas, "Pasar a la web", "Mucho stock, poca venta", alerta) muestra **el stock de hoy** y se rotula así ("stock a hoy"), aunque el período elegido sea una semana pasada. Es lo accionable en la reunión.
- La venta que se usa para la cobertura cuenta **hacia atrás desde hoy** (4 semanas para la web, 8 para "mucho stock"), no desde el período elegido. La alerta de stock aparece en el Resumen en cualquier período, con el rótulo "a hoy".
- Desde la parte 1 se guarda además una **foto diaria del stock web** (Tienda Nube, por SKU, solo los que tienen venta o stock), para poder calcular más adelante cuántos días estuvo un producto en 0 y que la "venta perdida" sea real. Hasta tener historia, la venta perdida es una estimación (venta diaria promedio).

### Datos nuevos a guardar

- **Fotos diarias de Clarity** (Firestore `altorancho_reportes_clarity_daily`, un doc por día): totales y por página de las últimas 24 h, tomadas por un cron diario (una vez al día, 2 llamadas). **Esto se hace primero**, aunque las pantallas vengan después, para empezar a juntar historia.
  - Decisión de Claude sobre la cuota: el cron corre a las **00:05 hora Argentina** (la foto = el día anterior, aprox.) y, si falla, reintenta a las 06:00 y a las 12:00. Cada día cuenta con un registro de "ya tomada" para no repetir.
  - El panel de Clarity del Cyber (2 llamadas por carga, tope de 6 por día) se deja como está hasta que termine el evento (15/11). 6 + 2 del cron quedan por debajo de 10. Después del evento ese panel se va con la pestaña Cyber, y toda lectura de Clarity sale de las fotos, sin llamadas en vivo.
  - Las corridas locales no deben llamar a Clarity (el server local arranca sin `CLARITY_API_TOKEN`).
- **Stock por ubicación**: el sync de productos amplía `stockByLocation` con Exhibición y Alcorta en Rolón por separado, y excluye gift cards y envíos. Los nombres de las claves deben ser claros (`rolon`, `mayorista`, `web_odoo`, `alcorta_en_rolon`, `lomas_stock`, `lomas_exhibicion`, …).

### Estética

- Fondo blanco (`#fafafa` la página, `#fff` las tarjetas), tinta `#353434`, grises para lo secundario, bordes finos `#ececeb`, radios de ~14px y sin sombras pesadas.
- Etiquetas y estados de color: verde para suba o "bien", rojo para baja o problema, ámbar para stock, azul para web/info. Los colores de canal y local que ya existen (`frontend/src/lib/channels.js`) se mantienen para identificar canales.
- Números en `tabular-nums`; montos compactos ($412M, $321K) en tarjetas y completos en tooltips o tablas cuando hace falta.
- Gráficos: se pueden mantener con Recharts (ya está en el proyecto) pero restilados (sin grillas pesadas, ejes grises, tooltips limpios), o pasar a componentes propios donde sea más simple (barras CSS, como en el Cyber).
- Tiene que verse bien proyectado (la reunión) y en el celular (consultas sueltas).

## Construcción por partes

**Convivencia con el reporte actual** (decisión de Claude, avisada, Joaquín no eligió): el reporte nuevo vive en una **ruta aparte (`/nuevo`)** del mismo frontend y el mismo login, mientras el actual sigue intacto en `/`. Cuando estén listas las partes 1 a 3 (Resumen, Producto y Web), el nuevo pasa a `/` y el viejo queda un tiempo en `/viejo`. No hace falta "puente" de contenido viejo dentro del diseño nuevo: las pestañas nuevas sin construir muestran "Próximamente" con un link a la vista equivalente del reporte actual.

1. **Base + Resumen + fotos diarias (Clarity y stock web)**: shell nuevo (barra, pestañas, período en la URL, buscador), sistema de estilos nuevo y Resumen completo. Las pestañas que todavía no tienen versión nueva muestran el contenido actual.
2. **Producto y stock**: sync de stock ampliado y limpio, pestaña Producto completa, alerta "Pasar a la web".
3. **Web**: GA4 por rango y Clarity desde las fotos.
4. **Locales.**
5. **Pauta + Mayorista**: se elimina lo viejo (pestañas por local, Feria, Meta Ads sueltas).

Cada parte se verifica en vivo contra la fuente antes de entregar el build a Joaquín, que lo sube a mano a Hostinger.

## Lo que queda a criterio de quien construye

- Componentes, nombres y forma exacta de los endpoints (uno por pestaña, para que cada pestaña cargue rápido, es lo esperable).
- Si el buscador de producto abre un panel lateral o una página. Debe mostrar ventas por canal y por día en el período, stock por depósito, origen, categoría y, si aplica, vistas y % de compra en la web.
- Ajuste fino de umbrales de alertas, dejándolos en un solo lugar.
- Cache de GA4 por rango: los rangos pasados no cambian y se pueden cachear más tiempo.
