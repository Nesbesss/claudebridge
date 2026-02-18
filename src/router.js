const { PROVIDERS, getProviderById } = require('./providers');

/* ── Task Type Classifiers ─────────────────────────────────── */

const TASK_TYPES = {
  think: { label: 'Deep Thinking', icon: '🧠', description: 'Complex reasoning, math, logic puzzles' },
  code: { label: 'Code', icon: '💻', description: 'Code generation, debugging, refactoring' },
  quick: { label: 'Quick', icon: '⚡', description: 'Simple questions, translations, lookups' },
  creative: { label: 'Creative', icon: '🎨', description: 'Writing, brainstorming, storytelling' },
  longContext: { label: 'Long Context', icon: '📄', description: 'Large file analysis, summarization' },
  webSearch: { label: 'Web Search', icon: '🔍', description: 'Questions requiring current information' },
  image: { label: 'Image', icon: '🖼️', description: 'Image analysis or generation' },
  default: { label: 'General', icon: '💬', description: 'General conversation' },
};

// Keyword patterns for task classification
const TASK_PATTERNS = {
  think: {
    keywords: [
      /\b(think|reason|explain why|prove|analyze|evaluate|compare and contrast)\b/i,
      /\b(step[- ]by[- ]step|chain of thought|let'?s think|work through)\b/i,
      /\b(mathematical|equation|calcul|algebra|geometry|theorem|proof)\b/i,
      /\b(logic|puzzle|riddle|brain ?teaser|paradox)\b/i,
      /\b(critique|assess|weigh the pros|trade[- ]?off)\b/i,
    ],
    minScore: 2,
  },
  code: {
    keywords: [
      /\b(code|function|class|method|variable|algorithm|implement|refactor)\b/i,
      /\b(debug|error|bug|fix|patch|stack ?trace|exception|crash)\b/i,
      /\b(javascript|typescript|python|rust|go|java|c\+\+|ruby|swift|kotlin)\b/i,
      /\b(react|vue|angular|node|express|django|flask|rails|spring)\b/i,
      /\b(api|endpoint|database|sql|query|schema|migration)\b/i,
      /\b(git|commit|merge|branch|pull request|PR|CI\/CD)\b/i,
      /\b(test|unit test|integration test|e2e|jest|mocha|pytest)\b/i,
      /```[\s\S]*```/, // code blocks
      /\b(npm|pip|cargo|brew|apt|yarn|pnpm)\b/i,
      /\b(dockerfile|docker|kubernetes|k8s|terraform|aws|gcp|azure)\b/i,
    ],
    minScore: 2,
  },
  quick: {
    keywords: [
      /^(what is|who is|when was|where is|how many|how much|define)\b/i,
      /^(yes or no|true or false|is it)\b/i,
      /\b(translate|convert|what does .{1,20} mean)\b/i,
      /^.{0,60}$/, // very short messages
    ],
    minScore: 2,
  },
  creative: {
    keywords: [
      /\b(write|compose|draft|create|generate|brainstorm|imagine)\b/i,
      /\b(story|poem|essay|article|blog|script|screenplay|novel)\b/i,
      /\b(creative|fiction|narrative|character|plot|dialogue)\b/i,
      /\b(marketing|slogan|tagline|pitch|ad copy|branding)\b/i,
      /\b(song|lyrics|haiku|limerick|sonnet)\b/i,
    ],
    minScore: 2,
  },
  longContext: {
    keywords: [
      /\b(summarize|summary|overview|key points|tl;?dr|digest)\b/i,
      /\b(entire file|whole document|full text|all of|complete)\b/i,
      /\b(analyze this|review this|look at this|read through)\b/i,
    ],
    minScore: 1,
    minTokens: 4000,
  },
  webSearch: {
    keywords: [
      /\b(latest|newest|current|today|yesterday|this week|this month|202[4-9])\b/i,
      /\b(news|trending|update|recent|breaking)\b/i,
      /\b(price of|stock|weather|score|live|real[- ]?time)\b/i,
      /\b(search|look up|find online|google)\b/i,
    ],
    minScore: 2,
  },
  image: {
    keywords: [
      /\b(image|picture|photo|screenshot|diagram|chart|graph)\b/i,
      /\b(draw|sketch|illustrate|render|visualize|generate.*image)\b/i,
      /\b(what do you see|describe this image|ocr|extract text from)\b/i,
    ],
    minScore: 2,
  },
};

/* ── Token Estimation ─────────────────────────────────────── */

const estimateTokens = (text) => {
  if (!text) return 0;
  // Rough estimate: ~4 chars per token for English, ~2.5 for code
  const hasCode = /```[\s\S]*```/.test(text) || /\b(function|class|const|let|var|import|def )\b/.test(text);
  const ratio = hasCode ? 2.5 : 4;
  return Math.ceil(text.length / ratio);
};

/* ── Task Type Detection ──────────────────────────────────── */

const extractText = (content) => {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text || '';
        if (b?.type === 'input_text') return b.text || '';
        return '';
      })
      .join('\n');
  }
  return '';
};

