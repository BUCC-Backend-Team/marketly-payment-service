import express from "express";

const app = express();
const port = Number(process.env.PORT);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Listening on ${port}`);
});