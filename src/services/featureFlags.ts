import { db } from '../db/knex.js'
import { getOrSet, invalidate, invalidatePrefix, getCacheStats as getSharedCacheStats } from '../lib/cache.js'

/**
 * Feature flag names that can be toggled at runtime
 */
export enum FeatureFlag {
  ENTERPRISE_ANALYTICS = 'ENTERPRISE_ANALYTICS',
  MULTI_VERIFIER_ENABLED = 'MULTI_VERIFIER_ENABLED',
  ORGANIZATION_QUOTAS = 'ORGANIZATION_QUOTAS',
  ADVANCED_ANALYTICS = 'ADVANCED_ANALYTICS',
}

/**
 * Generate cache key from flag name and organization ID
 */
function getCacheKey(name: string, orgId: string | null): string {
  return `feature_flag:${name}:${orgId || 'global'}`
}

/**
 * Get feature flag value for an organization with fallback to global setting.
 * Errors are caught at the top level to avoid caching partial or failed reads.
 */
export async function getFlag(name: string, orgId: string | null): Promise<boolean> {
  try {
    // 1. Try organization-specific flag override
    if (orgId) {
      const cacheKey = getCacheKey(name, orgId)
      const cached = await getOrSet(cacheKey, 300, async () => {
        const row = await db('feature_flags').where({ name, org_id: orgId }).first()
        return { exists: !!row, value: row?.enabled ?? false }
      })
      if (cached.exists) {
        return cached.value
      }
    }

    // 2. Fall back to global default (org_id = null)
    const globalCacheKey = getCacheKey(name, null)
    return await getOrSet(globalCacheKey, 300, async () => {
      const row = await db('feature_flags').where({ name, org_id: null }).first()
      return row?.enabled ?? false
    })
  } catch (error) {
    console.error(`Error fetching flag ${name}:`, error)
    return false
  }
}

/**
 * Set feature flag value for an organization and invalidate cache.
 */
export async function setFlag(
  name: string,
  orgId: string | null,
  enabled: boolean,
): Promise<boolean> {
  try {
    const updated = await db('feature_flags')
      .where({ name, org_id: orgId })
      .update({ enabled, updated_at: db.fn.now() })

    if (updated === 0) {
      await db('feature_flags').insert({
        name,
        org_id: orgId,
        enabled,
        updated_at: db.fn.now(),
      })
    }

    // Invalidate cache immediately on write
    await invalidate(getCacheKey(name, orgId))
    return enabled
  } catch (error) {
    console.error(`Error setting flag ${name} for org ${orgId}:`, error)
    throw error
  }
}

/**
 * Get all feature flags for an organization (bypasses cache for bulk read).
 */
export async function getAllFlags(orgId: string | null): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {}
  try {
    const globalRows = await db('feature_flags').where({ org_id: null })
    for (const row of globalRows) {
      flags[row.name] = row.enabled
    }

    if (orgId) {
      const orgRows = await db('feature_flags').where({ org_id: orgId })
      for (const row of orgRows) {
        flags[row.name] = row.enabled
      }
    }
    return flags
  } catch (error) {
    console.error(`Error fetching all flags for org ${orgId}:`, error)
    return {}
  }
}

/**
 * Clear all feature flag cache entries.
 */
export async function clearCache(): Promise<void> {
  await invalidatePrefix('feature_flag:')
}

/**
 * Get cache statistics for monitoring/debugging.
 */
export function getCacheStats(): { size: number; maxSize: number } {
  return getSharedCacheStats()
}

/**
 * Type guard for FeatureFlag enum.
 */
export function isValidFeatureFlag(value: string): value is FeatureFlag {
  return Object.values(FeatureFlag).includes(value as FeatureFlag)
}
