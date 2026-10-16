import { config } from "../config/index.js";

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
  refund(transaction: string, amount: number): Promise<string>;
}

class PaystackProvider implements PaymentProvider {
  async initialize(input: {
    email: string;
    amount: number;
    reference: string;
    callbackUrl: string;
  }) {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: this.headers(),
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
    if (!response.ok || !body.status || !body.data?.authorization_url) {
      throw new Error(body.message ?? "Paystack request failed");
    }
    return body.data.authorization_url;
  }

  async verify(reference: string) {
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${config.paystackSecretKey}` } },
    );
    if (response.status >= 500) {
      throw new Error(`Paystack verify failed (${response.status})`);
    }
    const body = (await response.json()) as {
      status?: boolean;
      data?: VerifiedTransaction;
    };
    if (!response.ok || !body.status || !body.data) return null;
    return body.data;
  }

  async refund(transaction: string, amount: number) {
    const response = await fetch("https://api.paystack.co/refund", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ transaction, amount }),
    });
    const body = (await response.json()) as {
      status?: boolean;
      message?: string;
      data?: { id?: number | string };
    };
    if (!response.ok || !body.status || body.data?.id == null) {
      throw new Error(body.message ?? "Paystack refund failed");
    }
    return String(body.data.id);
  }

  private headers() {
    return {
      Authorization: `Bearer ${config.paystackSecretKey}`,
      "Content-Type": "application/json",
    };
  }
}

export const paymentProvider: PaymentProvider = new PaystackProvider();
