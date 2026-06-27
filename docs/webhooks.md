# Webhooks

## Overview

The webhook system delivers lifecycle events (e.g. `vault_created`, `vault_completed`, `vault_failed`, `vault_cancelled`) to registered subscriber URLs via HTTP POST with HMAC-SHA256 signature verification.

## Subscriber Management

Subscribers are stored in-memory (same pattern as API keys). Each subscriber has:

- `id` – UUID
- `url` – target endpoint
- `secret` – HMAC signing key
- `events` – event types to subscribe to (empty = wildcard)
- `active` – delivery flag

### SSRF Protection

`isUrlAllowed()` blocks loopback, link-local, and RFC-1918 addresses. If `WEBHOOK_ALLOWED_HOSTS` is set, the target hostname must also match.

## Delivery

`dispatchWebhookEvent()` sends a payload to all eligible active subscribers. Each delivery is retried with exponential backoff (max 3 attempts).

### Headers

| Header | Description |
|--------|-------------|
| `x-disciplr-signature` | `sha256=<hex-digest>` HMAC-SHA256 of the JSON body |
| `x-disciplr-event` | Event type (e.g. `vault_created`) |
| `x-disciplr-event-id` | Originating event ID in `{txHash}:{eventIndex}` format |
| `x-disciplr-delivery-timestamp` | ISO 8601 timestamp |

## Circuit Breaker

Each subscriber has an associated circuit breaker that isolates chronically failing endpoints so healthy deliveries are not delayed.

### States

| State | Behavior |
|-------|----------|
| **CLOSED** | Normal operation. Delivery proceeds. Failures increment a counter. |
| **OPEN** | All deliveries are short-circuited directly to the dead-letter queue. No HTTP requests are made. |
| **HALF_OPEN** | Exactly one probe request is allowed. Success transitions back to CLOSED; failure transitions to OPEN. |

### State Machine

```
CLOSED → (failure count ≥ threshold) → OPEN → (timeout elapses) → HALF_OPEN → (probe succeeds) → CLOSED
                                                                      → (probe fails) → OPEN
```

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `WEBHOOK_CIRCUIT_BREAKER_THRESHOLD` | `5` | Consecutive failures within the window needed to trip to OPEN |
| `WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS` | `60_000` | Sliding window (ms) for counting failures |
| `WEBHOOK_CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS` | `30_000` | Time (ms) before an OPEN breaker transitions to HALF_OPEN for a probe |

### Persistence

Breaker state is persisted in the `webhook_breaker_states` table and survives restarts. An in-memory cache is used at runtime; the cache is invalidated only on restart or via `resetBreakerCache()` (test helper).

### Metrics

Breaker state counts are exposed as Prometheus gauges at `/api/metrics`:

| Metric | Description |
|--------|-------------|
| `disciplr_webhook_breaker_closed` | Subscribers in CLOSED state |
| `disciplr_webhook_breaker_open` | Subscribers in OPEN state |
| `disciplr_webhook_breaker_half_open` | Subscribers in HALF_OPEN state |

## Dead-Letter Queue

When a delivery permanently fails (exhausts retries) or is short-circuited by an open breaker, the failed delivery is persisted to the `webhook_dead_letters` table for later inspection and replay.

### Schema

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `subscriber_id` | UUID | Subscriber that failed to receive |
| `event_id` | TEXT | Event ID (`{txHash}:{eventIndex}`) |
| `event_type` | VARCHAR(128) | Event type |
| `payload` | JSONB | Original delivery payload |
| `last_error` | TEXT | Last error message |
| `attempts` | INTEGER | Number of delivery attempts |
| `failed_at` | TIMESTAMPTZ | When the delivery permanently failed |
| `replayed_at` | TIMESTAMPTZ | When the entry was replayed (null if not yet) |

### Admin API

#### GET `/api/admin/webhooks/dead-letters`

List dead-letter entries with optional `subscriber_id` filter.

Query params: `limit`, `offset`, `subscriber_id`

Response:
```json
{
  "webhook_dead_letters": [...],
  "count": 10,
  "total": 42,
  "limit": 50,
  "offset": 0,
  "has_more": true
}
```

#### POST `/api/admin/webhooks/dead-letters/:id/replay`

Replays a dead-letter entry. Validates the URL is still allowed, then re-delivers to the subscriber's in-memory handler. Stamps `replayed_at` on success.

Response (202):
```json
{ "replayed": true }
```

Response (404):
```json
{ "error": "Dead letter not found or already replayed" }
```

