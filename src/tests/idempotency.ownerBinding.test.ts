import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import type { Knex } from 'knex'
import {
  getIdempotentResponse,
  saveIdempotentResponse,
  resetIdempotencyStore,
  hashRequestPayload,
  IdempotencyConflictError,
  IdempotencyOwnerMismatchError,
  IdempotencyService,
  type OwnerContext,
} from '../services/idempotency.js'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const OWNER_A: OwnerContext = { userId: 'user-alpha', orgId: 'org-1' }
const OWNER_B: OwnerContext = { userId: 'user-beta', orgId: 'org-1' }
const OWNER_A_ORG2: OwnerContext = { userId: 'user-alpha', orgId: 'org-2' }
const ANON: OwnerContext = { userId: null, orgId: null }

const PAYLOAD = { amount: '500', creator: 'GABC' }
const HASH = hashRequestPayload(PAYLOAD)
const RESPONSE = { vault: { id: 'vault-1' }, onChain: {} }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockDb(record: Record<string, unknown> | null) {
  const first = jest.fn<() => Promise<typeof record>>().mockResolvedValue(record)
  const where = jest.fn().mockReturnValue({ first })
  const insert = jest.fn<() => Promise<number[]>>().mockResolvedValue([1])
  const table = jest.fn((_name: string) => ({ where, first, insert }))
  return { db: table as unknown as Knex, mocks: { where, first, insert } }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('idempotency owner binding — in-memory store', () => {
  beforeEach(() => {
    resetIdempotencyStore()
  })

  // ── Same-owner replay (exactly-once semantics must be preserved) ────────────

  describe('same-owner replay', () => {
    it('returns cached response when key, hash, and owner all match', async () => {
      await saveIdempotentResponse('k1', HASH, 'v1', RESPONSE, OWNER_A)
      const result = await getIdempotentResponse('k1', HASH, OWNER_A)
      expect(result).toEqual(RESPONSE)
    })

    it('returns null (miss) when key is not yet stored', async () => {
      const result = await getIdempotentResponse('unknown-key', HASH, OWNER_A)
      expect(result).toBeNull()
    })

    it('throws IdempotencyConflictError when owner matches but hash differs (payload changed)', async () => {
      await saveIdempotentResponse('k2', HASH, 'v2', RESPONSE, OWNER_A)
      const differentHash = hashRequestPayload({ amount: '999' })
      await expect(getIdempotentResponse('k2', differentHash, OWNER_A)).rejects.toThrow(
        IdempotencyConflictError,
      )
    })

    it('never discloses stored data via the conflict error', async () => {
      await saveIdempotentResponse('k3', HASH, 'v3', { secret: 'tenant-data' }, OWNER_A)
      const err = await getIdempotentResponse('k3', 'wrong-hash', OWNER_A).catch((e) => e)
      expect(err).toBeInstanceOf(IdempotencyConflictError)
      expect(JSON.stringify(err)).not.toContain('tenant-data')
    })
  })

  // ── Cross-user key reuse ────────────────────────────────────────────────────

  describe('cross-user key reuse rejection', () => {
    it('throws IdempotencyOwnerMismatchError when a different user replays the key', async () => {
      await saveIdempotentResponse('k4', HASH, 'v4', RESPONSE, OWNER_A)
      await expect(getIdempotentResponse('k4', HASH, OWNER_B)).rejects.toThrow(
        IdempotencyOwnerMismatchError,
      )
    })

    it('never returns stored response to a mismatched user (data isolation)', async () => {
      await saveIdempotentResponse('k5', HASH, 'v5', { secret: 'owner-a-data' }, OWNER_A)
      let result: unknown = null
      try {
        result = await getIdempotentResponse('k5', HASH, OWNER_B)
      } catch {
        // expected mismatch error
      }
      expect(result).toBeNull()
    })

    it('error message does not disclose the original owner identity', async () => {
      await saveIdempotentResponse('k6', HASH, 'v6', RESPONSE, OWNER_A)
      const err = await getIdempotentResponse('k6', HASH, OWNER_B).catch((e) => e)
      expect(err).toBeInstanceOf(IdempotencyOwnerMismatchError)
      expect(err.message).not.toContain(OWNER_A.userId)
    })
  })

  // ── Cross-org key reuse ─────────────────────────────────────────────────────

  describe('cross-org key reuse rejection', () => {
    it('throws IdempotencyOwnerMismatchError when same userId but different orgId', async () => {
      await saveIdempotentResponse('k7', HASH, 'v7', RESPONSE, OWNER_A)
      await expect(getIdempotentResponse('k7', HASH, OWNER_A_ORG2)).rejects.toThrow(
        IdempotencyOwnerMismatchError,
      )
    })

    it('allows replay when same userId and orgId (same org, same user)', async () => {
      await saveIdempotentResponse('k8', HASH, 'v8', RESPONSE, OWNER_A)
      const result = await getIdempotentResponse('k8', HASH, OWNER_A)
      expect(result).toEqual(RESPONSE)
    })

    it('two users in different orgs can use the same client key string independently', async () => {
      const sharedKeyString = 'client-chose-same-key'
      // OWNER_A stores first
      await saveIdempotentResponse(sharedKeyString, HASH, 'v-a', { owner: 'a' }, OWNER_A)
      // OWNER_A_ORG2 tries to replay — the store is keyed by the raw string so they
      // see OWNER_A's entry and get an owner mismatch (routes should namespace by user)
      await expect(
        getIdempotentResponse(sharedKeyString, HASH, OWNER_A_ORG2),
      ).rejects.toThrow(IdempotencyOwnerMismatchError)
    })
  })

  // ── Anonymous / no-owner context ────────────────────────────────────────────

  describe('anonymous key handling', () => {
    it('allows replay when no owner context passed at all (anonymous caller)', async () => {
      await saveIdempotentResponse('k9', HASH, 'v9', RESPONSE)
      const result = await getIdempotentResponse('k9', HASH)
      expect(result).toEqual(RESPONSE)
    })

    it('allows replay by an authenticated caller of an anonymous-stored key', async () => {
      await saveIdempotentResponse('k10', HASH, 'v10', RESPONSE, ANON)
      const result = await getIdempotentResponse('k10', HASH, OWNER_A)
      expect(result).toEqual(RESPONSE)
    })

    it('still enforces hash check for anonymous keys', async () => {
      await saveIdempotentResponse('k11', HASH, 'v11', RESPONSE)
      await expect(getIdempotentResponse('k11', 'wrong-hash')).rejects.toThrow(
        IdempotencyConflictError,
      )
    })
  })

  // ── Legacy keys without owner (backward compat) ─────────────────────────────

  describe('legacy keys without owner', () => {
    it('allows any authenticated user to replay a legacy key (null owner)', async () => {
      // Simulate a key persisted before the owner-binding migration
      await saveIdempotentResponse('legacy-key', HASH, 'v-legacy', RESPONSE, undefined)
      const result = await getIdempotentResponse('legacy-key', HASH, OWNER_B)
      expect(result).toEqual(RESPONSE)
    })

    it('treats null userId + null orgId as legacy (not owner-bound)', async () => {
      await saveIdempotentResponse('legacy-key-2', HASH, 'v-legacy-2', RESPONSE, ANON)
      const result = await getIdempotentResponse('legacy-key-2', HASH, OWNER_A)
      expect(result).toEqual(RESPONSE)
    })
  })

  // ── Store isolation between distinct owners ─────────────────────────────────

  describe('store isolation', () => {
    it('different keys for the same owner are independent', async () => {
      await saveIdempotentResponse('key-x', HASH, 'vx', { x: 1 }, OWNER_A)
      await saveIdempotentResponse('key-y', HASH, 'vy', { y: 2 }, OWNER_A)
      expect(await getIdempotentResponse('key-x', HASH, OWNER_A)).toEqual({ x: 1 })
      expect(await getIdempotentResponse('key-y', HASH, OWNER_A)).toEqual({ y: 2 })
    })

    it('resetIdempotencyStore clears all entries', async () => {
      await saveIdempotentResponse('key-r', HASH, 'vr', RESPONSE, OWNER_A)
      resetIdempotencyStore()
      const result = await getIdempotentResponse('key-r', HASH, OWNER_A)
      expect(result).toBeNull()
    })
  })
})

// ─── IdempotencyService (DB-backed) ──────────────────────────────────────────

describe('IdempotencyService owner binding — DB layer', () => {
  // ── getStoredResponse ───────────────────────────────────────────────────────

  describe('getStoredResponse', () => {
    it('returns null when key does not exist', async () => {
      const { db } = makeMockDb(null)
      const service = new IdempotencyService(db)
      expect(await service.getStoredResponse('missing', OWNER_A)).toBeNull()
    })

    it('returns response when owner matches (same userId and orgId)', async () => {
      const { db } = makeMockDb({
        response: JSON.stringify(RESPONSE),
        request_hash: HASH,
        user_id: 'user-alpha',
        org_id: 'org-1',
      })
      const service = new IdempotencyService(db)
      const result = await service.getStoredResponse('k', OWNER_A)
      expect(result).toEqual(JSON.stringify(RESPONSE))
    })

    it('throws IdempotencyOwnerMismatchError when userId differs', async () => {
      const { db } = makeMockDb({
        response: JSON.stringify(RESPONSE),
        request_hash: HASH,
        user_id: 'user-alpha',
        org_id: 'org-1',
      })
      const service = new IdempotencyService(db)
      await expect(service.getStoredResponse('k', OWNER_B)).rejects.toThrow(
        IdempotencyOwnerMismatchError,
      )
    })

    it('throws IdempotencyOwnerMismatchError when orgId differs', async () => {
      const { db } = makeMockDb({
        response: JSON.stringify(RESPONSE),
        request_hash: HASH,
        user_id: 'user-alpha',
        org_id: 'org-1',
      })
      const service = new IdempotencyService(db)
      await expect(service.getStoredResponse('k', OWNER_A_ORG2)).rejects.toThrow(
        IdempotencyOwnerMismatchError,
      )
    })

    it('allows replay of legacy DB record (null user_id and org_id) by any caller', async () => {
      const { db } = makeMockDb({
        response: JSON.stringify(RESPONSE),
        request_hash: HASH,
        user_id: null,
        org_id: null,
      })
      const service = new IdempotencyService(db)
      const result = await service.getStoredResponse('legacy', OWNER_A)
      expect(result).toEqual(JSON.stringify(RESPONSE))
    })

    it('returns response without owner check when no owner context provided', async () => {
      const { db } = makeMockDb({
        response: JSON.stringify(RESPONSE),
        request_hash: HASH,
        user_id: 'user-alpha',
        org_id: 'org-1',
      })
      const service = new IdempotencyService(db)
      const result = await service.getStoredResponse('k')
      expect(result).toEqual(JSON.stringify(RESPONSE))
    })
  })

  // ── storeResponse ───────────────────────────────────────────────────────────

  describe('storeResponse', () => {
    it('inserts user_id and org_id from owner context', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('k', RESPONSE, OWNER_A)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-alpha',
          org_id: 'org-1',
        }),
      )
    })

    it('inserts null owner columns when no owner context provided', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('k', RESPONSE)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: null,
          org_id: null,
        }),
      )
    })

    it('serialises non-string responses to JSON', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('k', { data: 42 }, OWNER_A)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ response: JSON.stringify({ data: 42 }) }),
      )
    })

    it('passes through string responses unchanged', async () => {
      const { db, mocks } = makeMockDb(null)
      const service = new IdempotencyService(db)
      await service.storeResponse('k', 'already-string', OWNER_A)

      expect(mocks.insert).toHaveBeenCalledWith(
        expect.objectContaining({ response: 'already-string' }),
      )
    })
  })
})
