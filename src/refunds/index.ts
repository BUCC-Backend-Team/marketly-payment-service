import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool } from "../db/client.js";
import { paymentProvider, PaystackError } from "../providers/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createRefund(req: Request, res: Response) {
  const paymentId = req.params.id;
  const requested = req.body?.amount;
  const idempotencyKey = req.get("Idempotency-Key");

  if (typeof paymentId !== "string" || !UUID.test(paymentId)) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  if (!idempotencyKey || (requested !== undefined && (!Number.isInteger(requested) || requested <= 0))) {
    res.status(400).json({
      error: "Idempotency-Key is required, and amount must be a positive integer in kobo when provided",
    });
    return;
  }

  const requestHash = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
  const lockKey = `refund_create:${idempotencyKey}`;
  const client = await pool.connect();
  let locked = false;

  try {
    await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
    locked = true;
    await client.query("BEGIN");

    const existing = await client.query<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
      refund_id: string | null;
    }>(
      `SELECT request_hash, response_status, response_body, refund_id
       FROM idempotency_keys
       WHERE scope = 'refund_create' AND key = $1`,
      [idempotencyKey],
    );
    const saved = existing.rows[0];
    let refundId: string;
    let reference: string;
    let amount: number;
    let responseBody: { refundId: string; amount: number; status: "pending" };

    if (saved) {
      if (saved.request_hash !== requestHash) {
        await client.query("COMMIT");
        res.status(422).json({ error: "Idempotency key was already used with a different request" });
        return;
      }
      if (saved.response_status === 202) {
        await client.query("COMMIT");
        res.set("Idempotent-Replayed", "true").status(202).json(saved.response_body);
        return;
      }
      if (!saved.refund_id) throw new Error("Refund idempotency key has no refund");
      const refund = await client.query<{ amount: number; paystack_reference: string }>(
        `SELECT r.amount, p.paystack_reference
         FROM refunds r
         JOIN payments p ON p.id = r.payment_id
         WHERE r.id = $1`,
        [saved.refund_id],
      );
      const row = refund.rows[0];
      if (!row) throw new Error("Refund idempotency key has no refund");
      refundId = saved.refund_id;
      reference = row.paystack_reference;
      amount = row.amount;
      responseBody = saved.response_body as { refundId: string; amount: number; status: "pending" };
      await client.query("COMMIT");
    } else {
      const reserved = await reserveRefund(client, paymentId, requested, res);
      if (!reserved) {
        await client.query("ROLLBACK");
        return;
      }
      refundId = reserved.refundId;
      reference = reserved.reference;
      amount = reserved.amount;
      responseBody = { refundId, amount, status: "pending" };
      await client.query(
        `INSERT INTO idempotency_keys (key, scope, request_hash, response_status, response_body, payment_id, refund_id)
         VALUES ($1, 'refund_create', $2, 0, $3::jsonb, $4, $5)`,
        [idempotencyKey, requestHash, JSON.stringify(responseBody), reserved.paymentId, refundId],
      );
      await client.query("COMMIT");
    }

    let paystackRefundId: string;
    try {
      paystackRefundId = await paymentProvider.refund(reference, amount);
    } catch (err) {
      if (err instanceof PaystackError && err.status < 500) {
        await client.query("BEGIN");
        await client.query(`DELETE FROM idempotency_keys WHERE scope = 'refund_create' AND key = $1`, [
          idempotencyKey,
        ]);
        await client.query(`DELETE FROM refunds WHERE id = $1`, [refundId]);
        await client.query("COMMIT");
      }
      console.error(err);
      res.status(502).json({ error: "Could not start refund" });
      return;
    }

    await client.query("BEGIN");
    await client.query(
      `UPDATE refunds SET paystack_refund_id = $2, updated_at = now() WHERE id = $1`,
      [refundId, paystackRefundId],
    );
    await client.query(
      `UPDATE idempotency_keys
       SET response_status = 202, response_body = $2::jsonb
       WHERE scope = 'refund_create' AND key = $1`,
      [idempotencyKey, JSON.stringify(responseBody)],
    );
    await client.query("COMMIT");
    res.status(202).json(responseBody);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Could not create refund" });
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]).catch(() => {});
    }
    client.release();
  }
}

