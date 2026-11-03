import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  CatalogMonitor,
  DomainError,
  InfraiError,
  TransportError,
  createInfraiClient,
} from "./catalog_monitor.ts";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("INFRAI_API_KEY is required");

const monitor = new CatalogMonitor(createInfraiClient(apiKey));
const tenantId = z.string().min(1).max(80);
const targetUrl = z.string().url();

const routes = {
  "/tenants/onboard": z.object({ tenantId }),
  "/accounts/state": z.object({
    tenantId,
    state: z.enum(["active", "suspended", "closed"]),
  }),
  "/admin/catalog/targets": z.object({ tenantId, targetUrl }),
  "/admin/catalog/check": z.object({ tenantId, targetUrl }),
  "/admin/checks/schedule": z.object({
    tenantId,
    targetUrl,
    cronExpr: z.string().min(5),
    task: z.string().url(),
  }),
} as const;

type Route = keyof typeof routes;

function send(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJson(request: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

createServer(async (request, response) => {
  if (request.method !== "POST" || !request.url || !(request.url in routes)) {
    send(response, 404, { error: "route_not_found" });
    return;
  }

  const route = request.url as Route;
  try {
    const input = await readJson(request);
    let result: unknown;
    switch (route) {
      case "/tenants/onboard": {
        const body = routes[route].parse(input);
        result = monitor.onboard(body.tenantId);
        break;
      }
      case "/accounts/state": {
        const body = routes[route].parse(input);
        result = monitor.setAccountState(body.tenantId, body.state);
        break;
      }
      case "/admin/catalog/targets": {
        const body = routes[route].parse(input);
        result = monitor.addTarget(body.tenantId, body.targetUrl);
        break;
      }
      case "/admin/catalog/check": {
        const body = routes[route].parse(input);
        result = await monitor.check(body.tenantId, body.targetUrl);
        break;
      }
      case "/admin/checks/schedule": {
        const body = routes[route].parse(input);
        result = await monitor.schedule(
          body.tenantId,
          body.targetUrl,
          body.cronExpr,
          body.task,
        );
        break;
      }
    }
    send(response, 200, { data: result });
  } catch (error) {
    if (error instanceof SyntaxError) {
      send(response, 400, { error: "invalid_json" });
    } else if (error instanceof z.ZodError) {
      send(response, 400, { error: "invalid_request", issues: error.issues });
    } else if (error instanceof DomainError) {
      send(response, error.status, { error: error.code });
    } else if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      send(response, status, { error: error.code, details: error.details });
    } else if (error instanceof TransportError) {
      send(response, 502, { error: "upstream_transport" });
    } else {
      send(response, 500, { error: "internal_error" });
    }
  }
}).listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`Catalog monitor listening on http://localhost:${process.env.PORT ?? 3000}`);
});
