-- Portal schema: the portal's own commercial data (products, prices, users,
-- carts/quotes, audit). This never touches the existing stock source table -
-- stock is resolved at read time via a LEFT JOIN by normalized SKU, kept in
-- src/stock/stockRepository.js, never stored here.
--
-- Safe to re-run: every statement is idempotent (IF NOT EXISTS / DO blocks
-- that swallow duplicate_object). Review against a staging copy of
-- production before applying with scripts/run_migrations.js --apply.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA IF NOT EXISTS portal;

DO $$ BEGIN
  CREATE TYPE portal.user_role AS ENUM ('customer', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE portal.user_status AS ENUM ('pending', 'approved', 'rejected', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE portal.quote_status AS ENUM ('submitted','reviewing','quoted','accepted','rejected','expired','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE portal.price_tier AS ENUM ('pvp','one','four','eight');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE portal.price_state AS ENUM ('value','consult','hidden','unavailable','custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE portal.import_status AS ENUM ('started','validated','applied','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS portal.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub text NOT NULL UNIQUE,
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  avatar_url text,
  company_name text,
  cuit text,
  phone text,
  role portal.user_role NOT NULL DEFAULT 'customer',
  status portal.user_status NOT NULL DEFAULT 'pending',
  approved_at timestamptz,
  approved_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  rejection_reason text,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_users_status ON portal.users(status);

CREATE TABLE IF NOT EXISTS portal.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  ip_hash bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL,
  sku_normalized text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  brand text NOT NULL DEFAULT 'OTRAS MARCAS',
  category text NOT NULL DEFAULT 'Sin categoría',
  image_url text,
  publication_url text,
  note text,
  active boolean NOT NULL DEFAULT true,
  visible boolean NOT NULL DEFAULT true,
  allow_quote_out_of_stock boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 9999,
  created_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(sku)) > 0),
  CHECK (length(btrim(sku_normalized)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_portal_products_visible_sort ON portal.products(active, visible, sort_order);
CREATE INDEX IF NOT EXISTS idx_portal_products_brand ON portal.products(brand);
CREATE INDEX IF NOT EXISTS idx_portal_products_category ON portal.products(category);

CREATE TABLE IF NOT EXISTS portal.product_prices (
  product_id uuid NOT NULL REFERENCES portal.products(id) ON DELETE CASCADE,
  tier portal.price_tier NOT NULL,
  state portal.price_state NOT NULL DEFAULT 'value',
  amount numeric(18,2),
  currency char(3) NOT NULL DEFAULT 'ARS',
  custom_label text,
  updated_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, tier),
  CHECK (amount IS NULL OR amount >= 0),
  CHECK ((state = 'value' AND amount IS NOT NULL) OR state <> 'value'),
  CHECK ((state = 'custom' AND custom_label IS NOT NULL) OR state <> 'custom')
);

CREATE TABLE IF NOT EXISTS portal.catalog_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('web_app','google_sheet_csv','snapshot_json','snapshot_csv','manual')),
  source_label text,
  snapshot_sha256 char(64) NOT NULL,
  mode text NOT NULL CHECK (mode IN ('dry_run','apply','verify')),
  status portal.import_status NOT NULL DEFAULT 'started',
  rows_received integer NOT NULL DEFAULT 0,
  products_inserted integer NOT NULL DEFAULT 0,
  products_updated integer NOT NULL DEFAULT 0,
  products_unchanged integer NOT NULL DEFAULT 0,
  rows_rejected integer NOT NULL DEFAULT 0,
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (snapshot_sha256, mode)
);

CREATE TABLE IF NOT EXISTS portal.price_history (
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES portal.products(id) ON DELETE CASCADE,
  tier portal.price_tier NOT NULL,
  old_data jsonb,
  new_data jsonb,
  origin text NOT NULL CHECK (origin IN ('admin','legacy_import','bulk_import','migration','system')),
  actor_user_id uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  batch_id uuid REFERENCES portal.catalog_import_runs(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_price_history_product ON portal.price_history(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS portal.quote_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id uuid NOT NULL REFERENCES portal.users(id) ON DELETE RESTRICT,
  status portal.quote_status NOT NULL DEFAULT 'submitted',
  currency char(3) NOT NULL DEFAULT 'ARS',
  customer_notes text,
  admin_notes text,
  public_notes text,
  displayed_subtotal numeric(18,2) NOT NULL DEFAULT 0,
  quoted_subtotal numeric(18,2),
  discount numeric(18,2) NOT NULL DEFAULT 0,
  shipping numeric(18,2) NOT NULL DEFAULT 0,
  surcharge numeric(18,2) NOT NULL DEFAULT 0,
  tax numeric(18,2) NOT NULL DEFAULT 0,
  quoted_total numeric(18,2),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  quoted_at timestamptz,
  expires_at timestamptz,
  assigned_admin_id uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  external_idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal.quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_request_id uuid NOT NULL REFERENCES portal.quote_requests(id) ON DELETE CASCADE,
  product_id uuid REFERENCES portal.products(id) ON DELETE SET NULL,
  sku_snapshot text NOT NULL,
  product_name_snapshot text NOT NULL,
  brand_snapshot text,
  category_snapshot text,
  quantity integer NOT NULL CHECK (quantity > 0),
  pricing_tier portal.price_tier,
  displayed_price_snapshot jsonb NOT NULL,
  quoted_unit_price numeric(18,2),
  stock_status_at_submit text NOT NULL CHECK (stock_status_at_submit IN ('in_stock','low_stock','out_of_stock')),
  exact_stock_internal integer,
  price_changed_before_submit boolean NOT NULL DEFAULT false,
  line_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portal.quote_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_request_id uuid NOT NULL REFERENCES portal.quote_requests(id) ON DELETE CASCADE,
  revision_number integer NOT NULL,
  payload jsonb NOT NULL,
  created_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quote_request_id, revision_number)
);

CREATE TABLE IF NOT EXISTS portal.audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  request_id text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portal_audit_created ON portal.audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS portal.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_by uuid REFERENCES portal.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO portal.app_settings (key, value, description)
VALUES
  ('low_stock_threshold', '10'::jsonb, 'Maximum exact stock classified as low_stock'),
  ('allow_quote_out_of_stock', 'true'::jsonb, 'Allow tentative requests for products without stock'),
  ('client_exact_stock_visible', 'false'::jsonb, 'Must remain false in v1')
ON CONFLICT (key) DO NOTHING;
