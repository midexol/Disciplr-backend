import Redis from 'ioredis';
import { getEnv } from '../config/env.js';

class InMemoryLRUCache {
  private cache = new Map<string, { version: string; data: any; expiresAt: number }>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  async get(key: string): Promise<any | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Refresh LRU order: delete and re-insert
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.data;
  }

  async set(key: string, data: any, expiresAt: number): Promise<void> {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key in insertion order)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { version: CACHE_VERSION, data, expiresAt });
  }

  async invalidate(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  size(): number {
    // Clean expired entries first before returning size to be accurate
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

const CACHE_VERSION = 'v1';

let initialized = false;
let redisClient: Redis | null = null;
let memoryCache: InMemoryLRUCache | null = null;

function getCacheProvider() {
  if (!initialized) {
    try {
      const env = getEnv();
      if (env.REDIS_URL) {
        redisClient = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 3,
        });
        redisClient.on('error', (err) => {
          console.error('Redis client error:', err);
        });
      } else {
        memoryCache = new InMemoryLRUCache();
      }
    } catch {
      // Fallback if env is not validated/initialized yet (e.g. in test setup)
      memoryCache = new InMemoryLRUCache();
    }
    initialized = true;
  }
  return { redisClient, memoryCache };
}

export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>
): Promise<T> {
  const { redisClient, memoryCache } = getCacheProvider();

  if (redisClient) {
    try {
      const cached = await redisClient.get(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.version === CACHE_VERSION) {
          return parsed.data as T;
        }
      }
    } catch (error) {
      console.warn(`Redis get failed for key ${key}:`, error);
    }
  } else if (memoryCache) {
    const cachedData = await memoryCache.get(key);
    if (cachedData !== null) {
      return cachedData as T;
    }
  }

  // Miss: load
  const data = await loader();

  // Save
  const entry = { version: CACHE_VERSION, data };
  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(entry), 'EX', ttlSeconds);
    } catch (error) {
      console.warn(`Redis set failed for key ${key}:`, error);
    }
  } else if (memoryCache) {
    await memoryCache.set(key, data, Date.now() + ttlSeconds * 1000);
  }

  return data;
}

export async function invalidate(key: string): Promise<void> {
  const { redisClient, memoryCache } = getCacheProvider();
  if (redisClient) {
    try {
      await redisClient.del(key);
    } catch (error) {
      console.warn(`Redis del failed for key ${key}:`, error);
    }
  } else if (memoryCache) {
    await memoryCache.invalidate(key);
  }
}

export async function invalidatePrefix(prefix: string): Promise<void> {
  const { redisClient, memoryCache } = getCacheProvider();
  if (redisClient) {
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redisClient.del(...keys);
        }
      } while (cursor !== '0');
    } catch (error) {
      console.warn(`Redis invalidatePrefix failed for prefix ${prefix}:`, error);
    }
  } else if (memoryCache) {
    await memoryCache.invalidatePrefix(prefix);
  }
}

export function getCacheStats(): { size: number; maxSize: number } {
  const { memoryCache } = getCacheProvider();
  if (memoryCache) {
    return { size: memoryCache.size(), maxSize: 1000 };
  }
  return { size: 0, maxSize: 1000 };
}

export async function closeCache(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch (error) {
      // Ignore
    }
    redisClient = null;
  }
  if (memoryCache) {
    memoryCache.clear();
    memoryCache = null;
  }
  initialized = false;
}
