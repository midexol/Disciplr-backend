import { Router, type Request, type Response, type NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { AppError } from '../middleware/errorHandler.js'
import {
  getOrgNotificationPreferences,
  setOrgNotificationPreferences,
  UnknownPreferenceKeyError,
} from '../models/notificationPreferences.js'

export const notificationPreferencesRouter = Router()

// ─── GET /api/orgs/:orgId/notification-preferences ─────────────────────────
// Any member can view the org's notification preferences.

notificationPreferencesRouter.get(
  '/:orgId/notification-preferences',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const preferences = await getOrgNotificationPreferences(req.params.orgId)
      res.json(preferences)
    } catch (err) {
      next(err)
    }
  },
)

// ─── PUT /api/orgs/:orgId/notification-preferences ──────────────────────────
// Only owners and admins may change notification preferences.

notificationPreferencesRouter.put(
  '/:orgId/notification-preferences',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    const { categories, channels } = req.body ?? {}

    if (categories !== undefined && (typeof categories !== 'object' || categories === null || Array.isArray(categories))) {
      return next(AppError.badRequest('categories must be an object of category to boolean'))
    }
    if (channels !== undefined && (typeof channels !== 'object' || channels === null || Array.isArray(channels))) {
      return next(AppError.badRequest('channels must be an object of channel to boolean'))
    }

    try {
      const preferences = await setOrgNotificationPreferences(req.params.orgId, { categories, channels })
      res.json(preferences)
    } catch (err) {
      if (err instanceof UnknownPreferenceKeyError) {
        return next(AppError.badRequest(err.message))
      }
      next(err)
    }
  },
)
