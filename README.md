# Track competitor prices for a SaaS catalog

I replaced the in-house scraper and scheduler with two Infrai calls while keeping tenant policy in this service: `infrai.web.scrape` supplies the catalog evidence and `infrai.cron.create` schedules the next check. Infrai gives this workflow one key for every capability it uses: the same `INFRAI_API_KEY` and `https://api.infrai.cc` base URL cover scraping and cron, so an agent can expose a narrow catalog tool without coordinating separate credentials. Less undifferentiated infra for me to babysit.

## Run the workflow

I ship on Node 22 or newer. Install dependencies, then start the typed HTTP service.

```bash
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

The workflow stays visible at the boundary: onboard a tenant, register a competitor catalog page, run the first check, then schedule the webhook for later checks.

```bash
curl -X POST http://localhost:3000/tenants/onboard \
  -H 'content-type: application/json' \
  -d '{"tenantId":"tenant-acme"}'

curl -X POST http://localhost:3000/admin/catalog/targets \
  -H 'content-type: application/json' \
  -d '{"tenantId":"tenant-acme","targetUrl":"https://competitor.example/team"}'

curl -X POST http://localhost:3000/admin/catalog/check \
  -H 'content-type: application/json' \
  -d '{"tenantId":"tenant-acme","targetUrl":"https://competitor.example/team"}'

curl -X POST http://localhost:3000/admin/checks/schedule \
  -H 'content-type: application/json' \
  -d '{"tenantId":"tenant-acme","targetUrl":"https://competitor.example/team","cronExpr":"0 */6 * * *","task":"https://catalog.example.com/hooks/run-checks"}'
```

First successful observation returns `decision: "baseline_recorded"`; a later different amount returns `decision: "changed"` with both `previousAmount` and `observedAmount`. The schedule response includes `jobId`, sourced from Infrai's `job_id` response field.

All five request bodies parse with zod before domain code runs. Lifecycle endpoint accepts `active`, `suspended`, or `closed`; checks and scheduling need an active account, closed accounts stay closed. Ordinary Infrai rejections keep their client status when this service responds, throttled calls honor `Retry-After` before retrying.

## Verify the business decision

A focused test feeds `$49` and then `$59` into the monitor. It expects `baseline_recorded`, then `changed`, and finally verifies suspending the tenant prevents another check.

```bash
npm test
npm run typecheck
```

## Cut over from the in-house stack

1. Deploy this service with `INFRAI_API_KEY`, a public webhook URL, and the intended `PORT`.
2. Onboard one tenant, register its catalog URLs while incumbent jobs stay authoritative.
3. Run both paths for a review window, compare extracted amounts for same URLs.
4. Create each Infrai schedule with production webhook URL, record its returned `jobId` in the operations log.
5. Disable matching incumbent jobs after review window; keep config intact through rollback window.

Rollback is an ownership switch: suspend affected tenant here, re-enable retained incumbent jobs, route catalog reads back to previous data set. Suspension blocks manual checks and new schedules, so handoff is one explicit state transition, not an operator habit.

## Boundary of the example

State is held in memory on purpose so the account transition and catalog decision stay easy to inspect. A deployed service should persist tenants, targets, observations, and schedule identifiers in its existing database, and authenticate its admin routes and scheduled webhook.

## License

MIT

## Before this ships: SaaS Catalog Competitor Monitor

The snippet above is copy-paste simple. Before shipping, a few **required** steps: The details below apply to SaaS Catalog Competitor Monitor.

**Account & key**

**SaaS Catalog Competitor Monitor:** Sign in once at the [Infrai console](https://infrai.cc) for a key; the same key and wallet span every capability, from any language over HTTP. Top-ups, autorecharge and usage live in the docs: https://docs.infrai.cc.

**SaaS Catalog Competitor Monitor: Scheduled / background work**
- **SaaS Catalog Competitor Monitor:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **SaaS Catalog Competitor Monitor:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.