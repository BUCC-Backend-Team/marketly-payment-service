# Marketly Payment Service

Small backend that Marketly calls to start, check and refund payments. Paystack test mode is the gateway. There is no frontend. 

## Setup

You need Node, Postgres, and a Paystack test account.

```bash
npm install
cp .env.example .env
```

Fill in `.env` and don't commit it. `PAYSTACK_SECRET_KEY` is the test secret key (`sk_test_...`).

Generate `MERCHANT_API_KEY` and `CALLBACK_SECRET` (run this twice):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run the SQL files in `supabase/migrations` in order, or:

```bash
supabase db push
```

## Run

```bash
npm run dev
```

The server starts on port 4000. `GET /health` should return `{ "status": "ok" }`.

`npm run build` then `npm start` if you want to run the compiled version.

## Webhooks

Paystack can't reach localhost, so use a tunnel:

```bash
ngrok http 4000
```

Set the Paystack test webhook URL to `https://<your-ngrok-host>/webhooks/paystack`. Update it if ngrok gives you a new URL.

Test card: `4084 0840 8408 4081`, CVV `408`, any future expiry.