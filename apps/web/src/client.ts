import {
  AppError,
  createDemoApp,
  type AccountTransaction,
  type ConsolidatedView,
  type MeView,
  type Payment,
  type PaymentInput,
  type Person,
  type ServiceDefinition,
} from '@app-gn/core';

/** Ce dont l'interface a besoin, servi soit par l'API HTTP, soit par le noyau embarqué (mode démo). */
export interface AppGnClient {
  readonly mode: 'api' | 'embedded';
  persons(): Promise<Person[]>;
  me(personId: string): Promise<MeView>;
  overview(personId: string, spaceId: string): Promise<ConsolidatedView>;
  services(personId: string, spaceId: string): Promise<ServiceDefinition[]>;
  transactions(personId: string, spaceId: string, accountId: string): Promise<AccountTransaction[]>;
  payments(personId: string, spaceId: string): Promise<Payment[]>;
  pay(personId: string, spaceId: string, input: PaymentInput, idempotencyKey: string): Promise<Payment>;
  approve(personId: string, spaceId: string, paymentId: string): Promise<Payment>;
  reject(personId: string, spaceId: string, paymentId: string): Promise<Payment>;
}

export class ClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class HttpClient implements AppGnClient {
  readonly mode = 'api' as const;
  private readonly base: string;
  constructor(base: string) {
    this.base = base.replace(/\/$/, '');
  }

  private async call<T>(personId: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        ...(personId ? { authorization: `Bearer demo:${personId}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ClientError(payload.error ?? 'http_error', payload.message ?? `HTTP ${response.status}`);
    return payload as T;
  }

  persons() { return this.call<Person[]>(null, 'GET', '/v1/demo/persons'); }
  me(personId: string) { return this.call<MeView>(personId, 'GET', '/v1/me'); }
  overview(personId: string, spaceId: string) { return this.call<ConsolidatedView>(personId, 'GET', `/v1/spaces/${spaceId}/overview`); }
  services(personId: string, spaceId: string) { return this.call<ServiceDefinition[]>(personId, 'GET', `/v1/spaces/${spaceId}/services`); }
  transactions(personId: string, spaceId: string, accountId: string) {
    return this.call<AccountTransaction[]>(personId, 'GET', `/v1/spaces/${spaceId}/accounts/${accountId}/transactions?limit=8`);
  }
  payments(personId: string, spaceId: string) { return this.call<Payment[]>(personId, 'GET', `/v1/spaces/${spaceId}/payments`); }
  pay(personId: string, spaceId: string, input: PaymentInput, idempotencyKey: string) {
    return this.call<Payment>(personId, 'POST', `/v1/spaces/${spaceId}/payments`, input, { 'idempotency-key': idempotencyKey });
  }
  approve(personId: string, spaceId: string, paymentId: string) { return this.call<Payment>(personId, 'POST', `/v1/spaces/${spaceId}/payments/${paymentId}/approve`, {}); }
  reject(personId: string, spaceId: string, paymentId: string) { return this.call<Payment>(personId, 'POST', `/v1/spaces/${spaceId}/payments/${paymentId}/reject`, {}); }
}

class EmbeddedClient implements AppGnClient {
  readonly mode = 'embedded' as const;
  private readonly app = createDemoApp().app;

  private async run<T>(work: () => T | Promise<T>): Promise<T> {
    try {
      // Copie profonde : l'interface ne doit jamais tenir une référence vers l'état du noyau.
      return structuredClone(await work());
    } catch (error) {
      if (error instanceof AppError) throw new ClientError(error.code, error.message);
      throw error;
    }
  }

  persons() { return this.run(() => this.app.listPersons()); }
  me(personId: string) { return this.run(() => this.app.me(personId)); }
  overview(personId: string, spaceId: string) { return this.run(() => this.app.overview(personId, spaceId)); }
  services(personId: string, spaceId: string) { return this.run(() => this.app.services(personId, spaceId)); }
  transactions(personId: string, spaceId: string, accountId: string) { return this.run(() => this.app.transactions(personId, spaceId, accountId, 8)); }
  payments(personId: string, spaceId: string) { return this.run(() => this.app.listPayments(personId, spaceId)); }
  pay(personId: string, spaceId: string, input: PaymentInput, key: string) { return this.run(() => this.app.initiatePayment(personId, spaceId, input, key)); }
  approve(personId: string, spaceId: string, paymentId: string) { return this.run(() => this.app.approvePayment(personId, spaceId, paymentId)); }
  reject(personId: string, spaceId: string, paymentId: string) { return this.run(() => this.app.rejectPayment(personId, spaceId, paymentId)); }
}

export function createClient(): AppGnClient {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  return base ? new HttpClient(base === '/' ? '' : base) : new EmbeddedClient();
}
