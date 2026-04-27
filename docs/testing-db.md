# Database Test Harness

This document describes the database test harness for the Disciplr backend.

## Overview

The database test harness (`src/tests/helpers/testDatabase.ts`) provides a robust and standardized way to set up, isolate, and tear down the database state for tests. It supports both Knex and Prisma.

## Key Features

1. **Dual ORM Support**: Returns an object `{ knex, prisma }` so tests can use either Knex query builder or Prisma ORM seamlessly.
2. **Database Isolation**: Uses `truncateTables` utility which executes `TRUNCATE TABLE ... CASCADE` to cleanly and quickly clear tables before/after each test, eliminating flakiness from dirty database state.
3. **Guard Rails**: Validates the database URL to ensure you never accidentally run test teardowns or migrations against a production database.
4. **Seed Utilities**: Built-in utilities for seeding minimal test fixtures (e.g., standard RBAC roles).

## Usage

In your Jest tests, import the test database setup and teardown helpers:

```typescript
import { TestHarness, setupTestDatabase, teardownTestDatabase, truncateTables } from './helpers/testDatabase.js'

describe('My Service Tests', () => {
  let harness: TestHarness

  beforeAll(async () => {
    // This will run migrations automatically
    harness = await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase(harness)
  })

  beforeEach(async () => {
    // This ensures every test starts with a clean slate
    await truncateTables(harness.knex)
  })

  it('should test something using Knex', async () => {
    await harness.knex('users').insert({ ... })
  })

  it('should test something using Prisma', async () => {
    await harness.prisma.user.create({ ... })
  })
})
```

## Parallel Test Execution

By default, the harness uses a shared testing database (e.g. `postgresql://postgres:postgres@localhost:5432/disciplr_test`).
If Jest runs tests in parallel, executing `TRUNCATE TABLE` across multiple test suites concurrently may cause race conditions. 

**Recommendation for CI:** Explicitly disable parallel execution when tests hit the shared database by running:
`npm run test -- --runInBand`
or
`npm run test -- --maxWorkers=1`

If parallel execution is required, you must run an advanced setup that provisions unique logical databases (or distinct schemas) per `JEST_WORKER_ID`. Currently, this harness depends on table truncation against the `disciplr_test` database.