## Test-Ping Endpoint

`POST /api/webhooks/:id/test` lets subscribers self-verify their delivery URL and HMAC wiring before real vault events start flowing.

### Authorization

- Caller must be authenticated (Bearer JWT).
- The subscriber must belong to the caller's organization (`enterpriseId` in the JWT must match `organizationId` on the subscriber). Cross-org pings return **403**.

### Rate Limiting

5 requests per subscriber per 60 seconds to prevent abuse as an SSRF probe.

### Request

```http
POST /api/webhooks/{subscriberId}/test
Authorization: Bearer <token>
```

No request body required.

### Response (200 — always returned for delivery attempts)

```json
{
  "delivered": true,
  "statusCode": 200,
  "latencyMs": 142,
  "signatureHeader": "sha256=<hex-digest>"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `delivered` | boolean | `true` if the subscriber returned 2xx |
| `statusCode` | number | HTTP status returned by the subscriber (present on delivery attempts) |
| `latencyMs` | number | Round-trip time in milliseconds |
| `signatureHeader` | string | The `x-disciplr-signature` value that was sent — use this to verify your HMAC code |
| `error` | string | Error description when `delivered: false` |

The subscriber's **secret is never returned** in the response. Use `signatureHeader` to confirm your HMAC implementation produces the same digest from the request body.

### Synthetic Payload

The test event uses the same versioned envelope (`buildVersionedPayload`) as real deliveries, so a passing test guarantees real deliveries will also verify. The event type is `webhook.test`.

Example v1 body:
```json
{
  "eventId": "test:<uuid>",
  "eventType": "webhook.test",
  "timestamp": "2026-06-28T00:00:00.000Z",
  "data": { "message": "This is a test delivery from Disciplr…" },
  "organizationId": "<your-org-id>",
  "schema_version": 1
}
```

### Error Cases

| HTTP Status | Condition |
|-------------|-----------|
| 401 | Missing or invalid Bearer token |
| 403 | Subscriber belongs to a different organization |
| 404 | Subscriber not found |
| 422 | Subscriber URL is blocked by the SSRF guard |
| 429 | Rate limit exceeded (5 pings/subscriber/minute) |
| 200 + `delivered: false` | Subscriber URL returned an error, timed out, or refused a redirect |

---

## Testing

Run webhook tests:
```bash
npm test -- --testPathPattern=webhooks
```

Run the test-ping tests specifically:
```bash
npm test -- src/tests/webhooks.testPing.test.ts
```

DLQ tests require a PostgreSQL database (`DATABASE_URL`). Without it, they are skipped gracefully.

---

# Webhook Delivery System

The webhook system delivers vault lifecycle events to registered HTTP endpoints. Subscribers are stored in PostgreSQL and scoped per organization.

## Storage Model

Webhook subscribers are stored in the `webhook_subscribers` table:

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` (PK, auto-generated) | Unique subscriber identifier |
| `organization_id` | `varchar(255)` | Owning organization (NOT NULL) |
| `url` | `varchar(2048)` | Target webhook URL |
| `secret` | `text` | Current HMAC signing secret |
| `previous_secret` | `text` (nullable) | Previous secret retained during rotation grace window |
| `rotated_at` | `timestamptz` (nullable) | When the most recent rotation occurred |
| `events` | `jsonb` | Array of event types to receive; empty array = wildcard (all events) |
| `active` | `boolean` | Whether the subscriber is active |
| `schema_version` | `integer` (default `1`) | Payload schema version (see Payload Schema Versioning) |
| `created_at` | `timestamptz` | Creation timestamp |
| `updated_at` | `timestamptz` | Last update timestamp |

Unique constraint: `(organization_id, url)` — only one active subscriber per org/URL pair.

## Secret Handling Decision

The `secret` column stores the HMAC signing secret in plaintext. Hashing is not viable because the raw secret is required to compute HMAC-SHA256 signatures for outgoing webhook requests.

**Recommendation for production:** Encrypt the secret at rest using one of:
- PostgreSQL `pgcrypto` extension (`pgp_sym_encrypt` / `pgp_sym_decrypt`)
- Application-level AES-256-GCM encryption before storage, with the encryption key managed via a secrets manager (AWS KMS, HashiCorp Vault)

The trade-off is that the encryption key must be available to the application at runtime to decrypt secrets for signing, which shifts the protection boundary from the database layer to the key management layer.

## Organization Isolation

