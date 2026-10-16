import "dotenv/config";
import type { Request } from "express";
import express from "express";
import { startCallbackWorker } from "./callbacks/index.js";
import { startExpiryJob } from "./jobs/expiry.js";
import { createPayment, getPayment } from "./payments/index.js";
import { createRefund } from "./refunds/index.js";
import { handlePaystackWebhook } from "./webhooks/index.js";

const app = express();
const port = Number(process.env.PORT) || 4000;

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
  const expected = process.env.MERCHANT_API_KEY;
  if (!expected || req.get("Authorization") !== `Bearer ${expected}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.post("/payments", createPayment);
app.get("/payments/:id", getPayment);
app.post("/payments/:id/refunds", createRefund);

app.listen(port, () => {
  console.log(`Listening on ${port}`);
  startCallbackWorker();
  startExpiryJob();
});