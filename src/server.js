const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dotenv = require('dotenv');

const localEnv = path.join(process.cwd(), '.env');
const globalEnv = path.join(os.homedir(), '.claudebridge.env');
dotenv.config({ path: fs.existsSync(localEnv) ? localEnv : globalEnv });
const express = require('express');
const { randomUUID } = require('node:crypto');
const { PROVIDERS, getProviderById } = require('./providers');
const { SmartRouter, TASK_TYPES, extractText } = require('./router');
const { CostTracker, formatCost, formatTokens, formatDuration } = require('./tracker');
const { FallbackChain } = require('./fallback');
const { ResponseCache } = require('./cache');
const { loadToken, getChatToken } = require('./copilot'); // NEW
const { claudeWebRequest } = require('./claude-web'); // Claude.ai Web Session

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = Number(process.env.PORT || 8787);
const ZEN_API_KEY = (process.env.ZEN_API_KEY || '').replace(/^Bearer\s+/i, '');
const ZEN_BASE_URL = (process.env.ZEN_BASE_URL || '').replace(/\/$/, '');
let _rawChatPath = (process.env.ZEN_CHAT_COMPLETIONS_PATH || '/v1/chat/completions').replace(/\/$/, '');
if (_rawChatPath && !_rawChatPath.includes('/chat/completions')) {
  _rawChatPath += '/chat/completions';
}
const ZEN_CHAT_COMPLETIONS_PATH = _rawChatPath;
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'minimax/minimax-2.5-chat';
const DEFAULT_TEMPERATURE = Number(process.env.DEFAULT_TEMPERATURE || 0.2);
const FORCE_MINIMAX_MODEL = String(process.env.FORCE_MINIMAX_MODEL || 'true').toLowerCase() !== 'false';
const BRIDGE_LOG_REQUESTS = String(process.env.BRIDGE_LOG_REQUESTS || 'false').toLowerCase() === 'true';

const ROUTING_ENABLED = String(process.env.CLAUDEBRIDGE_ROUTING || 'false').toLowerCase() === 'true';
const CACHE_ENABLED = String(process.env.CLAUDEBRIDGE_CACHE || 'true').toLowerCase() !== 'false';
const FALLBACK_ENABLED = String(process.env.CLAUDEBRIDGE_FALLBACK || 'false').toLowerCase() === 'true';
const BUDGET_LIMIT = process.env.CLAUDEBRIDGE_BUDGET ? parseFloat(process.env.CLAUDEBRIDGE_BUDGET) : null;
const FALLBACK_CHAIN_IDS = process.env.CLAUDEBRIDGE_FALLBACK_CHAIN
  ? process.env.CLAUDEBRIDGE_FALLBACK_CHAIN.split(',').map(s => s.trim())
  : [];

const router = new SmartRouter({ enabled: ROUTING_ENABLED });
const tracker = new CostTracker({ enabled: true, budgetLimit: BUDGET_LIMIT });
const fallback = new FallbackChain({ enabled: FALLBACK_ENABLED, chain: FALLBACK_CHAIN_IDS });
const cache = new ResponseCache({ enabled: CACHE_ENABLED });

let runtimeOverride = { model: null, baseUrl: null, chatPath: null, apiKey: null, providerLabel: null };
const switchHistory = [];

function getActiveModel() { return runtimeOverride.model || MINIMAX_MODEL; }
function getActiveBaseUrl() { return runtimeOverride.baseUrl || ZEN_BASE_URL; }
function getActiveChatPath() { return runtimeOverride.chatPath || ZEN_CHAT_COMPLETIONS_PATH; }
function getActiveApiKey() { return runtimeOverride.apiKey || ZEN_API_KEY; }

function anthropicContentToText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (!block) return '';
    if (typeof block === 'string') return block;
    if (block.type === 'text') return block.text || '';
    if (block.type === 'input_text') return block.text || '';
    if (typeof block.text === 'string') return block.text;
    return '';
  }).filter(Boolean).join('\n');
}

function extractReasoning(text) {
  if (!text) return { content: text, reasoning: null };
  const match = text.match(/<reasoning>([\s\S]*?)<\/reasoning>\n?/);
  if (match) {
    return {
      content: text.replace(match[0], '').trim(),
      reasoning: match[1].trim()
    };
  }
  return { content: text, reasoning: null };
}