All subscriber queries are scoped by `organization_id`. When dispatching events, only subscribers belonging to the same organization as the event source receive the delivery. This prevents cross-tenant information leakage.

## API

### `addSubscriber(organizationId, url, secret, events, schemaVersion = 1)`

Creates a new webhook subscriber. The URL is validated against the SSRF allowlist (`isUrlAllowed`). Returns the created subscriber.

`events` is an array of event type strings the subscriber wants to receive. An empty array (`[]`) acts as a wildcard and subscribes to all events. Each event type is validated against `KNOWN_EVENT_TYPES`; unknown types are rejected.

Optional `schemaVersion` selects the payload envelope version (default `1`). Must be a supported version (see Payload Schema Versioning).

### `KNOWN_EVENT_TYPES`

The set of all event types the system can produce:

```
vault_created, vault_completed, vault_failed, vault_cancelled,
milestone_created, milestone_validated, settlement_summary
```

### `upsertSubscriber(organizationId, url, secret, events)`

Idempotent alternative to `addSubscriber`. Re-registering the same `(organizationId, url)` pair updates the existing row in-place — no duplicate rows are created and delivery history (dead-letter entries keyed on the subscriber id) is preserved. The upsert is scoped to the calling org so a cross-org overwrite is impossible.

### `rotateSubscriberSecret(id, organizationId, newSecret)`

Rotates the signing secret for a subscriber:

1. The current `secret` is moved to `previous_secret`.
2. `newSecret` becomes the active `secret`.
3. `rotated_at` is stamped to `now()`.

The `previousSecret` remains valid for signature verification for the duration of the **grace window** (env `WEBHOOK_SECRET_GRACE_WINDOW_MS`, default **24 hours**). This lets receivers that haven't yet updated their expected secret continue to verify in-flight deliveries without interruption.

Returns `null` when the subscriber does not exist or the `organizationId` does not match (cross-org rotation is silently rejected to avoid enumeration).

### `verifySignatureWithGrace(subscriber, body, signature)`

Verifies a signature against a subscriber's **current** secret and, if within the grace window, also against the **previous** secret. Returns `true` if either matches. Use this instead of bare `verifySignature` wherever subscriber-scoped verification is needed (e.g., inbound callbacks that embed a subscriber ID).

### `isPreviousSecretInGrace(subscriber)`

Returns `true` when `previousSecret` is set and `Date.now() - rotatedAt < graceWindowMs`.

### `removeSubscriber(id)`

Deletes a subscriber by ID. Returns `true` if found.

### `listSubscribers(organizationId)`

Returns all active subscribers for an organization. **Secret material is never included in list responses.**

### `dispatchWebhookEvent(payload)`

Delivers an event to all eligible active subscribers for the organization specified in `payload.organizationId`. Outbound deliveries are always signed with the **current** secret. Uses exponential-backoff retry (max 3 attempts). Failures are collected per-subscriber.

---

## Secret Rotation Flow

```
Operator                      Disciplr API                  Subscriber
   |                               |                              |
   |-- POST /rotate-secret ------->|                              |
   |   { new_secret: "v2" }        |                              |
   |<-- 200 { rotated_at }---------|                              |
   |                               |                              |
   |                               |-- deliver (signed w/ v2) --->|
   |                               |   (subscriber may still      |
   |                               |    verify with v1 during     |
   |                               |    grace window)             |
   |   [ grace window: 24 h ]      |                              |
   |                               |                              |
   |   Subscriber updates its      |                              |
   |   expected secret to v2       |                              |
   |                               |-- deliver (signed w/ v2) --->|
   |                               |   (subscriber now verifies   |
   |                               |    with v2 exclusively)      |
```

Key properties:
- Outbound deliveries are **always signed with the current (new) secret** immediately after rotation.
- The previous secret is retained server-side for the grace window so receivers don't need to update instantaneously.
- After the grace window closes, `verifySignatureWithGrace` only accepts the current secret.
- Operators can tune the overlap duration via `WEBHOOK_SECRET_GRACE_WINDOW_MS`.

---

## Admin API Endpoints

### `POST /api/admin/webhooks/subscribers`

Idempotent upsert. Creates or updates a subscriber for the given `(organization_id, url)` pair.

**Body:**
```json
{
  "organization_id": "org-123",
  "url": "https://hooks.example.com/disciplr",
  "secret": "my-signing-secret",
  "events": ["vault_created", "vault_completed"]
}
```

