import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import knex, { Knex } from 'knex'
import { EventProcessor } from '../services/eventProcessor.js'
import { ParsedEvent } from '../types/horizonSync.js'
import { setupTestDatabase, teardownTestDatabase, truncateTables, TestHarness } from './helpers/testDatabase.js'
import {
  validateIdempotencyKey,
  IdempotencyKeyValidationError,
  IDEMPOTENCY_KEY_REGEX,
  hashRequestPayload,
  getIdempotentResponse,
  saveIdempotentResponse,
  resetIdempotencyStore,
  IdempotencyConflictError,
} from '../services/idempotency.js'

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests – API idempotency (no database required)
// ─────────────────────────────────────────────────────────────────────────────

describe('validateIdempotencyKey', () => {
  it('accepts a simple alphanumeric key', () => {
    expect(() => validateIdempotencyKey('abc123')).not.toThrow()
  })

  it('accepts a UUID-formatted key', () => {
    expect(() => validateIdempotencyKey('550e8400-e29b-41d4-a716-446655440000')).not.toThrow()
  })

  it('accepts a key containing underscores and hyphens', () => {
    expect(() => validateIdempotencyKey('my_key-v2')).not.toThrow()
  })

  it('accepts a single-character key', () => {
    expect(() => validateIdempotencyKey('a')).not.toThrow()
  })

  it('accepts a 255-character key', () => {
    expect(() => validateIdempotencyKey('a'.repeat(255))).not.toThrow()
  })

  it('rejects an empty string', () => {
    expect(() => validateIdempotencyKey('')).toThrow(IdempotencyKeyValidationError)
  })

  it('rejects a key exceeding 255 characters', () => {
    expect(() => validateIdempotencyKey('a'.repeat(256))).toThrow(IdempotencyKeyValidationError)
  })

  it('rejects a key containing spaces', () => {
    expect(() => validateIdempotencyKey('invalid key')).toThrow(IdempotencyKeyValidationError)
  })

  it('rejects a key containing special characters', () => {
    expect(() => validateIdempotencyKey('key@value!')).toThrow(IdempotencyKeyValidationError)
  })

  it('rejects a key containing a slash', () => {
    expect(() => validateIdempotencyKey('key/value')).toThrow(IdempotencyKeyValidationError)
  })

  it('thrown error has code INVALID_IDEMPOTENCY_KEY', () => {
    try {
      validateIdempotencyKey('')
    } catch (err) {
      expect(err).toBeInstanceOf(IdempotencyKeyValidationError)
      expect((err as IdempotencyKeyValidationError).code).toBe('INVALID_IDEMPOTENCY_KEY')
    }
  })

  it('IDEMPOTENCY_KEY_REGEX rejects empty string', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('')).toBe(false)
  })

  it('IDEMPOTENCY_KEY_REGEX rejects 256-character string', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(256))).toBe(false)
  })
})