function anthropicToolsToOpenAI(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function anthropicToOpenAI(body, supportsReasoning) {
  const systemText = anthropicContentToText(body.system);
  let mappedMessages = [];
  if (systemText) mappedMessages.push({ role: 'system', content: systemText });

  for (let i = 0; i < (body.messages || []).length; i++) {
    const msg = body.messages[i];
    const content = msg.content;

    // String content — simple text message
    if (typeof content === 'string') {
      if (supportsReasoning && msg.role === 'assistant') {
        const extracted = extractReasoning(content);
        const newMsg = { role: msg.role, content: extracted.content };
        if (extracted.reasoning) newMsg.reasoning_content = extracted.reasoning;
        mappedMessages.push(newMsg);
      } else {
        mappedMessages.push({ role: msg.role, content: content });
      }
      continue;
    }

    // Array content — may contain text, tool_use, tool_result blocks
    if (Array.isArray(content)) {
      // Separate text parts from tool parts
      const textParts = [];
      const toolUseParts = [];
      const toolResultParts = [];

      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (!block) continue;
        if (block.type === 'tool_use') {
          toolUseParts.push(block);
        } else if (block.type === 'tool_result') {
          toolResultParts.push(block);
        } else {
          // text, input_text, or other text-like blocks
          const t = block.text || (typeof block === 'string' ? block : '');
          if (t) textParts.push(t);
        }
      }

      // Assistant message with tool_use blocks → OpenAI assistant with tool_calls
      if (msg.role === 'assistant' && toolUseParts.length) {
        const assistantMsg = { role: 'assistant', content: textParts.join('\n') || null };
        if (supportsReasoning) {
          const combinedText = textParts.join('\n');
          const extracted = extractReasoning(combinedText);
          assistantMsg.content = extracted.content || null;
          if (extracted.reasoning) assistantMsg.reasoning_content = extracted.reasoning;
        }
        assistantMsg.tool_calls = toolUseParts.map(tu => {
          let inputStr;
          try {
            inputStr = typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {});
          } catch (e) {
            inputStr = '{}';
          }
          return {
            id: tu.id || ('call_' + randomUUID().replace(/-/g, '').slice(0, 24)),
            type: 'function',
            function: { name: tu.name, arguments: inputStr },
          };
        });
        mappedMessages.push(assistantMsg);
        continue;
      }

      // User message with tool_result blocks → OpenAI tool messages
      // IMPORTANT: tool messages MUST immediately follow the assistant message
      // with tool_calls. No user message can be inserted between them, or
      // providers like MiniMax will reject with "tool call result does not
      // follow tool call (2013)".
      if (toolResultParts.length) {
        for (let k = 0; k < toolResultParts.length; k++) {
          const tr = toolResultParts[k];
          let resultContent = '';
          if (typeof tr.content === 'string') {
            resultContent = tr.content;
          } else if (Array.isArray(tr.content)) {
            resultContent = tr.content.map(rc => {
              if (typeof rc === 'string') return rc;
              if (rc && rc.type === 'text') return rc.text || '';
              if (rc && rc.type === 'image') return '[image]';
              return JSON.stringify(rc);
            }).join('\n');
          }
          if (tr.is_error) resultContent = `[ERROR] ${resultContent}`;
          mappedMessages.push({ role: 'tool', tool_call_id: tr.tool_use_id || 'unknown', content: resultContent });
        }
        // Push any accompanying text AFTER the tool results, not before
        if (textParts.length) {
          mappedMessages.push({ role: 'user', content: textParts.join('\n') });
        }
        continue;
      }

      // Plain text array content
      mappedMessages.push({ role: msg.role, content: textParts.join('\n') || '' });
      continue;
    }

    // Fallback
    mappedMessages.push({ role: msg.role, content: anthropicContentToText(content) });
  }

  // Safety pass: ensure tool messages always immediately follow the assistant
  // message that contains their matching tool_calls. Some providers (MiniMax,
  // etc.) reject with error 2013 if any non-tool message sits between them.
  const sanitized = [];
  for (let si = 0; si < mappedMessages.length; si++) {
    const m = mappedMessages[si];
    if (m.role === 'tool') {
      // Find the right place: must be after the assistant with matching tool_call
      // If the last message in sanitized is already assistant+tool_calls or another tool, just append
      const last = sanitized.length ? sanitized[sanitized.length - 1] : null;
      if (last && (last.role === 'tool' || (last.role === 'assistant' && last.tool_calls))) {
        sanitized.push(m);
      } else {
        // Search backward for the assistant message with matching tool_calls
        let inserted = false;
        for (let bi = sanitized.length - 1; bi >= 0; bi--) {
          if (sanitized[bi].role === 'assistant' && sanitized[bi].tool_calls) {
            const hasMatch = sanitized[bi].tool_calls.some(tc => tc.id === m.tool_call_id);
            if (hasMatch) {
              // Find the end of the tool block after this assistant message
              let insertIdx = bi + 1;
              while (insertIdx < sanitized.length && sanitized[insertIdx].role === 'tool') insertIdx++;
              sanitized.splice(insertIdx, 0, m);
              inserted = true;
              break;
            }
          }
        }
        if (!inserted) sanitized.push(m); // fallback: append anyway
      }
    } else {
      sanitized.push(m);
    }
  }
  mappedMessages = sanitized;

  const result = {
    model: FORCE_MINIMAX_MODEL ? getActiveModel() : (body.model || getActiveModel()),
    messages: mappedMessages,
    max_tokens: body.max_tokens || 4096,
    temperature: Number.isFinite(body.temperature) ? body.temperature : DEFAULT_TEMPERATURE,
    stream: !!body.stream,
  };

  // Convert Anthropic tools to OpenAI function calling format
  const openAITools = anthropicToolsToOpenAI(body.tools);
  if (openAITools && openAITools.length) {
    result.tools = openAITools;
    // Map tool_choice if provided
    if (body.tool_choice) {
      if (body.tool_choice.type === 'any') result.tool_choice = 'required';
      else if (body.tool_choice.type === 'auto') result.tool_choice = 'auto';
      else if (body.tool_choice.type === 'none') result.tool_choice = 'none';
      else if (body.tool_choice.type === 'tool' && body.tool_choice.name) {
        result.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
      }
    }
  }

  return result;
}

