const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/* ── Pricing database ($/1M tokens) ───────────────────────── */
// Prices as of early 2026, best-effort. Users can override.
const MODEL_PRICING = {
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'o1': { input: 15.00, output: 60.00 },
  'o1-mini': { input: 3.00, output: 12.00 },
  'o3-mini': { input: 1.10, output: 4.40 },

  // Anthropic (for tracking if used via proxy/routing)
  'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-5-haiku': { input: 0.80, output: 4.00 },
  'claude-3-opus': { input: 15.00, output: 75.00 },
  'claude-3-sonnet': { input: 3.00, output: 15.00 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },

  // DeepSeek
  'deepseek-chat': { input: 0.14, output: 0.28 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },

  // Meta Llama (via inference providers)
  'llama-3.3-70b': { input: 0.60, output: 0.80 },
  'llama-3.1-405b': { input: 3.00, output: 3.00 },
  'llama-3.1-70b': { input: 0.60, output: 0.80 },
  'llama-3.1-8b': { input: 0.10, output: 0.10 },

  // Mistral
  'mistral-small-latest': { input: 0.10, output: 0.30 },
  'mistral-large-latest': { input: 2.00, output: 6.00 },
  'pixtral-12b': { input: 0.15, output: 0.15 },

  // Groq / Cerebras / Together / Fireworks
  'llama3-70b-8192': { input: 0.60, output: 0.80 },
  'qwen2.5-72b': { input: 0.35, output: 0.40 },

  // xAI
  'grok-2-latest': { input: 2.00, output: 10.00 },

  // Perplexity
  'sonar': { input: 1.00, output: 1.00 },

  // MiniMax
  'minimax/minimax-2.5-chat': { input: 0.00, output: 0.00 }, // free tier or covered
  'minimax-m2.5-free': { input: 0.00, output: 0.00 },

  // Local models (free)
  'llama3.3': { input: 0.00, output: 0.00 },
  'local-model': { input: 0.00, output: 0.00 },
};

// Fallback pricing for unknown models
const DEFAULT_PRICING = { input: 1.00, output: 3.00 };

/* ── Tracker Class ────────────────────────────────────────── */

class CostTracker {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.dataDir = options.dataDir || path.join(os.homedir(), '.claudebridge');
    this.customPricing = options.pricing || {};
    this.budgetLimit = options.budgetLimit || null; // $ per session, null = no limit
    this.budgetWarningPct = options.budgetWarningPct || 0.8;

    // Session stats
    this.session = {
      startTime: Date.now(),
      requests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalLatencyMs: 0,
      totalTTFTMs: 0,
      ttftCount: 0,
      totalTokensStreamed: 0,
      totalStreamTimeMs: 0,
      byModel: {},
      byProvider: {},
      errors: 0,
      history: [], // last N requests
    };

