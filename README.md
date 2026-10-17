# Marketly Payment Service

Small backend that Marketly calls to start, check and refund payments. Paystack test mode is the gateway. There is no frontend.

## Setup

You need Node, Postgres, and a Paystack test account. `DATABASE_URL` can be local Postgres, self-hosted Postgres, or Supabase.

```bash
npm install
cp .env.example .env
```

Fill in `.env` and don't commit it. `PAYSTACK_SECRET_KEY` is the test secret key (`sk_test_...`).

`DATABASE_URL` is a Postgres connection string, for example `postgresql://user:password@localhost:5432/payments`. The app connects with SSL, so that server must accept SSL.

Generate `MERCHANT_API_KEY` and `CALLBACK_SECRET` (run this twice):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Apply the SQL files in `supabase/migrations` in filename order. Use the same database role the app connects as, so that role owns the tables:

```bash
psql "$DATABASE_URL" -f supabase/migrations/20261016201030_create_payment_service_schema.sql
psql "$DATABASE_URL" -f supabase/migrations/20261017065613_limit_active_payment_to_pending_and_succeeded.sql
```

On a linked Supabase project, `supabase db push` applies the same files.

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