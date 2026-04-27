import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import {
  setupTestDatabase,
  teardownTestDatabase,
  truncateTables,
  seedMinimalFixtures,
  migrateUp,
  migrateDown,
  TestHarness
} from './testDatabase.js'

describe('Database Test Harness', () => {
  let harness: TestHarness

  beforeAll(async () => {
    // We mock process.env inside specific tests, but here we run normally
    harness = await setupTestDatabase()
  })

  afterAll(async () => {
    if (harness) {
      await teardownTestDatabase(harness)
    }
  })

  it('should return Knex and Prisma clients', () => {
    expect(harness.knex).toBeDefined()
    expect(harness.prisma).toBeDefined()
  })

  it('should truncate tables successfully', async () => {
    // Insert a dummy user to verify truncation works
    await harness.knex('users').insert({
      id: 'test-user-to-truncate',
      email: 'truncate@example.com',
      password_hash: 'hash',
      role: 'USER',
      status: 'ACTIVE',
      created_at: new Date(),
      updated_at: new Date()
    })

    const countBefore = await harness.knex('users').count('* as count').first()
    expect(Number(countBefore?.count)).toBeGreaterThan(0)

    await truncateTables(harness.knex)

    const countAfter = await harness.knex('users').count('* as count').first()
    expect(Number(countAfter?.count)).toBe(0)
  })

  it('should seed minimal fixtures', async () => {
    await truncateTables(harness.knex)
    await seedMinimalFixtures(harness)

    const users = await harness.knex('users').select('*')
    // seedMinimalFixtures creates 3 users: user, verifier, admin
    expect(users).toHaveLength(3)
  })

  it('should run migrateDown and migrateUp safely', async () => {
    await migrateDown(harness.knex)
    
    // Test that the users table is gone (or we rollback at least one migration)
    // Note: Rolling back everything is dangerous, we just rollback one batch.
    await migrateUp(harness.knex)
    
    // We should be able to query the DB again without error
    const users = await harness.knex('users').select('*')
    expect(users).toBeDefined()
  })

  it('should throw an error if running against production', async () => {
    const originalEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    
    await expect(setupTestDatabase()).rejects.toThrow(/SECURITY GUARD/)
    
    process.env.NODE_ENV = originalEnv
  })

  it('should throw an error if URL looks like production', async () => {
    const originalUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@my-prod-db.com:5432/prod_db'
    
    await expect(setupTestDatabase()).rejects.toThrow(/SECURITY GUARD/)
    
    process.env.DATABASE_URL = originalUrl
  })
})
