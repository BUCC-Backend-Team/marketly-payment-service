CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE payment_status AS ENUM (
  'pending',
  'succeeded',
  'expired',
  'partially_refunded',
  'refunded'
);

CREATE TYPE refund_status AS ENUM (
  'pending',
  'processed',
  'failed'
);

CREATE TYPE payment_channel AS ENUM (
  'card',
  'bank_transfer'
);

CREATE TYPE callback_type AS ENUM (
  'payment.succeeded',
  'payment.expired',
  'payment.refunded',
  'payment.refund_failed'
);

CREATE TYPE callback_status AS ENUM (
  'pending',
  'delivered',
  'failed'
);

CREATE TYPE idempotency_scope AS ENUM (
  'payment_create',
  'refund_create'
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  amount_refunded integer NOT NULL DEFAULT 0 CHECK (amount_refunded >= 0),
  currency varchar(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status payment_status NOT NULL DEFAULT 'pending',
  channel payment_channel,
  customer_email text NOT NULL,
  return_url text NOT NULL,
  checkout_url text,
  paystack_reference text NOT NULL,
  paystack_transaction_id text,
  paid_at timestamptz,
  expired_at timestamptz,
  paid_late boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT payments_amount_refunded_lte_amount
    CHECK (amount_refunded <= amount),
  CONSTRAINT payments_paystack_reference_unique
    UNIQUE (paystack_reference)
);

CREATE UNIQUE INDEX uniq_active_payment_per_order
  ON payments (order_id)
  WHERE status IN (
    'pending',
    'succeeded',
    'partially_refunded',
    'refunded'
  );

CREATE INDEX idx_payments_status_created
  ON payments (status, created_at);

CREATE INDEX idx_payments_order_id
  ON payments (order_id);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments (id),
  amount integer NOT NULL CHECK (amount > 0),
  status refund_status NOT NULL DEFAULT 'pending',
  paystack_refund_id text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_refunds_payment_id ON refunds (payment_id);
CREATE INDEX idx_refunds_paystack_refund_id ON refunds (paystack_refund_id);

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  scope idempotency_scope NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  payment_id uuid REFERENCES payments (id),
  refund_id uuid REFERENCES refunds (id),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uniq_idempotency_scope_key UNIQUE (scope, key)
);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedup_key text NOT NULL,
  event_type text NOT NULL,
  paystack_reference text,
  payment_id uuid REFERENCES payments (id),
  refund_id uuid REFERENCES refunds (id),
  payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT webhook_events_dedup_key_unique UNIQUE (dedup_key)
);

CREATE INDEX idx_webhook_events_payment_id ON webhook_events (payment_id);

CREATE TABLE callback_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments (id),
  refund_id uuid REFERENCES refunds (id),
  type callback_type NOT NULL,
  payload jsonb NOT NULL,
  status callback_status NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_due
  ON callback_outbox (status, next_attempt_at);

CREATE INDEX idx_callback_outbox_payment_id
  ON callback_outbox (payment_id);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE callback_outbox ENABLE ROW LEVEL SECURITY;