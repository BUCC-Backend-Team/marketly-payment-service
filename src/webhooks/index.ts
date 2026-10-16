import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { enqueueSucceededCallback } from "../callbacks/index.js";
import { pool } from "../db/client.js";
import { handleRefundWebhook } from "../refunds/index.js";

type ChargeData = {
  id?: number | string;
  reference?: string;
  channel?: string;
  paid_at?: string;
};

export async function handlePaystackWebhook(req: Request, res: Response) {
  if (!hasValidSignature(req)) {
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  if (req.body?.event === "refund.processed" || req.body?.event === "refund.failed") {
    await handleRefundWebhook(req, res);
    return;
  }

  const data = req.body?.data as ChargeData | undefined;
  if (req.body?.event !== "charge.success" || data?.id == null || !data.reference) {
    res.status(200).json({ received: true });
    return;
  }

  const payment = await pool.query<{ amount: number; currency: string; status: string }>(
    `SELECT amount, currency, status FROM payments WHERE paystack_reference = $1`,
    [data.reference],
  );
  const row = payment.rows[0];
  let verified: VerifiedTransaction | undefined;
  if (row && (row.status === "pending" || row.status === "expired")) {
    try {
      verified = await verifyTransaction(data.reference);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not verify transaction" });
      return;
    }
    if (!transactionMatches(row, data.reference, data.id, verified)) {
      res.status(200).json({ received: true });
      return;
    }
  }

  const dedupKey = `charge.success:${data.id}`;
  const channelName = verified?.channel ?? data.channel;
  const channel =
    channelName === "card"
      ? "card"
      : channelName === "bank" || channelName === "bank_transfer"
        ? "bank_transfer"
        : null;
  const transactionId = String(verified?.id ?? data.id);
  const paidAt = verified?.paid_at ?? data.paid_at ?? null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO webhook_events (dedup_key, event_type, paystack_reference, payload)
       VALUES ($1, 'charge.success', $2, $3::jsonb)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [dedupKey, data.reference, JSON.stringify(req.body)],
    );

    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      res.status(200).json({ received: true });
      return;
    }

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
           paid_late = (status = 'expired'),
           updated_at = now()
       WHERE paystack_reference = $1
         AND status IN ('pending', 'expired')
       RETURNING id, order_id, amount, amount_refunded, currency, paid_late`,
      [data.reference, channel, transactionId, paidAt],
    );

    const payment = updated.rows[0];
    if (payment) {
      await client.query(
        `UPDATE webhook_events SET payment_id = $2 WHERE dedup_key = $1`,
        [dedupKey, payment.id],
      );
      await enqueueSucceededCallback(client, payment);
    }

    await client.query("COMMIT");
    res.status(200).json({ received: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Could not process webhook" });
  } finally {
    client.release();
  }
}

function hasValidSignature(req: Request) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.get("x-paystack-signature");
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!secret || !signature || !raw) return false;

  const expected = createHmac("sha512", secret).update(raw).digest("hex");
  const actual = Buffer.from(signature);
  const digest = Buffer.from(expected);
  if (actual.length !== digest.length) return false;
  return timingSafeEqual(actual, digest);
}

type VerifiedTransaction = {
  id?: number | string;
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  channel?: string;
  paid_at?: string;
};

function transactionMatches(
  payment: { amount: number; currency: string },
  reference: string,
  eventId: number | string,
  verified: VerifiedTransaction,
) {
  return (
    verified.status === "success" &&
    verified.reference === reference &&
    String(verified.id) === String(eventId) &&
    verified.amount === payment.amount &&
    verified.currency === payment.currency
  );
}

async function verifyTransaction(reference: string) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not set");

  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  const body = (await response.json()) as { status?: boolean; message?: string; data?: VerifiedTransaction };
  if (!response.ok || !body.status || !body.data) {
    throw new Error(body.message ?? "Paystack verify failed");
  }
  return body.data;
}
