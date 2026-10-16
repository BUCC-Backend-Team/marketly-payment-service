import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool, query } from "../db/client.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createRefund(req: Request, res: Response) {
  const paymentId = req.params.id;
  const amount = req.body?.amount;
  const idempotencyKey = req.get("Idempotency-Key");

  if (typeof paymentId !== "string" || !UUID.test(paymentId)) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }
  if (!idempotencyKey || !Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({
      error: "Idempotency-Key header and amount (integer kobo) are required",
    });
    return;
  }

  const requestHash = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
    }>(
      `SELECT request_hash, response_status, response_body
       FROM idempotency_keys
       WHERE scope = 'refund_create' AND key = $1
       FOR UPDATE`,
      [idempotencyKey],
    );
    const saved = existing.rows[0];
    if (saved) {
      await client.query("COMMIT");
      if (saved.request_hash !== requestHash) {
        res.status(422).json({ error: "Idempotency key was already used with a different request" });
        return;
      }
      res.set("Idempotent-Replayed", "true").status(saved.response_status).json(saved.response_body);
      return;
    }

    const reserved = await reserveRefund(client, paymentId, amount, res);
    if (!reserved) {
      await client.query("ROLLBACK");
      return;
    }

    const responseBody = {
      id: reserved.refundId,
      payment_id: reserved.paymentId,
      amount,
      status: "pending",
    };
    await client.query(
      `INSERT INTO idempotency_keys (key, scope, request_hash, response_status, response_body, payment_id, refund_id)
       VALUES ($1, 'refund_create', $2, 201, $3::jsonb, $4, $5)`,
      [idempotencyKey, requestHash, JSON.stringify(responseBody), reserved.paymentId, reserved.refundId],
    );
    await client.query("COMMIT");

    try {
      const paystackRefundId = await createPaystackRefund(reserved.reference, amount);
      await query(
        `UPDATE refunds SET paystack_refund_id = $2, updated_at = now() WHERE id = $1`,
        [reserved.refundId, paystackRefundId],
      );
      res.status(201).json(responseBody);
    } catch (err) {
      await query(`DELETE FROM idempotency_keys WHERE scope = 'refund_create' AND key = $1`, [
        idempotencyKey,
      ]);
      await query(`DELETE FROM refunds WHERE id = $1`, [reserved.refundId]);
      console.error(err);
      res.status(502).json({ error: "Could not start refund" });
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Could not create refund" });
  } finally {
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

async function reserveRefund(client: PoolClient, paymentId: string, amount: number, res: Response) {
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
    res.status(409).json({ error: "Payment cannot be refunded" });
    return null;
  }

  const pending = await client.query<{ reserved: number }>(
    `SELECT COALESCE(SUM(amount), 0)::int AS reserved
     FROM refunds WHERE payment_id = $1 AND status = 'pending'`,
    [row.id],
  );
  const available = row.amount - row.amount_refunded - pending.rows[0].reserved;
  if (amount > available) {
    res.status(409).json({ error: "Refund amount exceeds the remaining balance" });
    return null;
  }

  const refundId = randomUUID();
  await client.query(`INSERT INTO refunds (id, payment_id, amount) VALUES ($1, $2, $3)`, [
    refundId,
    row.id,
    amount,
  ]);
  return { refundId, paymentId: row.id, reference: row.paystack_reference };
}

async function createPaystackRefund(transaction: string, amount: number) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not set");

  const response = await fetch("https://api.paystack.co/refund", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transaction, amount }),
  });
  const body = (await response.json()) as {
    status?: boolean;
    message?: string;
    data?: { id?: number | string };
  };
  if (!response.ok || !body.status || body.data?.id == null) {
    throw new Error(body.message ?? "Paystack refund failed");
  }
  return String(body.data.id);
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
