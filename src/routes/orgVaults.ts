import { orgReadRateLimiter } from '../middleware/rateLimiter.js'
import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray, encodeCursor, decodeCursor } from '../utils/pagination.js'
import { vaults } from './vaults.js'
import db from '../db/index.js'

export const orgVaultsRouter = Router()

orgVaultsRouter.get(
  '/:orgId/vaults',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  orgReadRateLimiter, 
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  (req: Request, res: Response) => {
    const { orgId } = req.params
    let result = vaults.filter((v) => v.orgId === orgId)

    if (req.filters) {
      result = applyFilters(result, req.filters)
    }

    if (req.sort) {
      result = applySort(result, req.sort)
    }

    const paginatedResult = paginateArray(result, req.pagination!)
    res.json(paginatedResult)
  }
)

/**
 * GET /api/orgs/:orgId/vaults/search
 *
 * Org-scoped vault search with full-text matching and structured filters.
 * Results are cursor-paginated for stable, consistent paging.
 *
 * Query parameters:
 *   q            - Full-text search term (matches creator + verifier via tsvector/GIN index,
 *                  falls back to ILIKE when the DB has no tsvector column yet)
 *   status       - Exact status filter: draft | active | completed | failed | cancelled
 *   verifier     - Exact verifier address filter
 *   amount_min   - Minimum vault amount (inclusive)
 *   amount_max   - Maximum vault amount (inclusive)
 *   date_from    - Minimum created_at (ISO 8601 inclusive)
 *   date_to      - Maximum created_at (ISO 8601 inclusive)
 *   cursor       - Opaque pagination cursor from a previous response
 *   limit        - Page size (1–100, default 20)
 */
orgVaultsRouter.get(
  '/:orgId/vaults/search',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  orgReadRateLimiter,
  queryParser({
    allowedSortFields: ['created_at', 'amount', 'end_date', 'status'],
    allowedFilterFields: ['status', 'verifier', 'amount_min', 'amount_max', 'date_from', 'date_to'],
  }),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req.params

    // ── Raw search term ─────────────────────────────────────────────────────
    // Strip to plain text — no special characters that could be meaningful
    // to tsvector/ILIKE beyond the literal token.
    const rawQ = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    // Sanitise: keep only alphanumeric, spaces, dots, hyphens, underscores
    const q = rawQ.replace(/[^\w\s.\-]/g, '').substring(0, 200)

    // ── Pagination ──────────────────────────────────────────────────────────
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'))))
    const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined

    try {
      // ── Base query — always scoped to the org and not soft-deleted ────────
      let query = db('vaults')
        .where('organization_id', orgId)
        .whereNull('deleted_at')

      // ── Full-text search ─────────────────────────────────────────────────
      if (q) {
        // Check whether the tsvector column exists (migration may not have run yet)
        const hasFtsColumn = await db('information_schema.columns')
          .where({
            table_schema: 'public',
            table_name: 'vaults',
            column_name: 'search_vector',
          })
          .first()
          .then(Boolean)

        if (hasFtsColumn) {
          // GIN index path — injection-safe: q is bound via knex parameterisation
          query = query.whereRaw(
            `search_vector @@ to_tsquery('simple', ?)`,
            [q.split(/\s+/).filter(Boolean).map(t => `${t}:*`).join(' & ')],
          )
        } else {
          // Fallback ILIKE path (slower, but safe until migration runs)
          query = query.where(function () {
            this.where('creator', 'ilike', `%${q}%`)
              .orWhere('verifier', 'ilike', `%${q}%`)
          })
        }
      }

      // ── Structured filters ───────────────────────────────────────────────
      const filters = req.filters ?? {}

      if (filters.status) {
        const status = Array.isArray(filters.status) ? filters.status[0] : filters.status
        query = query.where('status', status)
      }

      if (filters.verifier) {
        const verifier = Array.isArray(filters.verifier) ? filters.verifier[0] : filters.verifier
        query = query.where('verifier', verifier)
      }

      if (filters.amount_min) {
        const min = Array.isArray(filters.amount_min) ? filters.amount_min[0] : filters.amount_min
        query = query.where('amount', '>=', min)
      }

      if (filters.amount_max) {
        const max = Array.isArray(filters.amount_max) ? filters.amount_max[0] : filters.amount_max
        query = query.where('amount', '<=', max)
      }

      if (filters.date_from) {
        const from = Array.isArray(filters.date_from) ? filters.date_from[0] : filters.date_from
        query = query.where('created_at', '>=', new Date(from))
      }

      if (filters.date_to) {
        const to = Array.isArray(filters.date_to) ? filters.date_to[0] : filters.date_to
        query = query.where('created_at', '<=', new Date(to))
      }

      // ── Cursor pagination ────────────────────────────────────────────────
      // Stable sort: (created_at DESC, id DESC) — matches encodeCursor/decodeCursor contract
      if (rawCursor) {
        try {
          const { timestamp, id } = decodeCursor(rawCursor)
          query = query.where(function () {
            this.where('created_at', '<', timestamp)
              .orWhere(function () {
                this.where('created_at', '=', timestamp).andWhere('id', '<', id)
              })
          })
        } catch {
          res.status(400).json({ error: 'Invalid cursor' })
          return
        }
      }

      // Enforce stable ordering
      query = query.orderBy('created_at', 'desc').orderBy('id', 'desc')

      // Fetch limit + 1 to detect whether a next page exists
      const rows = await query.limit(limit + 1).select(
        'id',
        'creator',
        'verifier',
        'amount',
        'status',
        'organization_id',
        'start_date',
        'end_date',
        'created_at',
        'updated_at',
      )

      const hasMore = rows.length > limit
      const results = rows.slice(0, limit)

      let nextCursor: string | undefined
      if (hasMore && results.length > 0) {
        const last = results[results.length - 1]
        nextCursor = encodeCursor(new Date(last.created_at), last.id)
      }

      res.json({
        data: results,
        pagination: {
          limit,
          cursor: rawCursor,
          next_cursor: nextCursor,
          has_more: hasMore,
          count: results.length,
        },
      })
    } catch (error) {
      console.error('Error searching org vaults:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)