function openAIToAnthropicResponse(openai, reqModel) {
  const choice = (openai && openai.choices && openai.choices[0]) ? openai.choices[0] : {};
  const message = choice.message || {};
  let text = message.content || '';
  let finishReason = choice.finish_reason || 'end_turn';
  const reasoning = message.reasoning_content || message.reasoning || null;
  if (reasoning) {
    text = `<reasoning>\n${reasoning}\n</reasoning>\n\n${text}`;
  }

  // Build content blocks
  const contentBlocks = [];
  if (text) contentBlocks.push({ type: 'text', text: text });

  // Convert OpenAI tool_calls to Anthropic tool_use blocks
  if (message.tool_calls && message.tool_calls.length) {
    for (let i = 0; i < message.tool_calls.length; i++) {
      const tc = message.tool_calls[i];
      const fn = tc.function || {};
      let parsedInput = {};
      try {
        parsedInput = JSON.parse(fn.arguments || '{}');
      } catch (e) {
        parsedInput = { raw: fn.arguments || '' };
      }
      contentBlocks.push({
        type: 'tool_use',
        id: tc.id || ('toolu_' + randomUUID().replace(/-/g, '').slice(0, 24)),
        name: fn.name || 'unknown',
        input: parsedInput,
      });
    }
    // When tools are called, Anthropic stop_reason should be 'tool_use'
    finishReason = 'tool_use';
  }

  // If no content at all, add empty text block
  if (!contentBlocks.length) contentBlocks.push({ type: 'text', text: '' });

  let stopReason = finishReason;
  if (stopReason === 'stop') stopReason = 'end_turn';
  if (stopReason === 'tool_calls') stopReason = 'tool_use';
  if (stopReason === 'function_call') stopReason = 'tool_use';

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: reqModel || getActiveModel(),
    content: contentBlocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: (openai && openai.usage) ? openai.usage.prompt_tokens || 0 : 0,
      output_tokens: (openai && openai.usage) ? openai.usage.completion_tokens || 0 : 0,
    },
  };
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function buildDollarResponse(text, reqModel) {
  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: reqModel || getActiveModel(),
    content: [{ type: 'text', text: text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function buildUpstreamHeaders(apiKey) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || getActiveApiKey()}` };
}

function sendDollarStream(res, text, model) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  sseWrite(res, 'message_start', {
    message: {
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      model: model || getActiveModel(),
      content: [],
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  sseWrite(res, 'content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  sseWrite(res, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: text } });
  sseWrite(res, 'content_block_stop', { index: 0 });
  sseWrite(res, 'message_delta', { stop_reason: 'end_turn', stop_sequence: null, usage: { output_tokens: 0 } });
  sseWrite(res, 'message_stop', {});
  res.end();
}

function parseDollarCommand(messages) {
  if (!messages?.length) return null;
  const lastMsg = messages[messages.length - 1];
  const text = anthropicContentToText(lastMsg?.content).trim();
  const lowerText = text.toLowerCase().replace(/[?!]$/, '');

  if (lowerText === '$$status' || lowerText === '$$info') {
    const summary = tracker.getSummary();
    const activeModel = getActiveModel();
    const activeUrl = getActiveBaseUrl();
    const lines = [
      'ClaudeBridge Status',
      '──────────────────',
      `Model:    ${activeModel}`,
      `Provider: ${runtimeOverride.providerLabel || (activeUrl === ZEN_BASE_URL ? 'ZEN (Default)' : 'Custom')}`,
      `Endpoint: ${activeUrl}${getActiveChatPath()}`,
      '',
      `Session:  ${summary.requests} reqs | ${summary.totalCostFormatted} | ${summary.uptimeFormatted} uptime`,
      `Features: Routing: ${router.enabled ? 'ON' : 'OFF'} | Cache: ${cache.enabled ? 'ON' : 'OFF'} | Fallback: ${fallback.enabled ? 'ON' : 'OFF'}`,
      '',
      `Last Activity: ${new Date().toLocaleTimeString()}`
    ];
    return { handled: true, text: lines.join('\n') };
  }

  if (lowerText === '$$cost' || lowerText === '$$stats' || lowerText === '$$spend') {
    const s = tracker.getSummary();
    const a = tracker.getAllTimeStats();
    const costLines = [
      'Cost & Usage Report',
      '──────────────────',
      'Session:',
      `  Input:    ${formatTokens(s.totalInputTokens)} tokens`,
      `  Output:   ${formatTokens(s.totalOutputTokens)} tokens`,
      `  Cost:     ${s.totalCostFormatted}`,
      '',
      'All-Time:',
      `  Requests: ${a.totalRequests || 0}`,
      `  Tokens:   ${formatTokens(a.totalTokens || 0)}`,
      `  Cost:     ${a.totalCostFormatted}`,
      '',
      `Budget: ${a.totalCostFormatted} / ${BUDGET_LIMIT ? '$' + BUDGET_LIMIT : 'No limit'}`
    ];
    return { handled: true, text: costLines.join('\n') };
  }

  if (lowerText === '$$speed' || lowerText === '$$performance') {
    const summary = tracker.getSummary();
    const speedLines = [
      'Speed & Performance Report',
      '──────────────────',
      `Avg Speed:   ${summary.avgTokensPerSec} tokens/sec`,
      `Avg TTFT:    ${summary.avgTTFTMs}ms (Time to First Token)`,
      `Avg Latency: ${summary.avgLatencyMs}ms (Total response time)`,
      '',
      `Throughput:  ${formatTokens(summary.totalOutputTokens)} tokens generated`,
      `Efficiency:  ${summary.requests} requests | ${summary.errors} errors`,
      '',
      `Status: ${tracker.getStatusLine()}`
    ];
    return { handled: true, text: speedLines.join('\n') };
  }

  if (lowerText === '$$cache' || lowerText === '$$cache status') {
    const cs = cache.getStats();
    return {
      handled: true,
      text: [
        'Response Cache', '──────────────────',
        `Status:   ${cs.enabled ? 'ON' : 'OFF'}`,
        `Entries:  ${cs.entries}/${cs.maxEntries}`,
        `Hit Rate: ${cs.hitRate} (${cs.hits} hits / ${cs.misses} misses)`,
        `Evictions: ${cs.evictions}`,
        `TTL:      ${cs.ttlFormatted}`
      ].join('\n')
    };
  }
  if (lowerText === '$$cache clear' || lowerText === '$$cache flush') {
    return { handled: true, text: `Cache cleared (${cache.clear()} entries removed).` };
  }
  if (lowerText === '$$cache on') { cache.enabled = true; return { handled: true, text: 'Response cache enabled.' }; }
  if (lowerText === '$$cache off') { cache.enabled = false; return { handled: true, text: 'Response cache disabled.' }; }

  if (lowerText === '$$routing' || lowerText === '$$routing status') {
    const rs = router.getStats();
    const table = router.getRoutingTable();
    const rlines = ['Smart Routing', '──────────────────', `Status: ${router.enabled ? 'ON' : 'OFF'}`, `Total routed: ${rs.totalRouted}`, '', 'Routing Table:'];
    table.forEach(row => {
      rlines.push(`  ${row.icon} ${row.label}: ${row.configured.length ? row.configured.join(', ') : (row.active ? 'ACTIVE' : 'no providers configured')}`);
    });
    return { handled: true, text: rlines.join('\n') };
  }
  if (lowerText === '$$routing on') { router.enabled = true; return { handled: true, text: 'Smart routing enabled.' }; }
  if (lowerText === '$$routing off') { router.enabled = false; return { handled: true, text: 'Smart routing disabled.' }; }

  if (lowerText === '$$fallback' || lowerText === '$$fallback status') {
    const fst = fallback.getStatus();
    const flines = [
      'Fallback Chain', '──────────────────',
      `Status:  ${fallback.enabled ? 'ON' : 'OFF'}`,
      `Retries: ${fst.maxRetries} max | ${fst.stats.totalRetries} total`,
      `Fallbacks used: ${fst.stats.totalFallbacks}`
    ];
    if (fst.chain.length) {
      flines.push('', 'Chain:');
      fst.chain.forEach((c, i) => {
        const circuit = c.circuit ? ` [${c.circuit.state}, ${c.circuit.failures} failures]` : '';
        flines.push(`  ${i + 1}. ${c.label}${circuit}`);
      });
    } else {
      flines.push('', 'No fallback chain configured.');
    }
    return { handled: true, text: flines.join('\n') };
  }
  if (lowerText === '$$fallback on') { fallback.enabled = true; return { handled: true, text: 'Fallback chains enabled.' }; }
  if (lowerText === '$$fallback off') { fallback.enabled = false; return { handled: true, text: 'Fallback chains disabled.' }; }

  if (lowerText === '$$models') {
    return {
      handled: true,
      text: [
        'Available Providers', '──────────────────'
      ].concat(
        PROVIDERS.filter(p => !p.requiresEndpointInput).map(p => `$$${p.id} -> ${p.label} (${p.model})`),
        ['', 'Use $$<provider> to switch, or $$model:<id> for a specific model.']
      ).join('\n')
    };
  }

  if (lowerText === '$$reset' || lowerText === '$$default') {
    runtimeOverride = { model: null, baseUrl: null, chatPath: null, apiKey: null, providerLabel: null };
    return { handled: true, text: `Reset to default config.\n\nModel: ${MINIMAX_MODEL}\nProvider: ${ZEN_BASE_URL}` };
  }

  if (lowerText === '$$help' || lowerText === '$$') {
    return {
      handled: true,
      text: [
        'ClaudeBridge $$ Commands', '──────────────────',
        'Switching:',
        '  $$<provider>        Switch to a provider preset',
        '  $$model:<id>        Switch model (keep provider)',
        '  $$reset             Reset to default config',
        '',
        'Status:',
        '  $$status            Full status dashboard',
        '  $$cost              Cost & usage report',
        '  $$speed             Speed & performance report',
        '  $$models            List all providers',
        '',
        'Features:',
        '  $$routing [on/off]  Smart auto-routing',
        '  $$cache [on/off]    Response caching',
        '  $$cache clear       Flush the cache',
        '  $$fallback [on/off] Fallback chains',
        '',
        'Examples:',
        '  $$groq              Switch to Groq',
        '  $$ollama            Switch to local Ollama',
        '  $$model:gpt-4o      Change just the model',
        '  $$groq What is 2+2  One-shot with Groq'
      ].join('\n')
    };
  }

  const modelMatch = text.match(/^\$\$model:(\S+)(?:\s+([\s\S]+))?$/);
  if (modelMatch) {
    runtimeOverride.model = modelMatch[1];
    switchHistory.push({ time: new Date().toLocaleTimeString(), model: modelMatch[1], provider: runtimeOverride.providerLabel || 'current' });
    if (modelMatch[2]) return { handled: false, rewriteContent: modelMatch[2] };
    return { handled: true, text: `Model switched to ${modelMatch[1]}\n\nProvider unchanged. Use $$status to verify.` };
  }

  const providerMatch = text.match(/^\$\$(\S+?)(?:\s+([\s\S]+))?$/);
  if (providerMatch) {
    const provider = getProviderById(providerMatch[1]);
    if (provider && !provider.requiresEndpointInput) {
      runtimeOverride.model = provider.model;
      runtimeOverride.baseUrl = provider.baseUrl;
      runtimeOverride.chatPath = provider.chatPath;
      runtimeOverride.providerLabel = provider.label;
      switchHistory.push({ time: new Date().toLocaleTimeString(), model: provider.model, provider: provider.label });
      if (providerMatch[2]) return { handled: false, rewriteContent: providerMatch[2] };
      return { handled: true, text: `Switched to ${provider.label}\n\nModel: ${provider.model}\nEndpoint: ${provider.baseUrl}${provider.chatPath}\n\nUse $$status to verify, $$reset to go back.` };
    }
  }

  return null;
}

if (!ZEN_BASE_URL) console.warn('[warn] ZEN_BASE_URL is empty. Set it in .env');
if (!ZEN_API_KEY) console.warn('[warn] ZEN_API_KEY is empty. Set it in .env');

app.get('/health', (req, res) => {
  const summary = tracker.getSummary();
  res.json({
    ok: true,
    model: getActiveModel(),
    provider: runtimeOverride.providerLabel || 'default',
    override: !!runtimeOverride.model,
    switchCount: switchHistory.length,
    stats: {
      requests: summary.requests,
      cost: summary.totalCostFormatted,
      tokens: summary.totalInputTokens + summary.totalOutputTokens,
      uptime: summary.uptimeFormatted
    },
    features: {
      routing: router.enabled,
      cache: cache.enabled,
      fallback: fallback.enabled,
      budget: BUDGET_LIMIT
    },
  });
});

app.get('/v1/stats', (req, res) => {
  res.json({ session: tracker.getSummary(), allTime: tracker.getAllTimeStats() });
});
app.post('/v1/stats/reset', (req, res) => {
  tracker.resetSession();
  res.json({ ok: true, message: 'Session stats reset.' });
});

app.get('/v1/cache/stats', (req, res) => {
  res.json(cache.getStats());
});
app.post('/v1/cache/clear', (req, res) => {
  res.json({ ok: true, cleared: cache.clear() });
});
app.post('/v1/cache/toggle', (req, res) => {
  cache.enabled = !cache.enabled;
  res.json({ ok: true, enabled: cache.enabled });
});

app.get('/v1/routing/status', (req, res) => {
  res.json({ enabled: router.enabled, stats: router.getStats(), table: router.getRoutingTable() });
});
app.post('/v1/routing/toggle', (req, res) => {
  router.enabled = !router.enabled;
  res.json({ ok: true, enabled: router.enabled });
});

app.get('/v1/fallback/status', (req, res) => {
  res.json(fallback.getStatus());
});
app.post('/v1/fallback/toggle', (req, res) => {
  fallback.enabled = !fallback.enabled;
  res.json({ ok: true, enabled: fallback.enabled });
});
app.post('/v1/fallback/reset-breakers', (req, res) => {
  fallback.resetBreakers();
  res.json({ ok: true, message: 'Circuit breakers reset.' });
});

app.get('/v1/switch/status', (req, res) => {
  res.json({
    activeModel: getActiveModel(),
    activeProvider: getActiveBaseUrl(),
    activePath: getActiveChatPath(),
    providerLabel: runtimeOverride.providerLabel || 'default',
    isOverridden: !!runtimeOverride.model,
    history: switchHistory.slice(-10)
  });
});

app.post('/v1/switch', (req, res) => {
  const body = req.body || {};
  if (body.provider) {
    const p = getProviderById(body.provider);
    if (!p) return res.status(400).json({ error: `Unknown provider: ${body.provider}` });
    runtimeOverride.model = p.model;
    runtimeOverride.baseUrl = p.baseUrl;
    runtimeOverride.chatPath = p.chatPath;
    runtimeOverride.providerLabel = p.label;
    switchHistory.push({ time: new Date().toLocaleTimeString(), model: p.model, provider: p.label });
    return res.json({ ok: true, model: p.model, provider: p.label });
  }
  if (body.model) {
    runtimeOverride.model = body.model;
    switchHistory.push({ time: new Date().toLocaleTimeString(), model: body.model, provider: runtimeOverride.providerLabel || 'current' });
    return res.json({ ok: true, model: body.model, provider: runtimeOverride.providerLabel || 'current' });
  }
  return res.status(400).json({ error: 'Provide "provider" or "model" in body.' });
});

app.post('/v1/switch/reset', (req, res) => {
  runtimeOverride = { model: null, baseUrl: null, chatPath: null, apiKey: null, providerLabel: null };
  res.json({ ok: true, model: MINIMAX_MODEL, provider: 'default (reset)' });
});

async function makeUpstreamRequest(target, upstreamPayload, isStream) {
  const url = (target.baseUrl || getActiveBaseUrl()) + (target.chatPath || getActiveChatPath());
  const payload = { ...upstreamPayload, model: target.model || upstreamPayload.model };
  if (isStream) payload.stream = true;

  // Claude.ai Web Session (free tier via browser cookie)
  if (target.provider === 'claude-web' || target.id === 'claude-web') {
    const messages = upstreamPayload.messages || [];
    const model = target.model || upstreamPayload.model;
    return claudeWebRequest(messages, model);
  }

  // Inject Copilot Token
  if (target.provider === 'github-copilot' || target.id === 'github-copilot') {
    const oauth = loadToken();
    if (oauth && oauth.access_token) {
      try {
        const chatToken = await getChatToken(oauth.access_token);
        const headers = {
          'Authorization': `Bearer ${chatToken}`,
          'Content-Type': 'application/json',
          'Editor-Version': 'vscode/1.85.0',
          'Editor-Plugin-Version': 'copilot/1.155.0',
          'User-Agent': 'GitHubCopilot/1.155.0',
          'Accept': 'application/json',
        };
        const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!r.ok) {
          const errText = await r.text();
          const err = new Error(errText || 'Copilot request failed');
          err.status = r.status;
          throw err;
        }
        return r;
      } catch (e) {
        throw new Error(`Copilot Token Refresh Failed: ${e.message}`);
      }
    }
  }

  const r = await fetch(url, { method: 'POST', headers: buildUpstreamHeaders(target.apiKey), body: JSON.stringify(payload) });
  if (!r.ok) {
    const errText = await r.text();
    const err = new Error(errText || 'Upstream request failed');
    err.status = r.status;
    throw err;
  }
  return r;
}

app.post('/v1/messages', async (req, res) => {
  let requestStart = Date.now();
  try {
    const body = req.body || {};

    const dollarCmd = parseDollarCommand(body.messages);
    if (dollarCmd) {
      if (dollarCmd.handled) {
        if (body.stream) return sendDollarStream(res, dollarCmd.text, body.model);
        return res.json(buildDollarResponse(dollarCmd.text, body.model));
      }
      if (dollarCmd.rewriteContent && body.messages?.length) {
        body.messages[body.messages.length - 1].content = dollarCmd.rewriteContent;
      }
    }

    let routedProvider = null, routedModel = null, routedBaseUrl = null, routedChatPath = null;
    if (router.enabled) {
      const openAIMessages = (body.messages || []).map(m => ({ role: m.role, content: anthropicContentToText(m.content) }));
      const routing = router.route(openAIMessages, runtimeOverride.providerLabel || 'default', getActiveModel());
      if (routing.routed) {
        routedProvider = routing.provider;
        routedModel = routing.model;
        routedBaseUrl = routing.baseUrl;
        routedChatPath = routing.chatPath;
        if (BRIDGE_LOG_REQUESTS) console.log(`[routing] ${routing.reason}`);
      }
    }

    let activeModel = routedModel || body.model || getActiveModel();
    let activeProviderLabel = routedProvider || runtimeOverride.providerLabel;

    let providerConfig = null;
    if (activeProviderLabel) {
      providerConfig = PROVIDERS.find(p => p.id === activeProviderLabel || p.label === activeProviderLabel);
    }
    if (!providerConfig) {
      const targetUrl = routedBaseUrl || getActiveBaseUrl();
      providerConfig = PROVIDERS.find(p => p.model === activeModel || p.baseUrl === targetUrl);
    }

    const supportsReasoning = providerConfig ? !!providerConfig.supportsReasoning : false;
    const upstreamPayload = anthropicToOpenAI(body, supportsReasoning);
    if (routedModel) upstreamPayload.model = routedModel;

    let activeProvider = routedProvider || runtimeOverride.providerLabel || 'default';
    const url = (routedBaseUrl || getActiveBaseUrl()) + (routedChatPath || getActiveChatPath());
    if (BRIDGE_LOG_REQUESTS) {
      console.log(`/v1/messages model=${activeModel} provider=${activeProvider} stream=${!!upstreamPayload.stream}`);
    }

    if (!upstreamPayload.stream && cache.enabled) {
      const cached = cache.get(activeModel, upstreamPayload.messages, upstreamPayload.temperature);
      if (cached) {
        tracker.record({ model: activeModel, provider: activeProvider, inputTokens: 0, outputTokens: 0, latencyMs: 0, cached: true });
        if (BRIDGE_LOG_REQUESTS) console.log(`[cache] HIT for ${activeModel}`);
        return res.json(cached.value);
      }
    }

    const primary = {
      provider: activeProvider,
      model: activeModel,
      baseUrl: routedBaseUrl || getActiveBaseUrl(),
      chatPath: routedChatPath || getActiveChatPath(),
      apiKey: getActiveApiKey()
    };

    if (!upstreamPayload.stream) {
      let openaiResp;
      if (fallback.enabled && fallback.chain.length > 0) {
        const result = await fallback.execute(target => makeUpstreamRequest(target, upstreamPayload, false).then(r => r.json()), primary);
        openaiResp = result.response;
        activeProvider = result.usedProviderLabel || result.usedProvider;
        activeModel = result.usedModel || activeModel;
      } else {
        const r = await fetch(url, { method: 'POST', headers: buildUpstreamHeaders(), body: JSON.stringify(upstreamPayload) });
        const respText = await r.text();
        if (!r.ok) {
          tracker.record({ model: activeModel, provider: activeProvider, error: true, latencyMs: Date.now() - requestStart });
          return res.status(r.status).json({ type: 'error', error: { type: 'upstream_error', message: respText || 'Upstream request failed' } });
        }
        openaiResp = JSON.parse(respText);
      }
      const anthropicResp = openAIToAnthropicResponse(openaiResp, body.model);
      tracker.record({
        model: activeModel,
        provider: activeProvider,
        inputTokens: openaiResp?.usage?.prompt_tokens || 0,
        outputTokens: openaiResp?.usage?.completion_tokens || 0,
        latencyMs: Date.now() - requestStart
      });
      if (cache.enabled) cache.set(activeModel, upstreamPayload.messages, upstreamPayload.temperature, anthropicResp, { model: activeModel, provider: activeProvider });
      return res.json(anthropicResp);
    }

    let streamTarget;
    if (fallback.enabled && fallback.chain.length > 0) {
      streamTarget = await fallback.execute(target => makeUpstreamRequest(target, upstreamPayload, true), primary);
    } else {
      const streamResp = await fetch(url, {
        method: 'POST',
        headers: buildUpstreamHeaders(),
        body: JSON.stringify({ ...upstreamPayload, stream: true })
      });
      if (!streamResp.ok || !streamResp.body) {
        const txt = await streamResp.text();
        tracker.record({ model: activeModel, provider: activeProvider, error: true, latencyMs: Date.now() - requestStart });
        return res.status(streamResp.status || 502).json({ type: 'error', error: { type: 'upstream_error', message: txt || 'Upstream stream failed' } });
      }
      streamTarget = { response: streamResp, usedProvider: activeProvider, usedModel: activeModel };
    }

    const streamResponse = streamTarget.response;
    if (streamTarget.usedProvider) activeProvider = streamTarget.usedProviderLabel || streamTarget.usedProvider;
    if (streamTarget.usedModel) activeModel = streamTarget.usedModel;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const msgId = `msg_${randomUUID().replace(/-/g, '')}`;
    sseWrite(res, 'message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: body.model || getActiveModel(),
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });

    const decoder = new TextDecoder('utf-8');
    let buffer = '', finalFinishReason = 'end_turn', inputTokens = 0, outputTokens = 0, streamedTokens = 0, ttftMs = 0, firstChunk = true;

    let textBlockStarted = false;
    let reasoningStarted = false;
    let reasoningClosed = false;
    const toolCallAccumulators = {};
    let nextContentIndex = 0;
    const toolCallIndexToContentIndex = {};

    for await (const chunk of streamResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const event of events) {
        const evLines = event.split('\n').map(x => x.trim());
        const dataLines = evLines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
        if (!dataLines.length) continue;
        const payloadText = dataLines.join('');
        if (payloadText === '[DONE]') continue;
        let payload;
        try { payload = JSON.parse(payloadText); } catch (e) { continue; }

        const delta = payload?.choices?.[0]?.delta;
        if (!delta) {
          const fr0 = payload?.choices?.[0]?.finish_reason;
          if (fr0) {
            finalFinishReason = fr0 === 'stop' ? 'end_turn' : (fr0 === 'tool_calls' ? 'tool_use' : fr0);
          }
          if (payload?.usage) {
            inputTokens = payload.usage.prompt_tokens || inputTokens;
            outputTokens = payload.usage.completion_tokens || outputTokens;
          }
          continue;
        }

        const deltaText = delta.content;
        const deltaReasoning = delta.reasoning_content || delta.reasoning;

        if (deltaReasoning) {
          if (!reasoningStarted) {
            sseWrite(res, 'content_block_start', { type: 'content_block_start', index: nextContentIndex, content_block: { type: 'text', text: '' } });
            sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<reasoning>\n' } });
            reasoningStarted = true;
            textBlockStarted = true;
            nextContentIndex++;
          }
          streamedTokens++;
          sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: deltaReasoning } });
        }

        if (deltaText || (delta.tool_calls && reasoningStarted && !reasoningClosed)) {
          if (reasoningStarted && !reasoningClosed) {
            sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n</reasoning>\n\n' } });
            reasoningClosed = true;
          }
        }

        if (deltaText) {
          if (!textBlockStarted) {
            sseWrite(res, 'content_block_start', { type: 'content_block_start', index: nextContentIndex, content_block: { type: 'text', text: '' } });
            textBlockStarted = true;
            nextContentIndex++;
          }
          if (firstChunk) { ttftMs = Date.now() - requestStart; firstChunk = false; }
          streamedTokens++;
          sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: deltaText } });
        }

        if (delta.tool_calls?.length) {
          if (textBlockStarted && !toolCallAccumulators._textClosed) {
            sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
            toolCallAccumulators._textClosed = true;
          }
          if (!textBlockStarted && !toolCallAccumulators._textClosed) {
            toolCallAccumulators._textClosed = true;
          }

          for (const tcDelta of delta.tool_calls) {
            const tcIdx = tcDelta.index !== undefined ? tcDelta.index : 0;
            if (!toolCallAccumulators[tcIdx]) {
              const toolId = tcDelta.id || (`toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`);
              const toolName = tcDelta.function?.name || '';
              const contentIdx = nextContentIndex++;
              toolCallIndexToContentIndex[tcIdx] = contentIdx;
              toolCallAccumulators[tcIdx] = { id: toolId, name: toolName, arguments: '', contentIndex: contentIdx };
              sseWrite(res, 'content_block_start', { type: 'content_block_start', index: contentIdx, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } });
              if (firstChunk) { ttftMs = Date.now() - requestStart; firstChunk = false; }
            }
            if (tcDelta.function?.name && !toolCallAccumulators[tcIdx].name) {
              toolCallAccumulators[tcIdx].name = tcDelta.function.name;
            }
            if (tcDelta.function?.arguments) {
              toolCallAccumulators[tcIdx].arguments += tcDelta.function.arguments;
              streamedTokens++;
              sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: toolCallAccumulators[tcIdx].contentIndex, delta: { type: 'input_json_delta', partial_json: tcDelta.function.arguments } });
            }
          }
        }

        const fr = payload?.choices?.[0]?.finish_reason;
        if (fr) {
          finalFinishReason = fr === 'stop' ? 'end_turn' : ((fr === 'tool_calls' || fr === 'function_call') ? 'tool_use' : fr);
          if (reasoningStarted && !reasoningClosed) {
            sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n</reasoning>\n\n' } });
            reasoningClosed = true;
          }
        }
        if (payload?.usage) {
          inputTokens = payload.usage.prompt_tokens || inputTokens;
          outputTokens = payload.usage.completion_tokens || outputTokens;
        }
      }
    }

    if (textBlockStarted && !toolCallAccumulators._textClosed) {
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    }

    Object.keys(toolCallAccumulators).filter(k => k !== '_textClosed').forEach(k => {
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: toolCallAccumulators[k].contentIndex });
    });

    if (!textBlockStarted && Object.keys(toolCallAccumulators).filter(k => k !== '_textClosed').length === 0) {
      sseWrite(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    }

    sseWrite(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: finalFinishReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
    sseWrite(res, 'message_stop', { type: 'message_stop' });

    tracker.record({
      model: activeModel,
      provider: activeProvider,
      inputTokens,
      outputTokens: outputTokens || streamedTokens,
      latencyMs: Date.now() - requestStart,
      ttftMs,
      streamTokens: streamedTokens,
      streamTimeMs: (Date.now() - requestStart) - ttftMs
    });
    return res.end();
  } catch (err) {
    tracker.record({ model: getActiveModel(), provider: runtimeOverride.providerLabel || 'default', error: true, latencyMs: Date.now() - requestStart });
    return res.status(500).json({ type: 'error', error: { type: 'internal_error', message: err?.message || 'Unknown error' } });
  }
});

app.post('/v1/complete', async (req, res) => {
  const prompt = req.body?.prompt || '';
  req.body = {
    model: req.body?.model || getActiveModel(),
    max_tokens: req.body?.max_tokens_to_sample || 1024,
    messages: [{ role: 'user', content: prompt }],
    stream: !!req.body?.stream
  };
  return app._router.handle(req, res, () => { });
});

app.post('/v1/messages/count_tokens', (req, res) => {
  const body = req.body || {};
  const text = JSON.stringify(body.messages || []) + (body.system || '');
  const estimate = Math.ceil(text.length / 4);
  res.json({ input_tokens: estimate });
});

app.all('/v1/*', (req, res) => {
  if (BRIDGE_LOG_REQUESTS) console.log(`[bridge] unhandled route: ${req.method} ${req.path}`);
  res.json({ ok: true });
});

const shutdown = () => {
  console.log('[claudebridge] Saving session stats...');
  tracker.saveSession();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, () => {
  console.log(`[claudebridge] Anthropic shim listening on http://localhost:${PORT}`);
  console.log('[claudebridge] $$ model switching enabled');
  const features = [];
  if (router.enabled) features.push('routing');
  if (cache.enabled) features.push('cache');
  if (fallback.enabled) features.push('fallback');
  if (BUDGET_LIMIT) features.push('budget:$' + BUDGET_LIMIT.toFixed(2));
  if (features.length) console.log(`[claudebridge] Features: ${features.join(', ')}`);
});