    this.maxHistory = 100;
    this._ensureDataDir();
  }

  _ensureDataDir() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    } catch { /* best effort */ }
  }

  /** Get pricing for a model */
  getPricing(model) {
    if (!model) return DEFAULT_PRICING;
    // Check custom pricing first
    if (this.customPricing[model]) return this.customPricing[model];
    // Check built-in
    if (MODEL_PRICING[model]) return MODEL_PRICING[model];
    // Try partial match (strip provider prefix)
    const shortName = model.split('/').pop();
    if (MODEL_PRICING[shortName]) return MODEL_PRICING[shortName];
    // Try fuzzy match
    const modelLower = model.toLowerCase();
    for (const [key, val] of Object.entries(MODEL_PRICING)) {
      if (modelLower.includes(key.toLowerCase()) || key.toLowerCase().includes(modelLower)) return val;
    }
    return DEFAULT_PRICING;
  }

  /** Calculate cost for a request */
  calculateCost(model, inputTokens, outputTokens) {
    const pricing = this.getPricing(model);
    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;
    return { inputCost, outputCost, totalCost: inputCost + outputCost, pricing };
  }

  /** Record a completed request */
  record(data) {
    if (!this.enabled) return null;

    const {
      model = 'unknown',
      provider = 'unknown',
      inputTokens = 0,
      outputTokens = 0,
      latencyMs = 0,
      ttftMs = 0,
      streamTokens = 0,
      streamTimeMs = 0,
      taskType = 'default',
      cached = false,
      error = false,
    } = data;

    const cost = this.calculateCost(model, inputTokens, outputTokens);

    // Update session totals
    this.session.requests++;
    this.session.totalInputTokens += inputTokens;
    this.session.totalOutputTokens += outputTokens;
    this.session.totalCost += cost.totalCost;
    this.session.totalLatencyMs += latencyMs;
    if (ttftMs > 0) {
      this.session.totalTTFTMs += ttftMs;
      this.session.ttftCount++;
    }
    if (streamTokens > 0 && streamTimeMs > 0) {
      this.session.totalTokensStreamed += streamTokens;
      this.session.totalStreamTimeMs += streamTimeMs;
    }
    if (error) this.session.errors++;

    // By-model stats
    if (!this.session.byModel[model]) {
      this.session.byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, totalLatencyMs: 0 };
    }
    const ms = this.session.byModel[model];
    ms.requests++;
    ms.inputTokens += inputTokens;
    ms.outputTokens += outputTokens;
    ms.cost += cost.totalCost;
    ms.totalLatencyMs += latencyMs;

    // By-provider stats
    if (!this.session.byProvider[provider]) {
      this.session.byProvider[provider] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, totalLatencyMs: 0 };
    }
    const ps = this.session.byProvider[provider];
    ps.requests++;
    ps.inputTokens += inputTokens;
    ps.outputTokens += outputTokens;
    ps.cost += cost.totalCost;
    ps.totalLatencyMs += latencyMs;

    // History
    const entry = {
      timestamp: Date.now(),
      model,
      provider,
      inputTokens,
      outputTokens,
      cost: cost.totalCost,
      latencyMs,
      ttftMs,
      tokensPerSec: streamTimeMs > 0 ? Math.round((streamTokens / streamTimeMs) * 1000) : 0,
      taskType,
      cached,
      error,
    };
    this.session.history.push(entry);
    if (this.session.history.length > this.maxHistory) {
      this.session.history = this.session.history.slice(-this.maxHistory);
    }

    // Budget check
    const budgetStatus = this._checkBudget();

    return { cost, entry, budgetStatus };
  }

  /** Check budget status */
  _checkBudget() {
    if (!this.budgetLimit) return { ok: true, status: 'no-limit' };
    const pct = this.session.totalCost / this.budgetLimit;
    if (pct >= 1.0) return { ok: false, status: 'exceeded', pct, remaining: 0 };
    if (pct >= this.budgetWarningPct) return { ok: true, status: 'warning', pct, remaining: this.budgetLimit - this.session.totalCost };
    return { ok: true, status: 'ok', pct, remaining: this.budgetLimit - this.session.totalCost };
  }

  /** Get session summary */
  getSummary() {
    const s = this.session;
    const elapsed = Date.now() - s.startTime;
    const avgLatency = s.requests > 0 ? Math.round(s.totalLatencyMs / s.requests) : 0;
    const avgTTFT = s.ttftCount > 0 ? Math.round(s.totalTTFTMs / s.ttftCount) : 0;
    const avgTokensPerSec = s.totalStreamTimeMs > 0 ? Math.round((s.totalTokensStreamed / s.totalStreamTimeMs) * 1000) : 0;

    return {
      uptime: elapsed,
      uptimeFormatted: formatDuration(elapsed),
      requests: s.requests,
      errors: s.errors,
      totalInputTokens: s.totalInputTokens,
      totalOutputTokens: s.totalOutputTokens,
      totalTokens: s.totalInputTokens + s.totalOutputTokens,
      totalCost: s.totalCost,
      totalCostFormatted: formatCost(s.totalCost),
      avgLatencyMs: avgLatency,
      avgTTFTMs: avgTTFT,
      avgTokensPerSec: avgTokensPerSec,
      byModel: s.byModel,
      byProvider: s.byProvider,
      budget: this._checkBudget(),
      recentHistory: s.history.slice(-10),
    };
  }

  /** Get a compact one-liner for status display */
  getStatusLine() {
    const s = this.session;
    const tokens = s.totalInputTokens + s.totalOutputTokens;
    const cost = formatCost(s.totalCost);
    const reqs = s.requests;
    const avgTPS = s.totalStreamTimeMs > 0 ? Math.round((s.totalTokensStreamed / s.totalStreamTimeMs) * 1000) : 0;
    return `${reqs} reqs | ${formatTokens(tokens)} tokens | ${cost} | ${avgTPS} tok/s`;
  }

  /** Save session stats to disk */
  saveSession() {
    try {
      const filePath = path.join(this.dataDir, 'stats.json');
      const existing = this._loadAllTimeStats();

      existing.totalRequests = (existing.totalRequests || 0) + this.session.requests;
      existing.totalInputTokens = (existing.totalInputTokens || 0) + this.session.totalInputTokens;
      existing.totalOutputTokens = (existing.totalOutputTokens || 0) + this.session.totalOutputTokens;
      existing.totalCost = (existing.totalCost || 0) + this.session.totalCost;
      existing.sessions = (existing.sessions || 0) + 1;
      existing.lastUpdated = new Date().toISOString();

      // Merge by-model stats
      if (!existing.byModel) existing.byModel = {};
      for (const [model, stats] of Object.entries(this.session.byModel)) {
        if (!existing.byModel[model]) existing.byModel[model] = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
        existing.byModel[model].requests += stats.requests;
        existing.byModel[model].inputTokens += stats.inputTokens;
        existing.byModel[model].outputTokens += stats.outputTokens;
        existing.byModel[model].cost += stats.cost;
      }

      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf8');
      try { fs.chmodSync(filePath, 0o600); } catch { /* ok */ }
    } catch { /* best effort */ }
  }

  /** Load all-time stats from disk */
  _loadAllTimeStats() {
    try {
      const filePath = path.join(this.dataDir, 'stats.json');
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch { /* fresh start */ }
    return {};
  }

  /** Get all-time stats */
  getAllTimeStats() {
    const stats = this._loadAllTimeStats();
    return {
      ...stats,
      totalCostFormatted: formatCost(stats.totalCost || 0),
      totalTokens: (stats.totalInputTokens || 0) + (stats.totalOutputTokens || 0),
    };
  }

  /** Reset session stats */
  resetSession() {
    this.saveSession();
    this.session = {
      startTime: Date.now(),
      requests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      totalLatencyMs: 0,
      totalTTFTMs: 0,
      ttftCount: 0,
      totalTokensStreamed: 0,
      totalStreamTimeMs: 0,
      byModel: {},
      byProvider: {},
      errors: 0,
      history: [],
    };
  }
}

/* ── Formatting Helpers ───────────────────────────────────── */

const formatCost = (cost) => {
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
};

const formatTokens = (n) => {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
};

const formatDuration = (ms) => {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
};

module.exports = {
  CostTracker,
  MODEL_PRICING,
  formatCost,
  formatTokens,
  formatDuration,
};
