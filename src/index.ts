import "dotenv/config";
import express from "express";
import { startCallbackWorker } from "./callbacks/index.js";
import { startExpiryJob } from "./jobs/expiry.js";
import { createPayment } from "./payments/index.js";
import { createRefund } from "./refunds/index.js";
import { handlePaystackWebhook } from "./webhooks/index.js";

const app = express();
const port = Number(process.env.PORT) || 4000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/payments", createPayment);
app.post("/payments/:id/refunds", createRefund);
app.post("/webhooks/paystack", handlePaystackWebhook);

app.listen(port, () => {
  console.log(`Listening on ${port}`);
  startCallbackWorker();
  startExpiryJob();
});