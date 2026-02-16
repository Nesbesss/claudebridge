/* ═══════════════════════════════════════════════════════════════
   ClaudeBridge — Profile System
   ═══════════════════════════════════════════════════════════════
   Named configs for different use cases:
   • "work"     → DeepSeek for code, budget-conscious
   • "personal" → OpenRouter with GPT-4o, no limits
   • "fast"     → Groq for speed
   • "local"    → Ollama, fully offline
   
   Profiles are stored in ~/.claudebridge/profiles/
   ═══════════════════════════════════════════════════════════════ */

const fs = require('node:fs');
const path = require('node:path');

const PROFILES_DIR = path.join(os.homedir(), '.claudebridge', 'profiles');
const ACTIVE_PROFILE_PATH = path.join(os.homedir(), '.claudebridge', 'active-profile');

/* ── Built-in Profile Templates ───────────────────────────── */

const PROFILE_TEMPLATES = {
  /* ── Speed Profiles ─────────────────────────────────── */
  fast: {
    name: 'fast',
    description: '⚡ Fastest inference — Groq/Cerebras',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com',
    chatPath: '/openai/v1/chat/completions',
    routing: false,
    cache: true,
    fallbackChain: ['cerebras', 'sambanova', 'fireworks'],
    budgetLimit: null,
  },
  turbo: {
    name: 'turbo',
    description: '🏎️ Ultra-low latency — Cerebras Wafer',
    provider: 'cerebras',
    model: 'llama-3.3-70b',
    baseUrl: 'https://api.cerebras.ai',
    chatPath: '/v1/chat/completions',
    routing: false,
    cache: true,
    fallbackChain: ['groq', 'sambanova'],
    budgetLimit: null,
  },

  /* ── Cost Profiles ──────────────────────────────────── */
  budget: {
    name: 'budget',
    description: '💰 Cheapest — free/ultra-low cost models',
    provider: 'opencode-zen',
    model: 'minimax/minimax-2.5-chat',
    baseUrl: 'https://opencode.ai',
    chatPath: '/zen/v1/chat/completions',
    routing: false,
    cache: true,
    fallbackChain: [],
    budgetLimit: 0.50,
  },
  free: {
    name: 'free',
    description: '🆓 Zero cost — free tier providers only',
    provider: 'opencode-zen',
    model: 'minimax/minimax-2.5-chat',
    baseUrl: 'https://opencode.ai',
    chatPath: '/zen/v1/chat/completions',
    routing: false,
    cache: true,
    fallbackChain: ['groq', 'sambanova', 'cerebras'],
    budgetLimit: 0,
  },

  /* ── Intelligence Profiles ──────────────────────────── */
  smart: {
    name: 'smart',
    description: '🧠 Smart routing — best model per task',
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    baseUrl: 'https://openrouter.ai',
    chatPath: '/api/v1/chat/completions',
    routing: true,
    cache: true,
    fallbackChain: ['openai', 'deepseek', 'groq'],
    budgetLimit: 5.00,
  },
  genius: {
    name: 'genius',
    description: '🎓 Maximum quality — GPT-4o + reasoning',
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com',
    chatPath: '/v1/chat/completions',
    routing: true,
    cache: true,
    fallbackChain: ['openrouter', 'deepseek'],
    budgetLimit: 20.00,
  },
  think: {
    name: 'think',
    description: '🤔 Deep reasoning — DeepSeek R1 style',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/v1/chat/completions',
    routing: false,
    cache: true,
    fallbackChain: ['openrouter', 'together'],
    budgetLimit: 5.00,
  },

  /* ── Coding Profiles ────────────────────────────────── */
  code: {
    name: 'code',
    description: '💻 Optimized for coding — DeepSeek Coder',
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/v1/chat/completions',
    routing: false,
    cache: true,
    fallbackChain: ['fireworks', 'together', 'groq'],
    budgetLimit: 2.00,
  },
  fullstack: {
    name: 'fullstack',
    description: '🌐 Web dev — routing + fallbacks + budget',
    provider: 'openrouter',
    model: 'anthropic/claude-3.5-sonnet',
    baseUrl: 'https://openrouter.ai',
    chatPath: '/api/v1/chat/completions',
    routing: true,
    cache: true,
    fallbackChain: ['deepseek', 'fireworks', 'groq'],
    budgetLimit: 10.00,
  },

  /* ── Local/Private Profiles ─────────────────────────── */
  local: {
    name: 'local',
    description: '🦙 Fully offline — Ollama',
    provider: 'ollama',
    model: 'llama3.3',
    baseUrl: 'http://localhost:11434',
    chatPath: '/v1/chat/completions',
    routing: false,
    cache: false,
    fallbackChain: ['lmstudio', 'llamacpp'],
    budgetLimit: null,
  },
  private: {
    name: 'private',
    description: '🔒 Privacy-first — local with LM Studio',
    provider: 'lmstudio',
    model: 'local-model',
    baseUrl: 'http://localhost:1234',
    chatPath: '/v1/chat/completions',
    routing: false,
    cache: false,
    fallbackChain: ['ollama', 'llamacpp', 'jan'],
    budgetLimit: null,
  },

  /* ── Specialty Profiles ─────────────────────────────── */
  research: {
    name: 'research',
    description: '🔬 Research — Perplexity search + reasoning',
    provider: 'perplexity',
    model: 'sonar',
    baseUrl: 'https://api.perplexity.ai',
    chatPath: '/chat/completions',
    routing: false,
    cache: false,
    fallbackChain: ['openrouter', 'openai'],
    budgetLimit: 3.00,
  },
  creative: {
    name: 'creative',
    description: '🎨 Creative writing — Mistral + high temp',
    provider: 'mistral',
    model: 'mistral-large-latest',
    baseUrl: 'https://api.mistral.ai',
    chatPath: '/v1/chat/completions',
    routing: false,
    cache: false,
    fallbackChain: ['openrouter', 'together'],
    budgetLimit: 5.00,
  },
  grok: {
    name: 'grok',
    description: '✴️ xAI Grok — witty + uncensored',
    provider: 'xai',
    model: 'grok-2-latest',
    baseUrl: 'https://api.x.ai',
    chatPath: '/v1/chat/completions',
    routing: false,
    cache: true,
    fallbackChain: ['openrouter'],
    budgetLimit: 5.00,
  },
  balanced: {
    name: 'balanced',
    description: '⚖️ Best of everything — smart + safe + cheap',
    provider: 'openrouter',
    model: 'openai/gpt-4o-mini',
    baseUrl: 'https://openrouter.ai',
    chatPath: '/api/v1/chat/completions',
    routing: true,
    cache: true,
    fallbackChain: ['deepseek', 'groq', 'together', 'fireworks'],
    budgetLimit: 3.00,
  },
};

