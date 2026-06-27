# GraphQL API

The GraphQL read endpoint is exposed at `/api/graphql`.

## Guardrails

To reduce denial-of-service risk from abusive read queries, the endpoint rejects
queries that exceed either of these budgets:

- Maximum depth: `4`
- Maximum complexity: `12`

Queries that exceed either limit return `400 Bad Request` with an error payload
that identifies the breached limit in `error.details`.

## Introspection

Lightweight introspection via `__typename` is supported as long as the request
stays within the configured depth and complexity budgets.
