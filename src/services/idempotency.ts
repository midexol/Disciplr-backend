import { Knex } from 'knex'
import { ParsedEvent } from '../types/horizonSync.js'
import { createHash } from 'node:crypto'

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key conflict') {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

export class IdempotencyOwnerMismatchError extends Error {
  constructor(message = 'Idempotency key belongs to a different owner') {
    super(message)
    this.name = 'IdempotencyOwnerMismatchError'
  }
}

export interface OwnerContext {
  userId: string | null
  orgId: string | null
}

interface StoreEntry {
  hash: string
  response: unknown
  expiresAt: number
  userId: string | null
  orgId: string | null
}

type PendingIdempotencyRequest = {
  hash: string
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  userId: string | null
  orgId: string | null
}

// In-memory store for idempotent responses (replaces DB for now)
const idempotencyStore = new Map<string, StoreEntry>()
const pendingIdempotencyRequests = new Map<string, PendingIdempotencyRequest>()
let idempotencyTtlMs = Number(process.env.IDEMPOTENCY_TTL_MS ?? 60 * 60 * 1000)

function isPrincipalOwner(
  storedUserId: string | null,
  storedOrgId: string | null,
  owner: OwnerContext,
): boolean {
  // Legacy / anonymous entries (both null) are accessible to any caller
  if (storedUserId === null && storedOrgId === null) return true
  if (storedUserId !== null && storedUserId !== owner.userId) return false
  if (storedOrgId !== null && storedOrgId !== owner.orgId) return false
  return true
}

export function hashRequestPayload(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function pruneExpiredEntries(now = Date.now()): void {
  for (const [key, entry] of idempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      idempotencyStore.delete(key)
    }
  }
}

export function setIdempotencyTtlMs(ttlMs: number): void {
  idempotencyTtlMs = ttlMs
}

export async function getIdempotentResponse<T>(
  key: string,
  hash: string,
  owner?: OwnerContext,
): Promise<T | null> {
  pruneExpiredEntries()

  const pending = pendingIdempotencyRequests.get(key)
  if (pending) {
    if (owner && !isPrincipalOwner(pending.userId, pending.orgId, owner)) {
      throw new IdempotencyOwnerMismatchError()
    }
    if (pending.hash !== hash) throw new IdempotencyConflictError()
    return pending.promise as Promise<T>
  }

  const entry = idempotencyStore.get(key)
  if (!entry) {
    let resolve!: (value: unknown) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })

    pendingIdempotencyRequests.set(key, {
      hash,
      promise,
      resolve,
      reject,
      userId: owner?.userId ?? null,
      orgId: owner?.orgId ?? null,
    })
    return null
  }

  if (owner && !isPrincipalOwner(entry.userId, entry.orgId, owner)) {
    throw new IdempotencyOwnerMismatchError()
  }

  if (entry.hash !== hash) throw new IdempotencyConflictError()
  return entry.response as T
}

export async function saveIdempotentResponse(
  key: string,
  hash: string,
  _id: string,
  response: unknown,
  owner?: OwnerContext,
): Promise<void> {
  pruneExpiredEntries()

  const pending = pendingIdempotencyRequests.get(key)
  if (pending) {
    pendingIdempotencyRequests.delete(key)
    pending.resolve(response)
  }

  idempotencyStore.set(key, {
    hash,
    response,
    expiresAt: Date.now() + idempotencyTtlMs,
    userId: owner?.userId ?? null,
    orgId: owner?.orgId ?? null,
  })
}

export function failPendingIdempotentResponse(key: string, hash: string, error: unknown): void {
  const pending = pendingIdempotencyRequests.get(key)
  if (!pending || pending.hash !== hash) {
    return
  }

  pendingIdempotencyRequests.delete(key)
  pending.reject(error)
}

export function resetIdempotencyStore(): void {
  idempotencyStore.clear()
  pendingIdempotencyRequests.clear()
}

/**
 * Idempotency Service
 * Handles checking and recording of processed operations to ensure exactly-once execution.
 */
export class IdempotencyService {
  private db: Knex

  constructor(db: Knex) {
    this.db = db
  }

  /**
   * Check if an event has already been processed.
   *
   * @param eventId - Unique ID of the event
   * @param trx - Optional transaction to use for the check
   * @returns Promise<boolean> - True if already processed
   */
  async isEventProcessed(eventId: string, trx?: Knex.Transaction): Promise<boolean> {
    const query = (trx || this.db)('processed_events')
      .where({ event_id: eventId })
      .first()

    const result = await query
    return !!result
  }

  /**
   * Mark an event as processed in the database.
   * MUST be called within a transaction that includes the business logic operations.
   *
   * @param event - The parsed event being processed
   * @param trx - Transaction to use for recording
   */
  async markEventProcessed(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    await trx('processed_events').insert({
      event_id: event.eventId,
      transaction_hash: event.transactionHash,
      event_index: event.eventIndex,
      ledger_number: event.ledgerNumber,
      processed_at: new Date(),
      created_at: new Date(),
    })
  }

  /**
   * General-purpose idempotency check for API requests.
   * Checks the idempotency_keys table and validates owner binding.
   *
   * @param key - The idempotency key provided by the client
   * @param owner - The authenticated principal making the request
   * @returns Promise<any | null> - The stored response if found and owner matches, null otherwise
   * @throws IdempotencyOwnerMismatchError if the key belongs to a different owner
   */
  async getStoredResponse(key: string, owner?: OwnerContext): Promise<any | null> {
    const record = await this.db('idempotency_keys').where({ key }).first()

    if (!record) return null

    if (owner && !isPrincipalOwner(record.user_id ?? null, record.org_id ?? null, owner)) {
      throw new IdempotencyOwnerMismatchError()
    }

    return record.response
  }

  /**
   * Store a response for a given idempotency key, bound to the requesting owner.
   *
   * @param key - The idempotency key
   * @param response - The response payload to store
   * @param owner - The authenticated principal to bind the key to
   * @param trx - Optional transaction
   */
  async storeResponse(
    key: string,
    response: any,
    owner?: OwnerContext,
    trx?: Knex.Transaction,
  ): Promise<void> {
    await (trx || this.db)('idempotency_keys').insert({
      key,
      response: typeof response === 'string' ? response : JSON.stringify(response),
      user_id: owner?.userId ?? null,
      org_id: owner?.orgId ?? null,
      created_at: new Date(),
    })
  }
}
