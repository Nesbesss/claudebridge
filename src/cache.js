/* ═══════════════════════════════════════════════════════════════
   ClaudeBridge — Response Cache
   ═══════════════════════════════════════════════════════════════
   In-memory + on-disk LRU cache for identical requests.
   • Saves money on repeated queries
   • Instant responses for cached hits
   • Configurable TTL, max size, model-specific rules
   • Cache-aware $$ commands ($$cache status/clear)
   ═══════════════════════════════════════════════════════════════ */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/* ── Cache Entry ──────────────────────────────────────────── */

class CacheEntry {
  constructor(key, value, metadata = {}) {
    this.key = key;
    this.value = value;
    this.metadata = metadata;
    this.createdAt = Date.now();
    this.lastAccessedAt = Date.now();
    this.hitCount = 0;
  }

  isExpired(ttlMs) {
    return Date.now() - this.createdAt > ttlMs;
  }

  touch() {
    this.lastAccessedAt = Date.now();
    this.hitCount++;
  }
}

/* ── Response Cache ───────────────────────────────────────── */

class ResponseCache {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.maxEntries = options.maxEntries || 500;
    this.ttlMs = options.ttlMs || 30 * 60 * 1000;  // 30 min default
    this.persistDir = options.persistDir || path.join(os.homedir(), '.claudebridge', 'cache');
    this.persist = options.persist || false;

    // In-memory LRU cache
    this.entries = new Map();

    // Stats
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      totalSaved: 0,  // estimated cost saved
    };

    // Models that should NOT be cached (e.g., web search models)
    this.noCacheModels = new Set(options.noCacheModels || ['sonar', 'sonar-pro']);

    if (this.persist) this._ensureDir();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.persistDir, { recursive: true, mode: 0o700 });
    } catch { /* best effort */ }
  }

  /** Generate cache key from request */
  makeKey(model, messages, temperature) {
    // Normalize the request into a deterministic key
    const normalized = JSON.stringify({
      model,
      messages: (messages || []).map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      temperature: temperature || 0,
    });
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  }

  /** Get cached response */
  get(model, messages, temperature) {
    if (!this.enabled) return null;
    if (this.noCacheModels.has(model)) return null;

    const key = this.makeKey(model, messages, temperature);
    const entry = this.entries.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (entry.isExpired(this.ttlMs)) {
      this.entries.delete(key);
      this.stats.misses++;
      return null;
    }

    entry.touch();
    this.stats.hits++;

    // Move to end (most recently used) by re-inserting
    this.entries.delete(key);
    this.entries.set(key, entry);

    return {
      cached: true,
      value: entry.value,
      metadata: entry.metadata,
      age: Date.now() - entry.createdAt,
      hitCount: entry.hitCount,
    };
  }

  /** Store response in cache */
  set(model, messages, temperature, response, metadata = {}) {
    if (!this.enabled) return;
    if (this.noCacheModels.has(model)) return;

    const key = this.makeKey(model, messages, temperature);

    // Evict oldest if at capacity
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      this.stats.evictions++;
    }

    const entry = new CacheEntry(key, response, metadata);
    this.entries.set(key, entry);

    // Persist to disk if enabled
    if (this.persist) {
      this._persistEntry(key, entry);
    }
  }

  /** Persist a single entry to disk */
  _persistEntry(key, entry) {
    try {
      const filePath = path.join(this.persistDir, `${key}.json`);
      fs.writeFileSync(filePath, JSON.stringify({
        value: entry.value,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      }), 'utf8');
    } catch { /* best effort */ }
  }

  /** Clear all cache entries */
  clear() {
    const count = this.entries.size;
    this.entries.clear();

    // Clear disk cache
    if (this.persist) {
      try {
        const files = fs.readdirSync(this.persistDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try { fs.unlinkSync(path.join(this.persistDir, file)); } catch { /* ok */ }
        }
      } catch { /* ok */ }
    }

    return count;
  }

  /** Get cache stats */
  getStats() {
    const hitRate = (this.stats.hits + this.stats.misses) > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(1)
      : '0.0';

    return {
      enabled: this.enabled,
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: `${hitRate}%`,
      evictions: this.stats.evictions,
      totalSaved: this.stats.totalSaved,
      ttlMs: this.ttlMs,
      ttlFormatted: `${Math.round(this.ttlMs / 60000)}m`,
    };
  }

  /** Record cost savings from a cache hit */
  recordSaving(costSaved) {
    this.stats.totalSaved += costSaved;
  }

  /** Get status one-liner */
  getStatusLine() {
    const s = this.getStats();
    return `${s.entries}/${s.maxEntries} entries | ${s.hitRate} hit rate | ${s.hits} hits`;
  }
}

module.exports = {
  ResponseCache,
};
