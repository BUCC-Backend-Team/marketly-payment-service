import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { query } from "../db/client.js";

export async function createPayment(req: Request, res: Response) {
  const { order_id, amount, customer_email, return_url } = req.body ?? {};

  if (
    typeof order_id !== "string" ||
    !order_id ||
    typeof customer_email !== "string" ||
    !customer_email ||
    typeof return_url !== "string" ||
    !return_url ||
    !Number.isInteger(amount) ||
    amount <= 0
  ) {
    res.status(400).json({
      error:
        "order_id, amount (integer kobo), customer_email, and return_url are required",
    });
    return;
  }

  const id = randomUUID();

  try {
    await query(
      `INSERT INTO payments (id, order_id, amount, customer_email, return_url, paystack_reference)
       VALUES ($1::uuid, $2, $3, $4, $5, $1::text)`,
      [id, order_id, amount, customer_email, return_url],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "An active payment already exists for this order" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Could not create payment" });
    return;
  }

  try {
    const checkoutUrl = await startCheckout({
      email: customer_email,
      amount,
      reference: id,
      callbackUrl: return_url,
    });

    await query(
      `UPDATE payments SET checkout_url = $2, updated_at = now() WHERE id = $1`,
      [id, checkoutUrl],
    );

    res.status(201).json({
      id,
      order_id,
      amount,
      currency: "NGN",
      status: "pending",
      checkout_url: checkoutUrl,
    });
  } catch (err) {
    await query(`DELETE FROM payments WHERE id = $1`, [id]);
    console.error(err);
    res.status(502).json({ error: "Could not start checkout" });
  }
}

function isUniqueViolation(err: unknown) {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "23505"
  );
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
