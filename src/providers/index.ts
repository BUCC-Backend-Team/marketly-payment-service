import { config } from "../config/index.js";

const ATTEMPTS = 4;

export class PaystackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type VerifiedTransaction = {
  id?: number | string;
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  channel?: string;
  paid_at?: string;
};

export interface PaymentProvider {
  initialize(input: {
    email: string;
    amount: number;
    reference: string;
    callbackUrl: string;
  }): Promise<string>;
  verify(reference: string): Promise<VerifiedTransaction | null>;
  refund(transaction: string, amount: number, usedIds?: string[]): Promise<string>;
}

class PaystackProvider implements PaymentProvider {
  async initialize(input: {
    email: string;
    amount: number;
    reference: string;
    callbackUrl: string;
  }) {
    return withRetry(async () => {
      const response = await this.request("/transaction/initialize", {
        method: "POST",
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
      if (body.data?.authorization_url) return body.data.authorization_url;
      throw new PaystackError(body.message ?? "Paystack request failed", response.status);
    });
  }

  async verify(reference: string) {
    return withRetry(async () => {
      const response = await this.request(
        `/transaction/verify/${encodeURIComponent(reference)}`,
      );
      if (response.status >= 500) {
        throw new PaystackError(`Paystack verify failed (${response.status})`, response.status);
      }
      const body = (await response.json()) as {
        status?: boolean;
        data?: VerifiedTransaction;
      };
      if (!response.ok || !body.status || !body.data) return null;
      return body.data;
    });
  }

  async refund(transaction: string, amount: number, usedIds: string[] = []) {
    return withRetry(async () => {
      try {
        return await this.requestRefund(transaction, amount);
      } catch (err) {
        const existing = await this.findRefund(transaction, amount, usedIds).catch((lookupErr) => {
          console.error(lookupErr);
          return null;
        });
        if (existing) return existing;
        throw err;
      }
    });
  }

  private async requestRefund(transaction: string, amount: number) {
    const response = await this.request("/refund", {
      method: "POST",
      body: JSON.stringify({ transaction, amount }),
    });
    const body = (await response.json()) as {
      status?: boolean;
      message?: string;
      data?: { id?: number | string };
    };
    if (!response.ok || !body.status || body.data?.id == null) {
      throw new PaystackError(body.message ?? "Paystack refund failed", response.status);
    }
    return String(body.data.id);
  }

  private async findRefund(transaction: string, amount: number, usedIds: string[]) {
    const response = await this.request(
      `/refund?reference=${encodeURIComponent(transaction)}&perPage=50`,
    );
    if (response.status >= 500) {
      throw new PaystackError(`Paystack refund lookup failed (${response.status})`, response.status);
    }
    const body = (await response.json()) as {
      data?: Array<{
        id?: number | string;
        amount?: number;
        status?: string;
        merchant_note?: string | null;
        customer_note?: string | null;
        transaction?: { reference?: string } | number;
      }>;
    };
    const match = body.data?.find((row) => {
      const id = row.id == null ? "" : String(row.id);
      if (!id || usedIds.includes(id) || row.status === "failed" || Number(row.amount) !== amount) {
        return false;
      }
      const reference = typeof row.transaction === "object" ? row.transaction?.reference : undefined;
      if (reference) return reference === transaction;
      if (row.merchant_note != null || row.customer_note != null) {
        return `${row.merchant_note ?? ""} ${row.customer_note ?? ""}`.includes(transaction);
      }
      return true;
    });
    return match?.id == null ? null : String(match.id);
  }

  private request(path: string, init?: RequestInit) {
    return fetch(`https://api.paystack.co${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.paystackSecretKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || attempt === ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
  throw last;
}

function isRetryable(err: unknown) {
  if (err instanceof PaystackError) return err.status >= 500;
  return true;
}

export const paymentProvider: PaymentProvider = new PaystackProvider();