**Response 200:**
```json
{
  "id": "uuid",
  "organization_id": "org-123",
  "url": "https://hooks.example.com/disciplr",
  "events": ["vault_created", "vault_completed"],
  "active": true,
  "created_at": "2026-06-27T13:00:00.000Z"
}
```

The secret is **never returned** in any response.

### `GET /api/admin/webhooks/subscribers?organization_id=<org>`

Lists active subscribers for an organization. Secret material is stripped.

### `POST /api/admin/webhooks/subscribers/:id/rotate-secret`

Rotates the signing secret. Previous secret is preserved in the grace window.

**Body:**
```json
{
  "organization_id": "org-123",
  "new_secret": "my-new-signing-secret"
}
```

**Response 200:**
```json
{
  "id": "uuid",
  "rotated_at": "2026-06-27T14:00:00.000Z"
}
```

**Response 404** – subscriber not found or belongs to a different org (identical to avoid enumeration).

---

## Payload Schema Versioning

Each subscriber selects a payload schema version (`schema_version`). The version determines the JSON envelope delivered to the subscriber's endpoint.

### Supported Versions

| Version | Envelope | Notes |
|---------|----------|-------|
| **1** (default) | `{ eventId, eventType, timestamp, data, organizationId, schema_version: 1 }` | Original shape — includes all fields from the internal payload with `schema_version` appended. |
| **2** | `{ schema_version: 2, event_type, data }` | Compact envelope. Omits `eventId`, `timestamp`, and `organizationId`. The event type key is `event_type` (snake_case). |

### Adding a Subscriber with a Specific Version

```typescript
// Defaults to version 1
await addSubscriber(orgId, url, secret, events)

// Explicit version 2
await addSubscriber(orgId, url, secret, events, 2)
```

### Delivery Behaviour

- The HTTP body delivered to the subscriber is the serialized versioned envelope.
- The `x-disciplr-signature` HMAC is computed over the versioned body, so the signature covers the full envelope.
- The `x-disciplr-event`, `x-disciplr-event-id`, and `x-disciplr-delivery-timestamp` headers are identical across all schema versions.

### Deprecation Policy

1. When a new schema version is introduced, the previous version enters **deprecated** status.
2. Deprecated versions remain functional for **90 days** after the successor version is marked stable.
3. During the deprecation window subscribers on the old version receive **warning** log lines on each delivery.
4. After the deprecation window expires the old version is **removed** and `addSubscriber` rejects it. Existing subscribers that still reference the removed version are downgraded to the earliest still-supported version and logged.
5. The `LATEST_SCHEMA_VERSION` constant always points to the current stable version.
6. The `SUPPORTED_SCHEMA_VERSIONS` set contains all versions that are neither removed nor deprecated.

---

## Outbound Webhooks
The Disciplr backend dispatches webhooks to subscribers when specific events occur. Subscribers can register to receive webhook deliveries for events such as `vault_created`, `vault_completed`, etc.

The outbound webhooks include signatures in headers which the subscriber can verify.

## Inbound Webhooks

When third-party providers (e.g., payment gateways) send webhook callbacks to our backend, we must ensure these callbacks are authentic, timely, and not replayed.

### Verification Flow

The inbound webhook endpoint uses the `webhookVerify` middleware to validate requests:
1. **Timestamp Check**: Ensures the request was generated recently.
2. **Replay Protection**: Stores a nonce combined with the timestamp. If the same nonce is seen again within the allowed time window, the request is rejected.
3. **Signature Verification**: Validates the HMAC-SHA256 signature calculated over the timestamp, nonce, and raw request body using a shared secret.

### Required Headers
Inbound webhook requests must include the following headers:
- `x-webhook-signature`: The HMAC-SHA256 signature in the format `sha256=<hex_digest>`.
- `x-webhook-timestamp`: A unix timestamp (in milliseconds) representing when the request was made.
- `x-webhook-nonce`: A unique string for the request.

### Calculating the Signature
The signature is generated as an HMAC-SHA256 digest of the following string:
`<timestamp>.<nonce>.<raw_body>`

Using the shared secret (`WEBHOOK_INBOUND_SECRET`):

```javascript
const crypto = require('crypto');

const secret = process.env.WEBHOOK_INBOUND_SECRET;
const timestamp = Date.now();
const nonce = crypto.randomUUID();
const rawBody = JSON.stringify(payload); // Ensure this matches exactly what is sent over the wire

const signatureString = `${timestamp}.${nonce}.${rawBody}`;
const digest = crypto.createHmac('sha256', secret).update(signatureString).digest('hex');
const signatureHeader = `sha256=${digest}`;
```
