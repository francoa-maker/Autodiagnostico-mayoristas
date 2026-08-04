-- 0025_sales_management.sql
-- Inicio formal de la gestión comercial desde el panel.

ALTER TABLE portal.users
  ADD COLUMN IF NOT EXISTS salesperson_code text;

UPDATE portal.users SET salesperson_code = 'MRT'
WHERE lower(email::text) = 'm.vaistich@patagoniatools.com.ar' AND salesperson_code IS NULL;
UPDATE portal.users SET salesperson_code = 'FRA'
WHERE lower(email::text) = 'franco.a@patagoniatools.com.ar' AND salesperson_code IS NULL;
UPDATE portal.users SET salesperson_code = 'LFO'
WHERE lower(email::text) = 'l.fonte@patagoniatools.com.ar' AND salesperson_code IS NULL;
UPDATE portal.users SET salesperson_code = 'GDS'
WHERE lower(email::text) = 'guillermo.distasio@patagoniatools.com.ar' AND salesperson_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_salesperson_code
  ON portal.users (salesperson_code)
  WHERE salesperson_code IS NOT NULL;

ALTER TABLE portal.quote_requests
  ADD COLUMN IF NOT EXISTS sales_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS sales_started_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS salesperson_code_snapshot text,
  ADD COLUMN IF NOT EXISTS sales_delivery_terms text,
  ADD COLUMN IF NOT EXISTS sales_payment_terms_text text,
  ADD COLUMN IF NOT EXISTS sales_email_to text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sales_email_cc text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS sales_email_subject text,
  ADD COLUMN IF NOT EXISTS sales_email_body_html text,
  ADD COLUMN IF NOT EXISTS sales_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS sales_gmail_thread_id text;

CREATE INDEX IF NOT EXISTS idx_quote_sales_started_at
  ON portal.quote_requests (sales_started_at DESC)
  WHERE sales_started_at IS NOT NULL;

INSERT INTO portal.app_settings (key, value, description)
VALUES (
  'sales_management',
  '{
    "internalRecipients": [
      "tomas.dr@patagoniatools.com.ar",
      "andrea.villamizar@patagoniatools.com.ar",
      "m.vaistich@patagoniatools.com.ar",
      "guillermo.distasio@patagoniatools.com.ar",
      "info@patagoniatools.com.ar",
      "facturacion@patagoniatools.com.ar",
      "franco.a@patagoniatools.com.ar",
      "mercado@latitudessur.com",
      "cobranzas@patagoniatools.com.ar",
      "n.david@patagoniatools.com.ar"
    ]
  }'::jsonb,
  'Destinatarios internos obligatorios del inicio de gestión de venta'
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO portal.email_templates (key, subject, body_html, body_text, variables)
VALUES (
  'venta.iniciada',
  'GESTIÓN DE VENTA {{cliente}} · {{codigo_gestion}}',
  $html$
<p>Estimado/a {{cliente}},</p>
<p>Antes que nada, muchas gracias por contactarse con nosotros. A continuación le dejamos el detalle de la gestión comercial.</p>
<div style="white-space:pre-line"><strong>Detalle de productos:</strong><br>{{detalle_productos}}</div>
<p><strong>TOTAL: {{total}}</strong></p>
<p><strong>Plazo de entrega:</strong> <span data-sales-field="delivery">{{plazo_entrega}}</span><br>
<strong>Plazo de pago:</strong> <span data-sales-field="payment">{{plazo_pago}}</span></p>
<div style="white-space:pre-line"><strong>Datos de facturación:</strong><br>{{datos_fiscales}}</div>
<p>{{observaciones}}</p>
<p>Precios expresados en {{moneda}}. La operación queda sujeta a las condiciones indicadas en esta gestión.</p>
<p>Puede consultar el pedido y sus documentos desde el portal: {{link}}</p>
<p>Quedamos a su disposición por cualquier inquietud.</p>
<p>Saludos cordiales.<br>
<strong>{{vendedor_nombre}}</strong><br>
Código de vendedor: <strong>{{vendedor_codigo}}</strong><br>
Código de gestión: <strong>{{codigo_gestion}}</strong></p>
$html$,
  NULL,
  '["cliente","codigo_gestion","detalle_productos","total","plazo_entrega","plazo_pago","datos_fiscales","observaciones","moneda","link","vendedor_nombre","vendedor_codigo"]'::jsonb
)
ON CONFLICT (key) DO NOTHING;