/* ── Profile Manager ──────────────────────────────────────── */

class ProfileManager {
  constructor() {
    this._ensureDir();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
    } catch { /* best effort */ }
  }

  /** List all profiles (built-in + custom) */
  list() {
    const profiles = [];

    // Built-in templates
    for (const [id, tmpl] of Object.entries(PROFILE_TEMPLATES)) {
      profiles.push({ ...tmpl, id, builtin: true });
    }

    // Custom profiles from disk
    try {
      const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, file), 'utf8'));
          const id = file.replace('.json', '');
          // Custom profiles override built-in ones with same name
          const existingIdx = profiles.findIndex(p => p.id === id);
          const profile = { ...content, id, builtin: false };
          if (existingIdx >= 0) {
            profiles[existingIdx] = profile;
          } else {
            profiles.push(profile);
          }
        } catch { /* skip invalid files */ }
      }
    } catch { /* no profiles dir yet */ }

    return profiles;
  }

  /** Get a specific profile by id */
  get(id) {
    // Check custom first
    const customPath = path.join(PROFILES_DIR, `${id}.json`);
    if (fs.existsSync(customPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(customPath, 'utf8'));
        return { ...content, id, builtin: false };
      } catch { /* fall through */ }
    }

    // Check built-in
    if (PROFILE_TEMPLATES[id]) {
      return { ...PROFILE_TEMPLATES[id], id, builtin: true };
    }

    return null;
  }

  /** Save a custom profile */
  save(id, profileData) {
    this._ensureDir();
    const filePath = path.join(PROFILES_DIR, `${id}.json`);
    const data = { ...profileData, name: id, updatedAt: new Date().toISOString() };
    // Don't persist API keys in profile files
    delete data.apiKey;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    try { fs.chmodSync(filePath, 0o600); } catch { /* ok */ }
    return data;
  }

  /** Delete a custom profile */
  delete(id) {
    const filePath = path.join(PROFILES_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  }

  /** Get active profile name */
  getActive() {
    try {
      if (fs.existsSync(ACTIVE_PROFILE_PATH)) {
        return fs.readFileSync(ACTIVE_PROFILE_PATH, 'utf8').trim();
      }
    } catch { /* no active profile */ }
    return null;
  }

  /** Set active profile */
  setActive(id) {
    const profile = this.get(id);
    if (!profile) throw new Error(`Profile '${id}' not found`);
    this._ensureDir();
    fs.writeFileSync(ACTIVE_PROFILE_PATH, id, 'utf8');
    return profile;
  }

  /** Clear active profile */
  clearActive() {
    try {
      if (fs.existsSync(ACTIVE_PROFILE_PATH)) {
        fs.unlinkSync(ACTIVE_PROFILE_PATH);
      }
    } catch { /* ok */ }
  }

  /** Convert profile to bridge config */
  toConfig(profile, apiKey) {
    return {
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl,
      chatPath: profile.chatPath,
      apiKey: apiKey || '',
      routing: profile.routing || false,
      fallbackChain: profile.fallbackChain || [],
      budgetLimit: profile.budgetLimit ?? null,
      port: profile.port || 8787,
    };
  }

  /** Create profile from current config */
  fromConfig(name, cfg) {
    return {
      name,
      description: `Custom profile created ${new Date().toLocaleDateString()}`,
      provider: cfg.provider || 'custom',
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      chatPath: cfg.chatPath,
      routing: cfg.routing || false,
      fallbackChain: cfg.fallbackChain || [],
      budgetLimit: cfg.budgetLimit ?? null,
    };
  }
}

module.exports = {
  ProfileManager,
  PROFILE_TEMPLATES,
  PROFILES_DIR,
};
