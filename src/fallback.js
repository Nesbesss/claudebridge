const { getProviderById } = require('./providers');

/* ── Circuit Breaker States ───────────────────────────────── */

const CIRCUIT_STATE = {
  CLOSED: 'closed',       // Normal, requests flow through
  OPEN: 'open',           // Failing, reject immediately
  HALF_OPEN: 'half-open', // Testing recovery
};

/* ── Circuit Breaker ──────────────────────────────────────── */

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeMs = options.resetTimeMs || 60000;  // 1 min
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts || 1;

    this.state = CIRCUIT_STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenAttempts = 0;
  }

  canRequest() {
    if (this.state === CIRCUIT_STATE.CLOSED) return true;
    if (this.state === CIRCUIT_STATE.OPEN) {
      if (Date.now() - this.lastFailureTime >= this.resetTimeMs) {
        this.state = CIRCUIT_STATE.HALF_OPEN;
        this.halfOpenAttempts = 0;
        return true;
      }
      return false;
    }
    return this.halfOpenAttempts < this.halfOpenMaxAttempts;
  }

  recordSuccess() {
    this.failureCount = 0;
    this.successCount++;
    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this.state = CIRCUIT_STATE.CLOSED;
    }
  }

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this.state = CIRCUIT_STATE.OPEN;
      this.halfOpenAttempts++;
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = CIRCUIT_STATE.OPEN;
    }
  }

  getStatus() {
    return {
      state: this.state,
      failures: this.failureCount,
      successes: this.successCount,
      lastFailure: this.lastFailureTime ? new Date(this.lastFailureTime).toLocaleTimeString() : null,
    };
  }

  reset() {
    this.state = CIRCUIT_STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.halfOpenAttempts = 0;
  }
}

/* ── Fallback Chain ───────────────────────────────────────── */

class FallbackChain {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.maxRetries = options.maxRetries || 2;
    this.retryDelayMs = options.retryDelayMs || 1000;
    this.backoffMultiplier = options.backoffMultiplier || 2;
    this.maxRetryDelayMs = options.maxRetryDelayMs || 10000;

    this.chain = options.chain || [];
    this.breakers = new Map();
    this.providerKeys = new Map();

    this.stats = {
      totalFallbacks: 0,
      totalRetries: 0,
      byProvider: {},
    };
  }

  /** Set the fallback chain order */
  setChain(providerIds) {
    this.chain = providerIds.filter(id => getProviderById(id));
  }

  /** Set an API key for a specific provider */
  setProviderKey(providerId, apiKey) {
    this.providerKeys.set(providerId, apiKey);
  }

  /** Get or create circuit breaker for a provider */
  getBreaker(providerId) {
    if (!this.breakers.has(providerId)) {
      this.breakers.set(providerId, new CircuitBreaker());
    }
    return this.breakers.get(providerId);
  }

  /** Execute a request with fallback support. */
  async execute(requestFn, primary) {
    if (!this.enabled) {
      const response = await this._retryRequest(requestFn, primary);
      return { response, usedProvider: primary.provider, usedModel: primary.model, attempts: 1, fallbackUsed: false };
    }

    const attempts = [primary];
    for (const chainId of this.chain) {
      if (chainId === primary.provider) continue;
      const p = getProviderById(chainId);
      if (!p) continue;
      const key = this.providerKeys.get(chainId) || primary.apiKey;
      attempts.push({
        provider: chainId,
        providerLabel: p.label,
        model: p.model,
        baseUrl: p.baseUrl,
        chatPath: p.chatPath,
        apiKey: key,
      });
    }

    let lastError = null;
    let attemptCount = 0;

    for (const target of attempts) {
      const breaker = this.getBreaker(target.provider);
      if (!breaker.canRequest()) continue;

      attemptCount++;
      try {
        const response = await this._retryRequest(requestFn, target);
        breaker.recordSuccess();

        if (!this.stats.byProvider[target.provider]) {
          this.stats.byProvider[target.provider] = { successes: 0, failures: 0 };
        }
        this.stats.byProvider[target.provider].successes++;

        const fallbackUsed = target.provider !== primary.provider;
        if (fallbackUsed) this.stats.totalFallbacks++;

        return {
          response,
          usedProvider: target.provider,
          usedProviderLabel: target.providerLabel || target.provider,
          usedModel: target.model,
          usedBaseUrl: target.baseUrl,
          usedChatPath: target.chatPath,
          usedApiKey: target.apiKey,
          attempts: attemptCount,
          fallbackUsed,
        };
      } catch (err) {
        lastError = err;
        breaker.recordFailure();

        if (!this.stats.byProvider[target.provider]) {
          this.stats.byProvider[target.provider] = { successes: 0, failures: 0 };
        }
        this.stats.byProvider[target.provider].failures++;
      }
    }

    throw lastError || new Error('All providers in fallback chain failed');
  }

  /** Retry a single request with exponential backoff */
  async _retryRequest(requestFn, target) {
    let lastError = null;
    let delay = this.retryDelayMs;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await requestFn(target);
      } catch (err) {
        lastError = err;
        this.stats.totalRetries++;

        if (err.status && err.status >= 400 && err.status < 500) {
          throw err;
        }

        if (attempt < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * this.backoffMultiplier, this.maxRetryDelayMs);
        }
      }
    }

    throw lastError;
  }

  /** Get chain status */
  getStatus() {
    const chainDetails = this.chain.map(id => {
      const p = getProviderById(id);
      const breaker = this.breakers.get(id)?.getStatus() || null;
      return {
        id,
        label: p?.label || id,
        hasKey: this.providerKeys.has(id),
        circuit: breaker,
      };
    });

    return {
      enabled: this.enabled,
      chain: chainDetails,
      maxRetries: this.maxRetries,
      stats: { ...this.stats },
    };
  }

  /** Reset all circuit breakers */
  resetBreakers() {
    this.breakers.forEach(breaker => breaker.reset());
  }
}

module.exports = {
  FallbackChain,
  CircuitBreaker,
  CIRCUIT_STATE,
};
