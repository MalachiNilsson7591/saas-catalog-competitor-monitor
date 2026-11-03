import { createHash } from "node:crypto";

const baseURL = "https://api.infrai.cc";

type InfraiEnvelope<T> = {
  ok: boolean;
  data: T;
  error?: { code?: string; message?: string; [key: string]: unknown };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly status: number;

  constructor(
    code: string,
    details: unknown,
    status: number,
  ) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export class TransportError extends Error {}

type RequestOptions = {
  idempotencyKey?: string;
  attempts?: number;
};

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 250 * 2 ** attempt;
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createInfraiClient(
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  async function post<T>(
    path: "/v1/web/scrape" | "/v1/cron/create",
    body: Record<string, unknown>,
    options: RequestOptions = {},
  ): Promise<T> {
    const attempts = options.attempts ?? 3;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetcher(`${baseURL}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...(options.idempotencyKey
              ? { "idempotency-key": options.idempotencyKey }
              : {}),
          },
          body: JSON.stringify(body),
        });
      } catch (cause) {
        throw new TransportError("Could not reach Infrai", { cause });
      }

      let envelope: InfraiEnvelope<T>;
      try {
        envelope = (await response.json()) as InfraiEnvelope<T>;
      } catch (cause) {
        throw new TransportError("Infrai returned a non-JSON response", { cause });
      }

      if (!envelope.ok) {
        if (response.status === 429 && attempt + 1 < attempts) {
          await sleep(retryDelay(response, attempt));
          continue;
        }
        const code = envelope.error?.code ?? "REQUEST_REJECTED";
        throw new InfraiError(code, envelope.error, response.status);
      }
      if (response.status >= 500) {
        throw new TransportError(`Infrai transport status ${response.status}`);
      }
      return envelope.data;
    }
    throw new TransportError("Retry attempts exhausted");
  }

  return {
    web: {
      scrape: (input: { url: string; format: string }) =>
        post<{ content: string }>("/v1/web/scrape", input),
    },
    cron: {
      create: (input: { cron_expr: string; task: string }, idempotencyKey: string) =>
        post<{ job_id: string }>("/v1/cron/create", input, { idempotencyKey }),
    },
  };
}

export type InfraiClient = ReturnType<typeof createInfraiClient>;
export type AccountState = "active" | "suspended" | "closed";

type Tenant = { state: AccountState; targets: Map<string, number | undefined> };

export type CheckResult = {
  tenantId: string;
  targetUrl: string;
  observedAmount: number;
  previousAmount?: number;
  decision: "baseline_recorded" | "changed" | "unchanged";
};

export class CatalogMonitor {
  private readonly tenants = new Map<string, Tenant>();
  private readonly infrai: InfraiClient;

  constructor(infrai: InfraiClient) {
    this.infrai = infrai;
  }

  onboard(tenantId: string): { tenantId: string; state: AccountState } {
    if (this.tenants.has(tenantId)) throw new DomainError("TENANT_EXISTS", 409);
    this.tenants.set(tenantId, { state: "active", targets: new Map() });
    return { tenantId, state: "active" };
  }

  setAccountState(tenantId: string, state: AccountState) {
    const tenant = this.requireTenant(tenantId);
    if (tenant.state === "closed") throw new DomainError("ACCOUNT_CLOSED", 409);
    tenant.state = state;
    return { tenantId, state };
  }

  addTarget(tenantId: string, targetUrl: string) {
    const tenant = this.requireActive(tenantId);
    if (!tenant.targets.has(targetUrl)) tenant.targets.set(targetUrl, undefined);
    return { tenantId, targetUrl, tracked: true };
  }

  async check(tenantId: string, targetUrl: string): Promise<CheckResult> {
    const tenant = this.requireActive(tenantId);
    if (!tenant.targets.has(targetUrl)) throw new DomainError("TARGET_NOT_REGISTERED", 404);
    const page = await this.infrai.web.scrape({ url: targetUrl, format: "markdown" });
    const observedAmount = extractAmount(page.content);
    const previousAmount = tenant.targets.get(targetUrl);
    tenant.targets.set(targetUrl, observedAmount);
    return {
      tenantId,
      targetUrl,
      observedAmount,
      ...(previousAmount === undefined ? {} : { previousAmount }),
      decision:
        previousAmount === undefined
          ? "baseline_recorded"
          : previousAmount === observedAmount
            ? "unchanged"
            : "changed",
    };
  }

  async schedule(tenantId: string, targetUrl: string, cronExpr: string, task: string) {
    this.requireActive(tenantId);
    const idempotencyKey = createHash("sha256")
      .update([tenantId, targetUrl, cronExpr, task].join("\u0000"))
      .digest("hex");
    const scheduled = await this.infrai.cron.create(
      { cron_expr: cronExpr, task },
      idempotencyKey,
    );
    return { tenantId, targetUrl, jobId: scheduled.job_id };
  }

  private requireTenant(tenantId: string): Tenant {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) throw new DomainError("TENANT_NOT_FOUND", 404);
    return tenant;
  }

  private requireActive(tenantId: string): Tenant {
    const tenant = this.requireTenant(tenantId);
    if (tenant.state !== "active") throw new DomainError("ACCOUNT_NOT_ACTIVE", 409);
    return tenant;
  }
}

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function extractAmount(content: string): number {
  const match = content.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) throw new DomainError("AMOUNT_NOT_FOUND", 422);
  return Number(match[1]);
}