export async function handleRefundWebhook(req: Request, res: Response) {
  const event = req.body?.event as "refund.processed" | "refund.failed";
  const data = req.body?.data as { id?: number | string; transaction_reference?: string; reason?: string };
  if (data?.id == null) {
    res.status(200).json({ received: true });
    return;
  }

  const dedupKey = `${event}:${data.id}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO webhook_events (dedup_key, event_type, paystack_reference, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING id`,
      [dedupKey, event, data.transaction_reference ?? null, JSON.stringify(req.body)],
    );
    if (inserted.rowCount === 0) {
      await client.query("COMMIT");
      res.status(200).json({ received: true });
      return;
    }

    const updatedRefund = await client.query<{ id: string; payment_id: string; amount: number }>(
      `UPDATE refunds
       SET status = $2::refund_status,
           failure_reason = $3,
           updated_at = now()
       WHERE paystack_refund_id = $1 AND status = 'pending'
       RETURNING id, payment_id, amount`,
      [
        String(data.id),
        event === "refund.processed" ? "processed" : "failed",
        event === "refund.failed" ? data.reason || "Refund failed" : null,
      ],
    );
    const refund = updatedRefund.rows[0];
    if (!refund) {
      await client.query("COMMIT");
      res.status(200).json({ received: true });
      return;
    }

    const paymentResult =
      event === "refund.processed"
        ? await client.query<PaymentRow>(
            `UPDATE payments
             SET amount_refunded = amount_refunded + $2::int,
                 status = CASE
                   WHEN amount_refunded + $2::int = amount THEN 'refunded'::payment_status
                   ELSE 'partially_refunded'::payment_status
                 END,
                 updated_at = now()
             WHERE id = $1
             RETURNING id, order_id, status, amount, amount_refunded, currency, paid_late`,
            [refund.payment_id, refund.amount],
          )
        : await client.query<PaymentRow>(
            `SELECT id, order_id, status, amount, amount_refunded, currency, paid_late
             FROM payments WHERE id = $1`,
            [refund.payment_id],
          );
    const payment = paymentResult.rows[0];

    await client.query(
      `UPDATE webhook_events SET payment_id = $2, refund_id = $3 WHERE dedup_key = $1`,
      [dedupKey, payment.id, refund.id],
    );
    await enqueueRefundCallback(client, {
      type: event === "refund.processed" ? "payment.refunded" : "payment.refund_failed",
      payment,
      refundId: refund.id,
    });

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

async function reserveRefund(
  client: PoolClient,
  paymentId: string,
  amount: number | undefined,
  res: Response,
) {
  const payment = await client.query<{
    id: string;
    status: string;
    amount: number;
    amount_refunded: number;
    paystack_reference: string;
  }>(
    `SELECT id, status, amount, amount_refunded, paystack_reference
     FROM payments WHERE id = $1::uuid FOR UPDATE`,
    [paymentId],
  );
  const row = payment.rows[0];
  if (!row) {
    res.status(404).json({ error: "Payment not found" });
    return null;
  }
  if (row.status !== "succeeded" && row.status !== "partially_refunded") {
    res.status(409).json({ error: "not_refundable" });
    return null;
  }

  const pending = await client.query<{ reserved: number }>(
    `SELECT COALESCE(SUM(amount), 0)::int AS reserved
     FROM refunds WHERE payment_id = $1 AND status = 'pending'`,
    [row.id],
  );
  const available = row.amount - row.amount_refunded - pending.rows[0].reserved;
  const refundAmount = amount ?? available;
  if (refundAmount <= 0 || refundAmount > available) {
    res.status(409).json({ error: "not_refundable" });
    return null;
  }

  const refundId = randomUUID();
  await client.query(`INSERT INTO refunds (id, payment_id, amount) VALUES ($1, $2, $3)`, [
    refundId,
    row.id,
    refundAmount,
  ]);
  return { refundId, paymentId: row.id, reference: row.paystack_reference, amount: refundAmount };
}

type PaymentRow = {
  id: string;
  order_id: string;
  status: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  paid_late: boolean;
};

async function enqueueRefundCallback(
  client: PoolClient,
  input: { type: "payment.refunded" | "payment.refund_failed"; payment: PaymentRow; refundId: string },
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO callback_outbox (id, payment_id, refund_id, type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      id,
      input.payment.id,
      input.refundId,
      input.type,
      JSON.stringify({
        id,
        type: input.type,
        createdAt: new Date().toISOString(),
        data: {
          paymentId: input.payment.id,
          orderId: input.payment.order_id,
          status: input.payment.status,
          amount: input.payment.amount,
          amountRefunded: input.payment.amount_refunded,
          currency: input.payment.currency,
          late: input.payment.paid_late,
        },
      }),
    ],
  );
}
