# Contracts: Accountability Vault — vault_id correlation

This project expects on-chain vault records to include a `vault_id` field that
corresponds to the backend `PersistedVault.id` (a UUID). The on-chain contract
should accept a `vault_id` (Symbol `vault_id`) in `create_vault` and persist it
in the Vault struct so emitted events can be correlated with off-chain rows.

Requirements for the contract:
- Accept `vault_id` as the first argument to `create_vault` (string/symbol).
- Persist `vault_id` in the Vault struct and include it in emitted events.
- Ensure the backend-generated UUID format is preserved (backend uses `randomUUID()`).

Notes for backend developers:
- `src/services/soroban.ts` builds the call args expecting `vaultId` first.
- `src/services/eventParser.ts` validates that incoming events include a
  `vaultId`/`vault_id` string that matches UUID format.

## Upgrading the Contract

For instructions on safely upgrading the accountability vault contract and migrating storage, see the [Contract Upgrade & Storage Migration Runbook](./runbooks/contract-upgrade.md).

## Soroban RPC endpoint pool

`src/services/soroban.ts` manages a health-aware pool of Soroban RPC
endpoints. Configure it with the following environment variables:

| Variable | Default | Description |
|---|---|---|
| `SOROBAN_RPC_URLS` | — | Comma-separated list of RPC endpoint URLs (preferred). |
| `SOROBAN_RPC_URL` | — | Single URL fallback (used when `SOROBAN_RPC_URLS` is absent). |
| `SOROBAN_RPC_FAILURE_THRESHOLD` | `3` | Consecutive per-endpoint failures before it is demoted to `down`. |
| `SOROBAN_RPC_PROBE_INTERVAL_MS` | `30000` | How often (ms) down endpoints are re-probed. |
| `SOROBAN_RPC_PROBE_TIMEOUT_MS` | `5000` | Per-probe HTTP timeout (ms). |

### Failover behaviour

1. Endpoints are ordered: `healthy → degraded → down`.
2. Each call tries endpoints in order. If a pre-send step (`getAccount`,
   `prepareTransaction`) fails with a network error after all per-call retries
   are exhausted, the endpoint is demoted and the next one is tried.
3. Once `sendTransaction` returns any response (even `ERROR`), the operation is
   **locked to that endpoint** — no failover after that point to prevent
   double-submission.
4. Down endpoints are re-probed every `SOROBAN_RPC_PROBE_INTERVAL_MS` via a
   lightweight `getHealth` JSON-RPC call. A successful probe promotes the
   endpoint back to `healthy`.

### Health surface

`GET /health/deep` includes a `sorobanRpcPool` array with one entry per
endpoint. URLs are masked to `protocol://host` to avoid leaking API keys.
The overall status degrades to `degraded` when any endpoint is `down`.
