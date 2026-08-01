-- 0023_email_templates_queue.sql
-- Revertir: DROP TABLE portal.email_queue; DROP TABLE portal.email_templates.
CREATE TABLE IF NOT EXISTS portal.email_templates (
  key text PRIMARY KEY,
  subject text NOT NULL,
  body_html text NOT NULL,
  body_text text,
  variables jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal.email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text REFERENCES portal.email_templates(key) ON DELETE SET NULL,
  to_addrs text[] NOT NULL,
  cc_addrs text[] NOT NULL DEFAULT '{}',
  subject text NOT NULL,
  body text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  quote_request_id uuid REFERENCES portal.quote_requests(id) ON DELETE SET NULL,
  user_id uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_queue_pending
  ON portal.email_queue(scheduled_at, created_at)
  WHERE status = 'pending';

INSERT INTO portal.email_templates (key, subject, body_html, body_text, variables) VALUES
('cotizacion.enviada','Cotización {{client_code}} lista',
'<p>Estimado, antes que nada muchas gracias por contactarse con nosotros, a continuación le dejo la cotización final.</p><p>{{lineas}}</p><p><strong>TOTAL: {{total}}</strong></p><p>Plazo de entrega: {{plazo_entrega}}<br><strong>Plazo de pago: {{plazo_pago}}</strong></p><p><strong>Datos para Factura tipo {{tipo_factura}}:</strong><br>Razón Social: {{razon_social}}<br>CUIT: {{cuit}}</p><p>📌 <strong>Información importante:</strong></p><p>Precios expresados en Pesos Argentinos (ARS). En caso de una variación abrupta en la cotización del dólar oficial (Banco Nación), el precio se actualizará antes del vencimiento del plazo.<br>Facturación: Emitimos Factura A o B (IVA Exento / Consumidor Final).<br>Vigencia del presupuesto: {{vigencia_dias}} días a partir de la fecha.</p><p>Envíos disponibles:<br>📦 Andreani (a domicilio)</p><p>Formas de pago:<br>💵 Efectivo / Transferencia bancaria</p><p>Retiros en oficina: de 10:00 a 17:00 hs. 📍 IMPORTANTE: Coordinar previamente por email y esperar confirmación antes de asistir.</p><p>Ver el pedido en línea: {{link}}</p><p>Quedo a su disposición por cualquier inquietud.</p><p>Saludos cordiales.</p>',
NULL,'["client_code","lineas","total","plazo_entrega","plazo_pago","tipo_factura","razon_social","cuit","vigencia_dias","link"]'::jsonb),
('datos.bancarios','Datos bancarios y factura {{client_code}}',
'<p>Estimados,</p><p>Envío nuestros datos bancarios y adjunto la factura correspondiente.</p><p>{{bank_details}}</p><p>Podés subir el comprobante directamente desde el portal: {{link}}</p><p>Desde ya muchas gracias, ante cualquier otra duda estamos a su entera disposición.</p><p>Saludos,</p>',
NULL,'["client_code","bank_details","link"]'::jsonb),
('pago.acreditado','Pago acreditado {{client_code}}',
'<p>Estimados,</p><p>El pago se acreditó correctamente.</p><p>Saldo actualizado: {{saldo}} — {{link}}</p><p>Saludos,</p>',
NULL,'["client_code","saldo","link"]'::jsonb),
('saldo.recordatorio','Recordatorio de saldo {{client_code}}',
'<p>Estimados, buenas tardes. ¿Cómo están?</p><p>¿Hay alguna novedad respecto al pago del saldo pendiente {{saldo}}? El vencimiento es {{vencimiento}}.</p><p>Podés ver el detalle y subir el comprobante acá: {{link}}</p><p>Saludos.</p>',
NULL,'["client_code","saldo","vencimiento","link"]'::jsonb),
('cuenta.saldada','Cuenta saldada {{client_code}}',
'<p>Perfecto, cuenta saldada. Desde ya, muchísimas gracias.</p>',
NULL,'["client_code"]'::jsonb),
('pedido.abierto','Pedido abierto {{client_code}}',
'<p>Abrimos tu pedido del mes. Podés seguirlo en línea acá: {{link}}</p>',
NULL,'["client_code","link"]'::jsonb),
('orden.confirmada','Orden confirmada {{client_code}}',
'<p>La cotización fue aceptada y ya es una orden de venta.</p><p>Ver pedido: {{link}}</p>',
NULL,'["client_code","link"]'::jsonb),
('factura.emitida','Factura emitida {{client_code}}',
'<p>La factura de tu pedido ya está disponible.</p><p>{{bank_details}}</p><p>Ver pedido y documentos: {{link}}</p>',
NULL,'["client_code","bank_details","link"]'::jsonb),
('pedido.despachado','Pedido despachado {{client_code}}',
'<p>Tu pedido fue despachado.</p><p>Podés consultar el estado y los documentos acá: {{link}}</p>',
NULL,'["client_code","link"]'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO portal.app_settings (key, value, description) VALUES
('email_queue', '{"pollIntervalMs":15000,"maxAttempts":5,"reminderDays":3}'::jsonb, 'Configuración de la cola y recordatorios de correo'),
('certificate_expiry', '{"documentId":null,"expiresAt":null,"warningDays":30}'::jsonb, 'Certificado de exclusión de retenciones')
ON CONFLICT (key) DO NOTHING;
