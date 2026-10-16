import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { pool } from "../db/client.js";
import { paymentProvider } from "../providers/index.js";

export async function createPayment(req: Request, res: Response) {
  const { orderId, amount, currency, customerEmail, returnUrl } = req.body ?? {};
  const idempotencyKey = req.get("Idempotency-Key");

  if (
    !idempotencyKey ||
    typeof orderId !== "string" ||
    !orderId ||
    typeof customerEmail !== "string" ||
    !customerEmail ||
    typeof returnUrl !== "string" ||
    !returnUrl ||
    currency !== "NGN" ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    res.status(400).json({
      error:
        "orderId, amount (integer kobo), currency NGN, customerEmail, returnUrl, and Idempotency-Key are required",
    });
    return;
  }

  const requestHash = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
  const lockKey = `payment_create:${idempotencyKey}`;
  const client = await pool.connect();
  let locked = false;
  let paymentId: string | undefined;

  try {
    await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
    locked = true;
    await client.query("BEGIN");

    const existing = await client.query<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
      payment_id: string | null;
    }>(
      `SELECT request_hash, response_status, response_body, payment_id
       FROM idempotency_keys
       WHERE scope = 'payment_create' AND key = $1`,
      [idempotencyKey],
    );
    const saved = existing.rows[0];
    if (saved) {
      if (saved.request_hash !== requestHash) {
        await client.query("COMMIT");
        res.status(422).json({ error: "Idempotency key was already used with a different request" });
        return;
      }
      if (saved.response_status === 201) {
        await client.query("COMMIT");
        res.set("Idempotent-Replayed", "true").status(201).json(saved.response_body);
        return;
      }
      if (!saved.payment_id) throw new Error("Payment idempotency key has no payment");
      paymentId = saved.payment_id;
      await client.query("COMMIT");
    } else {
      paymentId = randomUUID();
      try {
        await client.query(
          `INSERT INTO payments (id, order_id, amount, customer_email, return_url, paystack_reference)
           VALUES ($1::uuid, $2, $3, $4, $5, $1::text)`,
          [paymentId, orderId, amount, customerEmail, returnUrl],
        );
        await client.query(
          `INSERT INTO idempotency_keys (key, scope, request_hash, response_status, response_body, payment_id)
           VALUES ($1, 'payment_create', $2, 0, $3::jsonb, $4)`,
          [idempotencyKey, requestHash, JSON.stringify({ paymentId }), paymentId],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        if (isUniqueViolation(err)) {
          res.status(409).json({ error: "payment_exists" });
          return;
        }
        throw err;
      }
    }

    const checkoutUrl = await paymentProvider.initialize({
      email: customerEmail,
      amount,
      reference: paymentId,
      callbackUrl: returnUrl,
    });
    const responseBody = {
      paymentId,
      orderId,
      status: "pending",
      amount,
      currency: "NGN",
      checkoutUrl,
    };
    await client.query("BEGIN");
    await client.query(
      `UPDATE payments SET checkout_url = $2, updated_at = now() WHERE id = $1`,
      [paymentId, checkoutUrl],
    );
    await client.query(
      `UPDATE idempotency_keys
       SET response_status = 201, response_body = $2::jsonb
       WHERE scope = 'payment_create' AND key = $1`,
      [idempotencyKey, JSON.stringify(responseBody)],
    );
    await client.query("COMMIT");
    res.status(201).json(responseBody);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(err);
    if (!res.headersSent) {
      res.status(paymentId ? 502 : 500).json({
        error: paymentId ? "Could not start checkout" : "Could not create payment",
      });
    }
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]).catch(() => {});
    }
    client.release();
  }
}

function isUniqueViolation(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getPayment(req: Request, res: Response) {
  const id = req.params.id;
  if (typeof id !== "string" || !UUID.test(id)) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  const result = await pool.query<{
    id: string;
    order_id: string;
    status: string;
    channel: string | null;
    amount: number;
    amount_refunded: number;
    currency: string;
    checkout_url: string | null;
  }>(
    `SELECT id, order_id, status, channel, amount, amount_refunded, currency, checkout_url
     FROM payments WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: "Payment not found" });
    return;
  }

  res.status(200).json({
    paymentId: row.id,
    orderId: row.order_id,
    status: row.status,
    channel: row.channel,
    amount: row.amount,
    amountRefunded: row.amount_refunded,
    currency: row.currency,
    checkoutUrl: row.checkout_url,
  });
}
