DROP INDEX IF EXISTS uniq_active_payment_per_order;

CREATE UNIQUE INDEX uniq_active_payment_per_order
  ON payments (order_id)
  WHERE status IN ('pending', 'succeeded');
