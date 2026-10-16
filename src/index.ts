import "dotenv/config";
import express from "express";
import { createPayment } from "./payments.js";

const app = express();
const port = Number(process.env.PORT) || 4000;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/payments", createPayment);

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});