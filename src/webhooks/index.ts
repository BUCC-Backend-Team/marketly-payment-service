import type { Request, Response } from "express";
import { enqueueSucceededCallback } from "../callbacks/index.js";
import { pool } from "../db/client.js";

type ChargeData = {
  id?: number | string;
  reference?: string;
  channel?: string;
  paid_at?: string;
};

export async function handlePaystackWebhook(req: Request, res: Response) {
  const data = req.body?.data as ChargeData | undefined;
  if (req.body?.event !== "charge.success" || data?.id == null || !data.reference) {
    res.status(200).json({ received: true });
    return;
  }

  const dedupKey = `charge.success:${data.id}`;
  const channel =
    data.channel === "card"
      ? "card"
      : data.channel === "bank" || data.channel === "bank_transfer"
        ? "bank_transfer"
        : null;

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
      [data.reference, channel, String(data.id), data.paid_at ?? null],
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
