import type { Request } from "express";
import express from "express";
import { startCallbackWorker } from "./callbacks/index.js";
import { config } from "./config/index.js";
import { pool } from "./db/client.js";
import { startExpiryJob } from "./jobs/expiry.js";
import { createPayment, getPayment } from "./payments/index.js";
import { createRefund } from "./refunds/index.js";
import { handlePaystackWebhook } from "./webhooks/index.js";

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/webhooks/paystack", handlePaystackWebhook);

app.use((req, res, next) => {
  const expected = config.merchantApiKey;
  if (!expected || req.get("Authorization") !== `Bearer ${expected}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.post("/payments", createPayment);
app.get("/payments/:id", getPayment);
app.post("/payments/:id/refunds", createRefund);

app.post("/admin/reset", async (_req, res) => {
  if (!config.testMode) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    await pool.query(
      "TRUNCATE callback_outbox, webhook_events, idempotency_keys, refunds, payments",
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not reset" });
  }
});

app.listen(config.port, () => {
  console.log(`Listening on ${config.port}`);
  startCallbackWorker();
  startExpiryJob();
});