import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { enqueueSucceededCallback } from "../callbacks/index.js";
import { config } from "../config/index.js";
import { pool } from "../db/client.js";
import { paymentProvider, type VerifiedTransaction } from "../providers/index.js";

type DuePayment = {
  id: string;
  order_id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  paystack_reference: string;
};

export function startExpiryJob() {
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    expirePayments(config.paymentTimeoutSeconds)
      .catch((err) => console.error(err))
      .finally(() => {
        running = false;
      });
  }, 1000);
}

async function expirePayments(timeoutSeconds: number) {
  const due = await pool.query<DuePayment>(
    `SELECT id, order_id, amount, amount_refunded, currency, paystack_reference
     FROM payments
     WHERE status = 'pending'
       AND created_at <= now() - ($1::int * interval '1 second')
     ORDER BY created_at
     LIMIT 20`,
    [timeoutSeconds],
  );

  for (const payment of due.rows) {
    await reconcile(payment);
  }
}

async function reconcile(payment: DuePayment) {
  let verified: VerifiedTransaction | null;
  try {
    verified = await paymentProvider.verify(payment.paystack_reference);
  } catch (err) {
    console.error(err);
    return;
  }

  const paid =
    verified?.status === "success" &&
    verified.amount === payment.amount &&
    verified.currency === payment.currency;

  if (verified?.status === "success" && !paid) {
    console.error(`Paystack amount does not match payment ${payment.id}`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (paid && verified) {
      const updated = await client.query<{
        id: string;
        order_id: string;
        amount: number;
        amount_refunded: number;
        currency: string;
        paid_late: boolean;
      }>(
        `UPDATE payments
         SET status = 'succeeded',
             channel = $2::payment_channel,
             paystack_transaction_id = $3,
             paid_at = COALESCE($4::timestamptz, now()),
             paid_late = false,
             updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING id, order_id, amount, amount_refunded, currency, paid_late`,
        [
          payment.id,
          paymentChannel(verified.channel),
          verified.id == null ? null : String(verified.id),
          verified.paid_at ?? null,
        ],
      );
      if (updated.rows[0]) await enqueueSucceededCallback(client, updated.rows[0]);
    } else {
      const updated = await client.query<{
        id: string;
        order_id: string;
        amount: number;
        amount_refunded: number;
        currency: string;
      }>(
        `UPDATE payments
         SET status = 'expired', expired_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING id, order_id, amount, amount_refunded, currency`,
        [payment.id],
      );
      const row = updated.rows[0];
      if (row) await enqueueExpiredCallback(client, row);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function paymentChannel(channel?: string) {
  if (channel === "card") return "card";
  if (channel === "bank" || channel === "bank_transfer") return "bank_transfer";
  return null;
}

async function enqueueExpiredCallback(
  client: PoolClient,
  payment: { id: string; order_id: string; amount: number; amount_refunded: number; currency: string },
) {
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

