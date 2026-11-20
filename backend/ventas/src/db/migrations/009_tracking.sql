-- Recorrido completo de cada visitante (script propio en la tienda):
-- cada visita con su origen, lo que agregó al carrito, los checkouts y la compra.

-- Una visita = una sesión (se corta tras 30 min sin actividad o al llegar con otra campaña).
CREATE TABLE track_sessions (
  id text PRIMARY KEY,
  visitor_id text NOT NULL,
  started_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  channel text NOT NULL,
  source text,
  medium text,
  campaign text,
  content text,
  click_id text,          -- qué click id trajo (fbclid, gclid, epik...), no su valor
  referrer_host text,
  landing_path text,
  device text,
  pageviews int NOT NULL DEFAULT 0,
  product_views int NOT NULL DEFAULT 0,
  customer_id text        -- id de cliente de Tienda Nube si estaba logueado
);
CREATE INDEX track_sessions_visitor_idx ON track_sessions (visitor_id, started_at);
CREATE INDEX track_sessions_started_idx ON track_sessions (started_at);
CREATE INDEX track_sessions_customer_idx ON track_sessions (customer_id) WHERE customer_id IS NOT NULL;

-- Eventos dentro de una visita: add_to_cart, checkout, purchase, product_view
CREATE TABLE track_events (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL,
  visitor_id text NOT NULL,
  at timestamptz NOT NULL,
  type text NOT NULL,
  data jsonb
);
CREATE INDEX track_events_visitor_idx ON track_events (visitor_id, at);
CREATE INDEX track_events_type_idx ON track_events (type, at);

-- Qué visitante hizo cada pedido (lo manda la página de "gracias por tu compra")
CREATE TABLE track_order_links (
  order_id bigint PRIMARY KEY,
  visitor_id text NOT NULL,
  session_id text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX track_order_links_visitor_idx ON track_order_links (visitor_id);
