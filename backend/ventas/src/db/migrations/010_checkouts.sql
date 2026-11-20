-- Checkouts abandonados de Tienda Nube (el checkout no corre el script de la tienda,
-- así que los traemos por la API). Si después compra con el mismo mail, queda "recuperado".
CREATE TABLE tn_checkouts (
  id bigint PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  contact_email text,
  total numeric(14,2),
  items int,
  products jsonb,          -- [{ product_id, name, quantity, price }]
  channel text,            -- de dónde vino la visita (mismas reglas que los pedidos)
  campaign text,
  province text,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tn_checkouts_created_idx ON tn_checkouts (created_at);
CREATE INDEX tn_checkouts_email_idx ON tn_checkouts (lower(contact_email));

CREATE INDEX order_items_product_idx ON order_items (product_id);
