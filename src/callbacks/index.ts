import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../db/client.js";

const MAX_ATTEMPTS = 6;

type SucceededPayment = {
  id: string;
  order_id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  paid_late: boolean;
};

export async function enqueueSucceededCallback(client: PoolClient, payment: SucceededPayment) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO callback_outbox (id, payment_id, type, payload)
     VALUES ($1, $2, 'payment.succeeded', $3::jsonb)`,
    [
      id,
      payment.id,
      JSON.stringify({
        id,
        type: "payment.succeeded",
        createdAt: new Date().toISOString(),
        data: {
          paymentId: payment.id,
          orderId: payment.order_id,
          status: "succeeded",
          amount: payment.amount,
          amountRefunded: payment.amount_refunded,
          currency: payment.currency,
          late: payment.paid_late,
        },
      }),
    ],
  );
}

export function startCallbackWorker() {
  const url = process.env.CALLBACK_URL;
  if (!url) {
    console.error("CALLBACK_URL is not set");
    return;
  }

  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    deliverDue(url)
      .catch((err) => console.error(err))
      .finally(() => {
        running = false;
      });
  }, 1000);
}

async function deliverDue(url: string) {
  const due = await pool.query<{ id: string; payload: unknown; attempts: number }>(
    `SELECT id, payload, attempts
     FROM callback_outbox
     WHERE status = 'pending' AND next_attempt_at <= now()
     ORDER BY next_attempt_at
     LIMIT 20`,
  );

  for (const row of due.rows) {
    await deliverCallback(url, row);
  }
}

async function deliverCallback(
  url: string,
  row: { id: string; payload: unknown; attempts: number },
) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(row.payload),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error((text || `Callback responded ${response.status}`).slice(0, 500));
    }

    await pool.query(
      `UPDATE callback_outbox
       SET status = 'delivered', delivered_at = now(), attempts = attempts + 1, last_attempt_at = now()
       WHERE id = $1`,
      [row.id],
    );
  } catch (err) {
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : "Callback failed";
    await pool.query(
      `UPDATE callback_outbox
       SET attempts = $2,
           last_error = $3,
           last_attempt_at = now(),
           status = CASE WHEN $2::int >= $4::int THEN 'failed'::callback_status ELSE 'pending'::callback_status END,
           next_attempt_at = now() + (power(2, $2::int - 1) * interval '1 second')
       WHERE id = $1`,
      [row.id, attempts, message.slice(0, 500), MAX_ATTEMPTS],
    );
  }
}
