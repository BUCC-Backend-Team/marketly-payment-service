import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { pool } from "../db/client.js";

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
  const client = await pool.connect();
  let inserted = false;

  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `payment_create:${idempotencyKey}`,
    ]);

    const existing = await client.query<{
      request_hash: string;
      response_status: number;
      response_body: unknown;
    }>(
      `SELECT request_hash, response_status, response_body
       FROM idempotency_keys
       WHERE scope = 'payment_create' AND key = $1`,
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

    const paymentId = randomUUID();
    await client.query(
      `INSERT INTO payments (id, order_id, amount, customer_email, return_url, paystack_reference)
       VALUES ($1::uuid, $2, $3, $4, $5, $1::text)`,
      [paymentId, orderId, amount, customerEmail, returnUrl],
    );
    inserted = true;

    const checkoutUrl = await startCheckout({
      email: customerEmail,
      amount,
      reference: paymentId,
      callbackUrl: returnUrl,
    });
    await client.query(
      `UPDATE payments SET checkout_url = $2, updated_at = now() WHERE id = $1`,
      [paymentId, checkoutUrl],
    );

    const responseBody = {
      paymentId,
      orderId,
      status: "pending",
      amount,
      currency: "NGN",
      checkoutUrl,
    };
    await client.query(
      `INSERT INTO idempotency_keys (key, scope, request_hash, response_status, response_body, payment_id)
       VALUES ($1, 'payment_create', $2, 201, $3::jsonb, $4)`,
      [idempotencyKey, requestHash, JSON.stringify(responseBody), paymentId],
    );
    await client.query("COMMIT");
    res.status(201).json(responseBody);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "payment_exists" });
      return;
    }
    console.error(err);
    if (!res.headersSent) {
      res.status(inserted ? 502 : 500).json({
        error: inserted ? "Could not start checkout" : "Could not create payment",
      });
    }
  } finally {
    client.release();
  }
}

function isUniqueViolation(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

async function startCheckout(input: {
  email: string;
  amount: number;
  reference: string;
  callbackUrl: string;
}) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) throw new Error("PAYSTACK_SECRET_KEY is not set");

  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      amount: input.amount,
      reference: input.reference,
      callback_url: input.callbackUrl,
      currency: "NGN",
    }),
  });

  const body = (await response.json()) as {
    status?: boolean;
    message?: string;
    data?: { authorization_url?: string };
  };

  if (!response.ok || !body.status || !body.data?.authorization_url) {
    throw new Error(body.message ?? "Paystack request failed");
  }

  return body.data.authorization_url;
}
