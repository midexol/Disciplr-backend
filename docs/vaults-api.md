# Vaults API Validation and Payload Contracts

This document describes the expected request shape for `POST /api/vaults` and the validation constraints enforced by the server.

## Request body

`POST /api/vaults`

- `amount`: string or number; must be a positive number between `1` and `1,000,000,000` inclusive.
  - Rejects: `0`, negative numbers, non-numeric strings, `Infinity`, `NaN`
  - Accepts: numeric values via preprocessing (e.g., `1000`)
- `startDate`: valid ISO timestamp string.
  - Rejects: invalid dates, malformed formats, non-string types
- `endDate`: valid ISO timestamp string; must be strictly after `startDate`.
  - Rejects: dates equal to or before `startDate`
- `verifier`: valid Stellar public key (`G` + 55 Base32 characters).
  - Format: `G[A-Z2-7]{55}`
  - Rejects: invalid characters, wrong length, wrong prefix, non-string types
- `destinations`: object containing:
  - `success`: valid Stellar public key.
  - `failure`: valid Stellar public key.
- `milestones`: array of milestone objects.
  - Minimum: `1` milestone.
  - Maximum: `20` milestones.
  - Total milestone amounts must not exceed vault amount.

### Milestone object

Each milestone must include:

- `title`: non-empty string (whitespace-only strings are rejected).
- `dueDate`: valid ISO timestamp string that is not before `startDate`.
  - Can be equal to `startDate`
- `amount`: string or number; must be a positive number within the same vault bounds.

## Boundary Conditions and Edge Cases

### Amount Validation

- **Minimum**: `1` (inclusive)
- **Maximum**: `1,000,000,000` (inclusive)
- **Rejected values**: `0`, negative numbers, `Infinity`, `NaN`, non-numeric strings
- **Accepted preprocessing**: Numbers are converted to strings automatically

### Timestamp Validation

- **Format**: ISO 8601 with timezone (e.g., `2030-01-01T00:00:00.000Z`)
- **Date relationship**: `endDate` must be strictly greater than `startDate`
- **Milestone constraint**: `dueDate` must be greater than or equal to `startDate`
- **Edge case**: `endDate` can be exactly 1 millisecond after `startDate`

### Stellar Address Validation

- **Pattern**: `G[A-Z2-7]{55}` (Stellar G-address format)
- **Invalid characters**: `0`, `1`, `8`, `9`, lowercase letters
- **Length**: Exactly 56 characters (including `G` prefix)
- **Prefix**: Must start with `G`

### Milestone Array Validation

- **Minimum length**: `1`
- **Maximum length**: `20`
- **Amount constraint**: Sum of all milestone amounts ≤ vault amount
- **Date constraint**: Each milestone `dueDate` ≥ `startDate`

## Error formatting

Validation failures are returned with status `400` and the standard error envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request payload",
    "fields": [
      {
        "path": "amount",
        "message": "must be a positive number",
        "code": "custom"
      },
      {
        "path": "milestones[0].dueDate",
        "message": "must be a valid ISO timestamp",
        "code": "custom"
      }
    ]
  }
}
```

Field paths are stable and use bracket notation for arrays (for example: `milestones[1].dueDate`). Error messages are specific to each validation rule.

## Payload size limits

The server enforces a maximum JSON body size of `100kb` for all incoming requests. Requests above this threshold will return `413 Payload Too Large` with the following error envelope:

```json
{
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "Payload too large"
  }
}
```

## Security constraints

### Input Validation

- **Type safety**: All required fields reject `null`, `undefined`, and incorrect types
- **Format validation**: Stellar addresses are validated against strict regex patterns
- **Bounds checking**: All numeric inputs are validated against minimum/maximum constraints
- **Array limits**: Milestone arrays are capped to prevent DoS via large payloads

### Overflow Protection

- **Integer bounds**: Amount values are checked against safe integer limits
- **Memory safety**: Large string values are handled gracefully without causing memory exhaustion
- **Nested structure limits**: Milestone array size is capped to prevent exponential complexity

### Error Information Disclosure

- **Consistent formatting**: Error messages don't leak internal implementation details
- **Path stability**: Field paths remain consistent across requests to prevent information leakage
- **Message specificity**: Error messages are descriptive but don't reveal system internals

## Test Coverage

The validation logic is covered by comprehensive tests including:

### Unit Tests (`src/services/vaultValidation.test.ts`)

- Boundary condition testing for all fields
- Invalid type validation
- Edge case handling (Infinity, NaN, overflow)
- Error formatting stability
- Security constraint validation

### Integration Tests (`src/routes/vaults.test.ts`)

- HTTP-level validation testing
- Malformed payload handling
- Content-type validation
- JSON parsing error handling
- Payload size limit enforcement

**Target coverage**: Minimum 95% for validation logic

## Examples

### Valid Request

```json
{
  "amount": "1000",
  "startDate": "2030-01-01T00:00:00.000Z",
  "endDate": "2030-06-01T00:00:00.000Z",
  "verifier": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "destinations": {
    "success": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "failure": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "milestones": [
    {
      "title": "Kickoff",
      "dueDate": "2030-02-01T00:00:00.000Z",
      "amount": "500"
    },
    {
      "title": "Completion",
      "dueDate": "2030-05-01T00:00:00.000Z",
      "amount": "500"
    }
  ]
}
```

### Invalid Request Examples

```json
// Amount too small
{
  "amount": "0",
  // ... other fields
}

// Invalid Stellar address
{
  "verifier": "invalid_address",
  // ... other fields
}

// End date before start date
{
  "startDate": "2030-06-01T00:00:00.000Z",
  "endDate": "2030-01-01T00:00:00.000Z",
  // ... other fields
}

// Milestone total exceeds vault amount
{
  "amount": "1000",
  "milestones": [
    { "title": "M1", "dueDate": "2030-02-01T00:00:00.000Z", "amount": "600" },
    { "title": "M2", "dueDate": "2030-03-01T00:00:00.000Z", "amount": "500" }
  ],
  // ... other fields
}
```
