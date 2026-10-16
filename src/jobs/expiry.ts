import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { enqueueSucceededCallback } from "../callbacks/index.js";
import { pool } from "../db/client.js";

type DuePayment = {
  id: string;
  order_id: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  paystack_reference: string;
};

type VerifiedTransaction = {
  id?: number | string;
  status?: string;
  amount?: number;
  currency?: string;
  channel?: string;
  paid_at?: string;
};

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
  const verified = await verifyTransaction(payment.paystack_reference);
  if (verified === undefined) return;

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

async function verifyTransaction(reference: string): Promise<VerifiedTransaction | null | undefined> {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not set");

  let response: Response;
  try {
    response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secret}` } },
    );
  } catch (err) {
    console.error(err);
    return undefined;
  }

  if (response.status >= 500) {
    console.error(`Paystack verify failed (${response.status})`);
    return undefined;
  }

  const body = (await response.json()) as { data?: VerifiedTransaction };
  return body.data ?? null;
}
