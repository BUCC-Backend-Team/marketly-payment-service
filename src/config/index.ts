import "dotenv/config";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const paymentTimeoutSeconds = Number(process.env.PAYMENT_TIMEOUT_SECONDS);
if (!Number.isInteger(paymentTimeoutSeconds) || paymentTimeoutSeconds <= 0) {
  throw new Error("PAYMENT_TIMEOUT_SECONDS must be a positive integer");
}

export const config = {
  port: Number(process.env.PORT) || 4000,
  databaseUrl: required("DATABASE_URL"),
  paystackSecretKey: required("PAYSTACK_SECRET_KEY"),
  merchantApiKey: required("MERCHANT_API_KEY"),
  callbackUrl: required("CALLBACK_URL"),
  callbackSecret: required("CALLBACK_SECRET"),
  paymentTimeoutSeconds,
  testMode: process.env.TEST_MODE === "true",
};