const detectTaskType = (messages) => {
  if (!messages?.length) return 'default';

  // Get the last user message
  const lastMsg = messages[messages.length - 1];
  const text = extractText(lastMsg?.content || '');
  if (!text) return 'default';

  // Calculate total token count (all messages)
  const totalText = messages.map(m => extractText(m.content || '')).join('\n');
  const totalTokens = estimateTokens(totalText);

  const scores = {};

  for (const [taskType, config] of Object.entries(TASK_PATTERNS)) {
    let score = 0;
    for (const pattern of config.keywords) {
      if (pattern.test(text)) score++;
    }
    // Bonus for long context
    if (config.minTokens && totalTokens >= config.minTokens) {
      score += 2;
    }
    if (score >= config.minScore) {
      scores[taskType] = score;
    }
  }

  // Pick highest scoring task type
  if (Object.keys(scores).length === 0) return 'default';

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return sorted[0][0];
};

/* ── Routing Rules ────────────────────────────────────────── */

// Default routing table — maps task types to provider preferences
const DEFAULT_ROUTES = {
  think: { prefer: ['deepseek', 'openai', 'openrouter'], modelHint: 'deepseek-reasoner' },
  code: { prefer: ['deepseek', 'fireworks', 'groq'], modelHint: null },
  quick: { prefer: ['groq', 'cerebras', 'sambanova'], modelHint: null },
  creative: { prefer: ['openai', 'mistral', 'openrouter'], modelHint: null },
  longContext: { prefer: ['deepinfra', 'together', 'openrouter'], modelHint: null },
  webSearch: { prefer: ['perplexity', 'openrouter'], modelHint: 'sonar' },
  image: { prefer: ['openai', 'openrouter'], modelHint: 'gpt-4o' },
  default: { prefer: [], modelHint: null },
};

/* ── Router Class ─────────────────────────────────────────── */

class SmartRouter {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.routes = { ...DEFAULT_ROUTES, ...(options.routes || {}) };
    this.configuredProviders = new Set(); // providers with valid API keys
    this.stats = {
      totalRouted: 0,
      byTaskType: {},
    };
    this.lastDetection = null;
  }

  /** Register a provider as configured (has API key + endpoint) */
  addConfiguredProvider(providerId) {
    this.configuredProviders.add(providerId);
  }

  removeConfiguredProvider(providerId) {
    this.configuredProviders.delete(providerId);
  }

  /** Get routing decision for a set of messages */
  route(messages, currentProvider, currentModel) {
    if (!this.enabled) {
      return { routed: false, taskType: 'default', provider: currentProvider, model: currentModel };
    }

    const taskType = detectTaskType(messages);
    this.lastDetection = { taskType, timestamp: Date.now() };

    // Update stats
    this.stats.totalRouted++;
    this.stats.byTaskType[taskType] = (this.stats.byTaskType[taskType] || 0) + 1;

    const route = this.routes[taskType] || this.routes.default;

    // If no preferred providers or none are configured, stay with current
    if (!route.prefer || route.prefer.length === 0) {
      return { routed: false, taskType, provider: currentProvider, model: currentModel, reason: 'no route preference' };
    }

    // Find first configured preferred provider
    for (const prefId of route.prefer) {
      if (this.configuredProviders.has(prefId)) {
        const provider = getProviderById(prefId);
        if (provider) {
          const model = route.modelHint || provider.model;
          return {
            routed: true,
            taskType,
            provider: prefId,
            providerLabel: provider.label,
            model,
            baseUrl: provider.baseUrl,
            chatPath: provider.chatPath,
            reason: `${TASK_TYPES[taskType]?.label || taskType} task → ${provider.label}`,
          };
        }
      }
    }

    // No configured provider found for this route
    return { routed: false, taskType, provider: currentProvider, model: currentModel, reason: 'preferred providers not configured' };
  }

  /** Get routing stats */
  getStats() {
    return {
      enabled: this.enabled,
      totalRouted: this.stats.totalRouted,
      byTaskType: { ...this.stats.byTaskType },
      configuredProviders: [...this.configuredProviders],
      lastDetection: this.lastDetection,
    };
  }

  /** Update routing rules */
  setRoute(taskType, config) {
    if (TASK_TYPES[taskType]) {
      this.routes[taskType] = { ...this.routes[taskType], ...config };
    }
  }

  /** Export for $$ commands */
  getRoutingTable() {
    return Object.entries(TASK_TYPES).map(([type, info]) => {
      const route = this.routes[type] || {};
      const configured = (route.prefer || []).filter(p => this.configuredProviders.has(p));
      return {
        type,
        ...info,
        prefer: route.prefer || [],
        configured,
        modelHint: route.modelHint || null,
        active: configured.length > 0,
      };
    });
  }
}

module.exports = {
  SmartRouter,
  TASK_TYPES,
  detectTaskType,
  estimateTokens,
  extractText,
  DEFAULT_ROUTES,
};
