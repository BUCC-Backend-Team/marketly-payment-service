import { randomUUID } from "node:crypto";
import { pool } from "../db/client.js";

export function startExpiryJob() {
  const timeoutSeconds = Number(process.env.PAYMENT_TIMEOUT_SECONDS);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    console.error("PAYMENT_TIMEOUT_SECONDS is not set");
    return;
  }

  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    expirePayments(timeoutSeconds)
      .catch((err) => console.error(err))
      .finally(() => {
        running = false;
      });
  }, 1000);
}

async function expirePayments(timeoutSeconds: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const expired = await client.query<{
      id: string;
      order_id: string;
      amount: number;
      amount_refunded: number;
      currency: string;
    }>(
      `UPDATE payments
       SET status = 'expired', expired_at = now(), updated_at = now()
       WHERE status = 'pending'
         AND created_at <= now() - ($1::int * interval '1 second')
       RETURNING id, order_id, amount, amount_refunded, currency`,
      [timeoutSeconds],
    );

    for (const payment of expired.rows) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO callback_outbox (id, payment_id, type, payload)
         VALUES ($1, $2, 'payment.expired', $3::jsonb)`,
        [
          id,
          payment.id,
          JSON.stringify({
            id,
            type: "payment.expired",
            createdAt: new Date().toISOString(),
            data: {
              paymentId: payment.id,
              orderId: payment.order_id,
              status: "expired",
              amount: payment.amount,
              amountRefunded: payment.amount_refunded,
              currency: payment.currency,
              late: false,
            },
          }),
        ],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