describe('hashRequestPayload', () => {
  it('produces the same hash for identical payloads', () => {
    expect(hashRequestPayload({ a: 1, b: 2 })).toBe(hashRequestPayload({ a: 1, b: 2 }))
  })

  it('produces the same hash regardless of top-level key order', () => {
    expect(hashRequestPayload({ a: 1, b: 2 })).toBe(hashRequestPayload({ b: 2, a: 1 }))
  })

  it('produces the same hash regardless of nested key order', () => {
    const h1 = hashRequestPayload({ x: { c: 3, a: 1 }, y: 2 })
    const h2 = hashRequestPayload({ y: 2, x: { a: 1, c: 3 } })
    expect(h1).toBe(h2)
  })

  it('produces different hashes for different values', () => {
    expect(hashRequestPayload({ a: 1 })).not.toBe(hashRequestPayload({ a: 2 }))
  })

  it('handles null payload without throwing', () => {
    expect(() => hashRequestPayload(null)).not.toThrow()
  })

  it('produces consistent hash for null', () => {
    expect(hashRequestPayload(null)).toBe(hashRequestPayload(null))
  })

  it('preserves array ordering (different order → different hash)', () => {
    expect(hashRequestPayload([1, 2, 3])).not.toBe(hashRequestPayload([3, 2, 1]))
  })

  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = hashRequestPayload({ amount: '1000' })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('idempotency store', () => {
  beforeEach(() => {
    resetIdempotencyStore()
  })

  it('returns null for an unknown key', async () => {
    await expect(getIdempotentResponse('unknown', 'hash')).resolves.toBeNull()
  })

  it('returns the stored response when key and hash match', async () => {
    const payload = { vault: { id: 'v1' } }
    await saveIdempotentResponse('key1', 'hash1', 'v1', payload)
    await expect(getIdempotentResponse('key1', 'hash1')).resolves.toEqual(payload)
  })

  it('throws IdempotencyConflictError when key exists but hash differs', async () => {
    await saveIdempotentResponse('key2', 'hash-original', 'v2', { vault: { id: 'v2' } })
    await expect(getIdempotentResponse('key2', 'hash-different')).rejects.toThrow(IdempotencyConflictError)
  })

  it('conflict error has code IDEMPOTENCY_CONFLICT', async () => {
    await saveIdempotentResponse('key3', 'hash-a', 'v3', { vault: { id: 'v3' } })
    try {
      await getIdempotentResponse('key3', 'hash-b')
    } catch (err) {
      expect((err as IdempotencyConflictError).code).toBe('IDEMPOTENCY_CONFLICT')
    }
  })

  it('resetIdempotencyStore clears all entries', async () => {
    await saveIdempotentResponse('key4', 'hash1', 'v4', { vault: { id: 'v4' } })
    resetIdempotencyStore()
    await expect(getIdempotentResponse('key4', 'hash1')).resolves.toBeNull()
  })

  it('two different keys are stored independently', async () => {
    const r1 = { vault: { id: 'r1' } }
    const r2 = { vault: { id: 'r2' } }
    await saveIdempotentResponse('keyA', 'hash1', 'r1', r1)
    await saveIdempotentResponse('keyB', 'hash2', 'r2', r2)
    await expect(getIdempotentResponse('keyA', 'hash1')).resolves.toEqual(r1)
    await expect(getIdempotentResponse('keyB', 'hash2')).resolves.toEqual(r2)
  })

  it('user-scoped keys do not collide (different prefixes, same suffix)', async () => {
    const response1 = { vault: { id: 'vault-user1' } }
    const response2 = { vault: { id: 'vault-user2' } }
    await saveIdempotentResponse('user1:shared-key', 'hash1', 'vault-user1', response1)
    await saveIdempotentResponse('user2:shared-key', 'hash1', 'vault-user2', response2)
    await expect(getIdempotentResponse('user1:shared-key', 'hash1')).resolves.toEqual(response1)
    await expect(getIdempotentResponse('user2:shared-key', 'hash1')).resolves.toEqual(response2)
  })
})

describe('Event Processor Idempotency', () => {
  let harness: TestHarness
  let db: Knex
  let processor: EventProcessor

  beforeAll(async () => {
    harness = await setupTestDatabase()
    db = harness.knex

    processor = new EventProcessor(db, {
      maxRetries: 3,
      retryBackoffMs: 100
    })
  })

  afterAll(async () => {
    await teardownTestDatabase(harness)
  })

  beforeEach(async () => {
    // Clean tables using harness truncate utility
    await truncateTables(db)
  })

  it('should process a vault_created event and ignore duplicates', async () => {
    const event: ParsedEvent = {
      eventId: 'tx1:op0',
      transactionHash: 'tx1',
      eventIndex: 0,
      ledgerNumber: 100,
      eventType: 'vault_created',
      payload: {
        vaultId: 'vault-unique-1',
        creator: 'GCREATOR',
        amount: '100',
        startTimestamp: new Date(),
        endTimestamp: new Date(Date.now() + 100000),
        successDestination: 'GSUCCESS',
        failureDestination: 'GFAIL',
        status: 'active'
      }
    }

    // 1st processing
    const result1 = await processor.processEvent(event)
    expect(result1.success).toBe(true)

    const vaultCount1 = await db('vaults').where({ id: 'vault-unique-1' }).count('* as count').first()
    expect(Number(vaultCount1?.count)).toBe(1)

    // 2nd processing (duplicate)
    const result2 = await processor.processEvent(event)
    expect(result2.success).toBe(true)

    const vaultCount2 = await db('vaults').where({ id: 'vault-unique-1' }).count('* as count').first()
    expect(Number(vaultCount2?.count)).toBe(1) // Should still be 1

    const processedEvents = await db('processed_events').where({ event_id: 'tx1:op0' }).count('* as count').first()
    expect(Number(processedEvents?.count)).toBe(1)
  })

  it('should maintain idempotency for milestone creation', async () => {
    // Create vault first
    await db('vaults').insert({
      id: 'vault-m',
      creator: 'GCREATOR',
      amount: '100',
      start_timestamp: new Date(),
      end_date: new Date(Date.now() + 100000),
      success_destination: 'GSUCCESS',
      failure_destination: 'GFAIL',
      status: 'active',
      created_at: new Date()
    })

    const event: ParsedEvent = {
      eventId: 'tx2:op1',
      transactionHash: 'tx2',
      eventIndex: 1,
      ledgerNumber: 101,
      eventType: 'milestone_created',
      payload: {
        milestoneId: 'ms-unique-1',
        vaultId: 'vault-m',
        title: 'Milestone 1',
        description: 'First milestone',
        targetAmount: '50',
        deadline: new Date()
      }
    }

    await processor.processEvent(event)
    await processor.processEvent(event) // Duplicate

    const milestoneCount = await db('milestones').where({ id: 'ms-unique-1' }).count('* as count').first()
    expect(Number(milestoneCount?.count)).toBe(1)
  })

  it('should handle concurrent processing attempts gracefully', async () => {
    const event: ParsedEvent = {
        eventId: 'tx3:op0',
        transactionHash: 'tx3',
        eventIndex: 0,
        ledgerNumber: 102,
        eventType: 'vault_created',
        payload: {
          vaultId: 'vault-concurrent',
          creator: 'GCREATOR',
          amount: '100',
          startTimestamp: new Date(),
          endTimestamp: new Date(Date.now() + 100000),
          successDestination: 'GSUCCESS',
          failureDestination: 'GFAIL',
          status: 'active'
        }
    }

    // Fire off two processing attempts simultaneously
    const [res1, res2] = await Promise.all([
        processor.processEvent(event),
        processor.processEvent(event)
    ])

    // Both should report success (either it processed or it was a no-op due to already processed)
    expect(res1.success).toBe(true)
    expect(res2.success).toBe(true)

    const vaultCount = await db('vaults').where({ id: 'vault-concurrent' }).count('* as count').first()
    expect(Number(vaultCount?.count)).toBe(1)
  })
})
