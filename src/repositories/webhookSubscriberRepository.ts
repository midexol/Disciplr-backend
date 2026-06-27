import { Knex } from 'knex'
import type { WebhookSubscriber, BreakerState, BreakerStateValue } from '../services/webhooks.js'

interface SubscriberRow {
  id: string
  organization_id: string
  url: string
  secret: string
  events: string[]
  active: boolean
  created_at: Date
  updated_at: Date
}

interface BreakerRow {
  subscriber_id: string
  state: string
  failure_count: number
  last_failure_at: Date | null
  tripped_at: Date | null
  half_open_at: Date | null
  created_at: Date
  updated_at: Date
}

function toSubscriber(row: SubscriberRow): WebhookSubscriber {
  return {
    id: row.id,
    organizationId: row.organization_id,
    url: row.url,
    secret: row.secret,
    events: row.events ?? [],
    active: row.active,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  }
}

function toBreakerState(row: BreakerRow): BreakerState {
  return {
    subscriberId: row.subscriber_id,
    state: row.state as BreakerStateValue,
    failureCount: row.failure_count,
    lastFailureAt: row.last_failure_at instanceof Date
      ? row.last_failure_at.toISOString()
      : row.last_failure_at,
    trippedAt: row.tripped_at instanceof Date
      ? row.tripped_at.toISOString()
      : row.tripped_at,
    halfOpenAt: row.half_open_at instanceof Date
      ? row.half_open_at.toISOString()
      : row.half_open_at,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at),
  }
}

export class WebhookSubscriberRepository {
  constructor(private readonly db: Knex) {}

  async findByOrg(organizationId: string): Promise<WebhookSubscriber[]> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ organization_id: organizationId, active: true })
      .orderBy('created_at', 'asc')
    return rows.map(toSubscriber)
  }

  async findById(id: string): Promise<WebhookSubscriber | null> {
    const row = await this.db<SubscriberRow>('webhook_subscribers').where({ id }).first()
    return row ? toSubscriber(row) : null
  }

  async findByEvent(organizationId: string, eventType: string): Promise<WebhookSubscriber[]> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ organization_id: organizationId, active: true })
      .andWhere(function () {
        this.whereRaw("events = '[]'::jsonb").orWhereRaw('events @> ?', [JSON.stringify([eventType])])
      })
      .orderBy('created_at', 'asc')
    return rows.map(toSubscriber)
  }

  async create(data: {
    organizationId: string
    url: string
    secret: string
    events: string[]
  }): Promise<WebhookSubscriber> {
    const [row] = await this.db<SubscriberRow>('webhook_subscribers')
      .insert({
        organization_id: data.organizationId,
        url: data.url,
        secret: data.secret,
        events: JSON.stringify(data.events) as any,
      })
      .returning('*')
    return toSubscriber(row)
  }

  async deactivate(id: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers')
      .where({ id })
      .update({ active: false, updated_at: this.db.fn.now() })
    return count > 0
  }

  async remove(id: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers').where({ id }).del()
    return count > 0
  }

  async upsertBreakerState(
    subscriberId: string,
    data: {
      state: BreakerStateValue
      failureCount?: number
      lastFailureAt?: string | null
      trippedAt?: string | null
      halfOpenAt?: string | null
    },
  ): Promise<void> {
    const payload: Record<string, any> = {
      state: data.state,
      updated_at: this.db.fn.now(),
    }
    if (data.failureCount !== undefined) payload.failure_count = data.failureCount
    if (data.lastFailureAt !== undefined) payload.last_failure_at = data.lastFailureAt
    if (data.trippedAt !== undefined) payload.tripped_at = data.trippedAt
    if (data.halfOpenAt !== undefined) payload.half_open_at = data.halfOpenAt

    await this.db('webhook_breaker_states')
      .insert({
        subscriber_id: subscriberId,
        ...payload,
      })
      .onConflict('subscriber_id')
      .merge()
  }

  async getBreakerState(subscriberId: string): Promise<BreakerState | null> {
    const row = await this.db<BreakerRow>('webhook_breaker_states')
      .where({ subscriber_id: subscriberId })
      .first()
    return row ? toBreakerState(row) : null
  }

  async tryTransitionToHalfOpen(
    subscriberId: string,
    now: Date,
  ): Promise<boolean> {
    const affected = await this.db('webhook_breaker_states')
      .where({
        subscriber_id: subscriberId,
        state: 'OPEN',
      })
      .update({
        state: 'HALF_OPEN',
        half_open_at: now,
        updated_at: this.db.fn.now(),
      })
    return affected > 0
  }

  async getAllBreakerStates(): Promise<BreakerState[]> {
    const rows = await this.db<BreakerRow>('webhook_breaker_states').select('*')
    return rows.map(toBreakerState)
  }

  async removeBreakerState(subscriberId: string): Promise<boolean> {
    const count = await this.db('webhook_breaker_states')
      .where({ subscriber_id: subscriberId })
      .del()
    return count > 0
  }
}
