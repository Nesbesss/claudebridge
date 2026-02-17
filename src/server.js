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

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = Number(process.env.PORT || 8787);
const ZEN_API_KEY = (process.env.ZEN_API_KEY || '').replace(/^Bearer\s+/i, '');
const ZEN_BASE_URL = (process.env.ZEN_BASE_URL || '').replace(/\/$/, '');
var _rawChatPath = (process.env.ZEN_CHAT_COMPLETIONS_PATH || '/v1/chat/completions').replace(/\/$/, '');
if (_rawChatPath && !_rawChatPath.includes('/chat/completions')) _rawChatPath = _rawChatPath + '/chat/completions';
const ZEN_CHAT_COMPLETIONS_PATH = _rawChatPath;
const MINIMAX_MODEL = process.env.MINIMAX_MODEL || 'minimax/minimax-2.5-chat';
const DEFAULT_TEMPERATURE = Number(process.env.DEFAULT_TEMPERATURE || 0.2);
const FORCE_MINIMAX_MODEL = String(process.env.FORCE_MINIMAX_MODEL || 'true').toLowerCase() !== 'false';
const BRIDGE_LOG_REQUESTS = String(process.env.BRIDGE_LOG_REQUESTS || 'false').toLowerCase() === 'true';

const ROUTING_ENABLED = String(process.env.CLAUDEBRIDGE_ROUTING || 'false').toLowerCase() === 'true';
const CACHE_ENABLED = String(process.env.CLAUDEBRIDGE_CACHE || 'true').toLowerCase() !== 'false';
const FALLBACK_ENABLED = String(process.env.CLAUDEBRIDGE_FALLBACK || 'false').toLowerCase() === 'true';
const BUDGET_LIMIT = process.env.CLAUDEBRIDGE_BUDGET ? parseFloat(process.env.CLAUDEBRIDGE_BUDGET) : null;
const FALLBACK_CHAIN_IDS = process.env.CLAUDEBRIDGE_FALLBACK_CHAIN ? process.env.CLAUDEBRIDGE_FALLBACK_CHAIN.split(',').map(function (s) { return s.trim(); }) : [];

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
  return content.map(function (block) {
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
  return tools.map(function (t) {
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    };
  });
}

function anthropicToOpenAI(body, supportsReasoning) {
  var systemText = anthropicContentToText(body.system);
  var mappedMessages = [];
  if (systemText) mappedMessages.push({ role: 'system', content: systemText });

  for (var i = 0; i < (body.messages || []).length; i++) {
    var msg = body.messages[i];
    var content = msg.content;

    // String content — simple text message
    if (typeof content === 'string') {
      if (supportsReasoning && msg.role === 'assistant') {
        var extracted = extractReasoning(content);
        var newMsg = { role: msg.role, content: extracted.content };
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
      var textParts = [];
      var toolUseParts = [];
      var toolResultParts = [];

      for (var j = 0; j < content.length; j++) {
        var block = content[j];
        if (!block) continue;
        if (block.type === 'tool_use') {
          toolUseParts.push(block);
        } else if (block.type === 'tool_result') {
          toolResultParts.push(block);
        } else {
          // text, input_text, or other text-like blocks
          var t = block.text || (typeof block === 'string' ? block : '');
          if (t) textParts.push(t);
        }
      }

      // Assistant message with tool_use blocks → OpenAI assistant with tool_calls
      if (msg.role === 'assistant' && toolUseParts.length) {
        var assistantMsg = { role: 'assistant', content: textParts.join('\n') || null };
        if (supportsReasoning) {
          var combinedText = textParts.join('\n');
          var extracted = extractReasoning(combinedText);
          assistantMsg.content = extracted.content || null;
          if (extracted.reasoning) assistantMsg.reasoning_content = extracted.reasoning;
        }
        assistantMsg.tool_calls = toolUseParts.map(function (tu) {
          var inputStr;
          try { inputStr = typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {}); } catch (e) { inputStr = '{}'; }
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
        for (var k = 0; k < toolResultParts.length; k++) {
          var tr = toolResultParts[k];
          var resultContent = '';
          if (typeof tr.content === 'string') {
            resultContent = tr.content;
          } else if (Array.isArray(tr.content)) {
            resultContent = tr.content.map(function (rc) {
              if (typeof rc === 'string') return rc;
              if (rc && rc.type === 'text') return rc.text || '';
              if (rc && rc.type === 'image') return '[image]';
              return JSON.stringify(rc);
            }).join('\n');
          }
          if (tr.is_error) resultContent = '[ERROR] ' + resultContent;
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
  var sanitized = [];
  for (var si = 0; si < mappedMessages.length; si++) {
    var m = mappedMessages[si];
    if (m.role === 'tool') {
      // Find the right place: must be after the assistant with matching tool_call
      // If the last message in sanitized is already assistant+tool_calls or another tool, just append
      var last = sanitized.length ? sanitized[sanitized.length - 1] : null;
      if (last && (last.role === 'tool' || (last.role === 'assistant' && last.tool_calls))) {
        sanitized.push(m);
      } else {
        // Search backward for the assistant message with matching tool_calls
        var inserted = false;
        for (var bi = sanitized.length - 1; bi >= 0; bi--) {
          if (sanitized[bi].role === 'assistant' && sanitized[bi].tool_calls) {
            var hasMatch = sanitized[bi].tool_calls.some(function (tc) { return tc.id === m.tool_call_id; });
            if (hasMatch) {
              // Find the end of the tool block after this assistant message
              var insertIdx = bi + 1;
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

  var result = {
    model: FORCE_MINIMAX_MODEL ? getActiveModel() : (body.model || getActiveModel()),
    messages: mappedMessages,
    max_tokens: body.max_tokens || 4096,
    temperature: Number.isFinite(body.temperature) ? body.temperature : DEFAULT_TEMPERATURE,
    stream: !!body.stream,
  };

  // Convert Anthropic tools to OpenAI function calling format
  var openAITools = anthropicToolsToOpenAI(body.tools);
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
  var choice = (openai && openai.choices && openai.choices[0]) ? openai.choices[0] : {};
  var message = choice.message || {};
  var text = message.content || '';
  var finishReason = choice.finish_reason || 'end_turn';
  var reasoning = message.reasoning_content || message.reasoning || null;
  if (reasoning) {
    text = '<reasoning>\n' + reasoning + '\n</reasoning>\n\n' + text;
  }

  // Build content blocks
  var contentBlocks = [];
  if (text) contentBlocks.push({ type: 'text', text: text });

  // Convert OpenAI tool_calls to Anthropic tool_use blocks
  if (message.tool_calls && message.tool_calls.length) {
    for (var i = 0; i < message.tool_calls.length; i++) {
      var tc = message.tool_calls[i];
      var fn = tc.function || {};
      var parsedInput = {};
      try { parsedInput = JSON.parse(fn.arguments || '{}'); } catch (e) { parsedInput = { raw: fn.arguments || '' }; }
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

  var stopReason = finishReason;
  if (stopReason === 'stop') stopReason = 'end_turn';
  if (stopReason === 'tool_calls') stopReason = 'tool_use';
  if (stopReason === 'function_call') stopReason = 'tool_use';

  return {
    id: 'msg_' + randomUUID().replace(/-/g, ''),
    type: 'message', role: 'assistant',
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
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function buildDollarResponse(text, reqModel) {
  return {
    id: 'msg_' + randomUUID().replace(/-/g, ''),
    type: 'message', role: 'assistant',
    model: reqModel || getActiveModel(),
    content: [{ type: 'text', text: text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function buildUpstreamHeaders(apiKey) {
  return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (apiKey || getActiveApiKey()) };
}

function sendDollarStream(res, text, model) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  var resp = buildDollarResponse(text, model);
  sseWrite(res, 'message_start', { type: 'message_start', message: Object.assign({}, resp, { content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } }) });
  sseWrite(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text } });
  sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sseWrite(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
  sseWrite(res, 'message_stop', { type: 'message_stop' });
  return res.end();
}

function parseDollarCommand(messages) {
  if (!messages || !messages.length) return null;
  var lastMsg = messages[messages.length - 1];
  var text = anthropicContentToText(lastMsg ? lastMsg.content : '').trim();

  if (text === '$$status' || text === '$$info') {
    var lines = ['ClaudeBridge Status', '', 'Active Model: ' + getActiveModel(), 'Provider: ' + getActiveBaseUrl(), 'Path: ' + getActiveChatPath(), 'API Key: ' + getActiveApiKey().slice(0, 4) + '****' + getActiveApiKey().slice(-4), '', 'Session Stats: ' + tracker.getStatusLine()];
    if (router.enabled) lines.push('Routing: ON (' + Object.keys(router.stats.byTaskType).length + ' task types seen)');
    if (fallback.enabled) lines.push('Fallback: ON (' + fallback.chain.length + ' providers in chain)');
    lines.push('Cache: ' + (cache.enabled ? cache.getStatusLine() : 'OFF'));
    if (switchHistory.length) { lines.push('', 'Recent switches:'); switchHistory.slice(-5).forEach(function (h) { lines.push('  ' + h.time + ' -> ' + h.model); }); }
    return { handled: true, text: lines.join('\n') };
  }

  if (text === '$$cost' || text === '$$stats' || text === '$$spend') {
    var summary = tracker.getSummary();
    var costLines = ['Cost & Usage Report', '', 'Session: ' + summary.uptimeFormatted + ' | ' + summary.requests + ' requests | ' + summary.errors + ' errors', 'Tokens: ' + formatTokens(summary.totalInputTokens) + ' in / ' + formatTokens(summary.totalOutputTokens) + ' out', 'Cost: ' + summary.totalCostFormatted, 'Speed: ' + summary.avgLatencyMs + 'ms avg | ' + summary.avgTTFTMs + 'ms TTFT | ' + summary.avgTokensPerSec + ' tok/s'];
    if (summary.budget.status !== 'no-limit') { costLines.push('Budget: ' + summary.totalCostFormatted + ' / $' + (BUDGET_LIMIT || 0).toFixed(2) + ' (' + Math.round((summary.budget.pct || 0) * 100) + '%)'); }
    if (Object.keys(summary.byModel).length) { costLines.push('', 'By Model:'); Object.entries(summary.byModel).forEach(function (p) { costLines.push('  ' + p[0] + ': ' + p[1].requests + ' reqs, ' + formatCost(p[1].cost)); }); }
    return { handled: true, text: costLines.join('\n') };
  }

  if (text === '$$cache' || text === '$$cache status') {
    var cs = cache.getStats();
    return { handled: true, text: ['Response Cache', '', 'Status: ' + (cs.enabled ? 'ON' : 'OFF'), 'Entries: ' + cs.entries + '/' + cs.maxEntries, 'Hit Rate: ' + cs.hitRate + ' (' + cs.hits + ' hits / ' + cs.misses + ' misses)', 'Evictions: ' + cs.evictions, 'TTL: ' + cs.ttlFormatted].join('\n') };
  }
  if (text === '$$cache clear' || text === '$$cache flush') { return { handled: true, text: 'Cache cleared (' + cache.clear() + ' entries removed).' }; }
  if (text === '$$cache on') { cache.enabled = true; return { handled: true, text: 'Response cache enabled.' }; }
  if (text === '$$cache off') { cache.enabled = false; return { handled: true, text: 'Response cache disabled.' }; }

  if (text === '$$routing' || text === '$$routing status') {
    var rs = router.getStats(); var table = router.getRoutingTable();
    var rlines = ['Smart Routing', '', 'Status: ' + (router.enabled ? 'ON' : 'OFF'), 'Total routed: ' + rs.totalRouted, '', 'Routing Table:'];
    table.forEach(function (row) { rlines.push('  ' + row.icon + ' ' + row.label + ': ' + (row.configured.length ? row.configured.join(', ') : (row.active ? 'ACTIVE' : 'no providers configured'))); });
    return { handled: true, text: rlines.join('\n') };
  }
  if (text === '$$routing on') { router.enabled = true; return { handled: true, text: 'Smart routing enabled.' }; }
  if (text === '$$routing off') { router.enabled = false; return { handled: true, text: 'Smart routing disabled.' }; }

  if (text === '$$fallback' || text === '$$fallback status') {
    var fst = fallback.getStatus();
    var flines = ['Fallback Chain', '', 'Status: ' + (fallback.enabled ? 'ON' : 'OFF'), 'Retries: ' + fst.maxRetries + ' max | ' + fst.stats.totalRetries + ' total', 'Fallbacks used: ' + fst.stats.totalFallbacks];
    if (fst.chain.length) { flines.push('', 'Chain:'); fst.chain.forEach(function (c, i) { var circuit = c.circuit ? ' [' + c.circuit.state + ', ' + c.circuit.failures + ' failures]' : ''; flines.push('  ' + (i + 1) + '. ' + c.label + circuit); }); }
    else { flines.push('', 'No fallback chain configured.'); }
    return { handled: true, text: flines.join('\n') };
  }
  if (text === '$$fallback on') { fallback.enabled = true; return { handled: true, text: 'Fallback chains enabled.' }; }
  if (text === '$$fallback off') { fallback.enabled = false; return { handled: true, text: 'Fallback chains disabled.' }; }

  if (text === '$$models') {
    return { handled: true, text: ['Available Providers', ''].concat(PROVIDERS.filter(function (p) { return !p.requiresEndpointInput; }).map(function (p) { return '$$' + p.id + ' -> ' + p.label + ' (' + p.model + ')'; }), ['', 'Use $$<provider> to switch, or $$model:<id> for a specific model.']).join('\n') };
  }

  if (text === '$$reset' || text === '$$default') {
    runtimeOverride = { model: null, baseUrl: null, chatPath: null, apiKey: null, providerLabel: null };
    return { handled: true, text: 'Reset to default config.\n\nModel: ' + MINIMAX_MODEL + '\nProvider: ' + ZEN_BASE_URL };
  }

  if (text === '$$help' || text === '$$') {
    return { handled: true, text: ['ClaudeBridge $$ Commands', '', 'Switching:', '  $$<provider>        Switch to a provider preset', '  $$model:<id>        Switch model (keep provider)', '  $$reset             Reset to default config', '', 'Status:', '  $$status            Full status dashboard', '  $$cost              Cost & usage report', '  $$models            List all providers', '', 'Features:', '  $$routing [on/off]  Smart auto-routing', '  $$cache [on/off]    Response caching', '  $$cache clear       Flush the cache', '  $$fallback [on/off] Fallback chains', '', 'Examples:', '  $$groq              Switch to Groq', '  $$ollama            Switch to local Ollama', '  $$model:gpt-4o      Change just the model', '  $$groq What is 2+2  One-shot with Groq'].join('\n') };
  }

  var modelMatch = text.match(/^\$\$model:(\S+)(?:\s+([\s\S]+))?$/);
  if (modelMatch) {
    runtimeOverride.model = modelMatch[1];
    switchHistory.push({ time: new Date().toLocaleTimeString(), model: modelMatch[1], provider: runtimeOverride.providerLabel || 'current' });
    if (modelMatch[2]) return { handled: false, rewriteContent: modelMatch[2] };
    return { handled: true, text: 'Model switched to ' + modelMatch[1] + '\n\nProvider unchanged. Use $$status to verify.' };
  }

  var providerMatch = text.match(/^\$\$(\S+?)(?:\s+([\s\S]+))?$/);
  if (providerMatch) {
    var provider = getProviderById(providerMatch[1]);
    if (provider && !provider.requiresEndpointInput) {
      runtimeOverride.model = provider.model;
      runtimeOverride.baseUrl = provider.baseUrl;
      runtimeOverride.chatPath = provider.chatPath;
      runtimeOverride.providerLabel = provider.label;
      switchHistory.push({ time: new Date().toLocaleTimeString(), model: provider.model, provider: provider.label });
      if (providerMatch[2]) return { handled: false, rewriteContent: providerMatch[2] };
      return { handled: true, text: 'Switched to ' + provider.label + '\n\nModel: ' + provider.model + '\nEndpoint: ' + provider.baseUrl + provider.chatPath + '\n\nUse $$status to verify, $$reset to go back.' };
    }
  }

  return null;
}

if (!ZEN_BASE_URL) console.warn('[warn] ZEN_BASE_URL is empty. Set it in .env');
if (!ZEN_API_KEY) console.warn('[warn] ZEN_API_KEY is empty. Set it in .env');

app.get('/health', function (req, res) {
  var summary = tracker.getSummary();
  res.json({
    ok: true, model: getActiveModel(), provider: runtimeOverride.providerLabel || 'default',
    override: !!runtimeOverride.model, switchCount: switchHistory.length,
    stats: { requests: summary.requests, cost: summary.totalCostFormatted, tokens: summary.totalInputTokens + summary.totalOutputTokens, uptime: summary.uptimeFormatted },
    features: { routing: router.enabled, cache: cache.enabled, fallback: fallback.enabled, budget: BUDGET_LIMIT },
  });
});

app.get('/v1/stats', function (req, res) { res.json({ session: tracker.getSummary(), allTime: tracker.getAllTimeStats() }); });
app.post('/v1/stats/reset', function (req, res) { tracker.resetSession(); res.json({ ok: true, message: 'Session stats reset.' }); });

app.get('/v1/cache/stats', function (req, res) { res.json(cache.getStats()); });
app.post('/v1/cache/clear', function (req, res) { res.json({ ok: true, cleared: cache.clear() }); });
app.post('/v1/cache/toggle', function (req, res) { cache.enabled = !cache.enabled; res.json({ ok: true, enabled: cache.enabled }); });

app.get('/v1/routing/status', function (req, res) { res.json({ enabled: router.enabled, stats: router.getStats(), table: router.getRoutingTable() }); });
app.post('/v1/routing/toggle', function (req, res) { router.enabled = !router.enabled; res.json({ ok: true, enabled: router.enabled }); });

app.get('/v1/fallback/status', function (req, res) { res.json(fallback.getStatus()); });
app.post('/v1/fallback/toggle', function (req, res) { fallback.enabled = !fallback.enabled; res.json({ ok: true, enabled: fallback.enabled }); });
app.post('/v1/fallback/reset-breakers', function (req, res) { fallback.resetBreakers(); res.json({ ok: true, message: 'Circuit breakers reset.' }); });

app.get('/v1/switch/status', function (req, res) {
  res.json({ activeModel: getActiveModel(), activeProvider: getActiveBaseUrl(), activePath: getActiveChatPath(), providerLabel: runtimeOverride.providerLabel || 'default', isOverridden: !!runtimeOverride.model, history: switchHistory.slice(-10) });
});
app.post('/v1/switch', function (req, res) {
  var body = req.body || {};
  if (body.provider) {
    var p = getProviderById(body.provider);
    if (!p) return res.status(400).json({ error: 'Unknown provider: ' + body.provider });
    runtimeOverride.model = p.model; runtimeOverride.baseUrl = p.baseUrl; runtimeOverride.chatPath = p.chatPath; runtimeOverride.providerLabel = p.label;
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
app.post('/v1/switch/reset', function (req, res) { runtimeOverride = { model: null, baseUrl: null, chatPath: null, apiKey: null, providerLabel: null }; res.json({ ok: true, model: MINIMAX_MODEL, provider: 'default (reset)' }); });

async function makeUpstreamRequest(target, upstreamPayload, isStream) {
  var url = (target.baseUrl || getActiveBaseUrl()) + (target.chatPath || getActiveChatPath());
  var payload = Object.assign({}, upstreamPayload, { model: target.model || upstreamPayload.model });
  if (isStream) payload.stream = true;
  // Inject Copilot Token
  if (target.provider === 'github-copilot' || target.id === 'github-copilot') {
    const oauth = loadToken();
    if (oauth && oauth.access_token) {
      try {
        const chatToken = await getChatToken(oauth.access_token);
        // Copilot headers are special
        const headers = {
          'Authorization': `Bearer ${chatToken}`, // Using the tid= token
          'Content-Type': 'application/json',
          'Editor-Version': 'vscode/1.85.0',
          'Editor-Plugin-Version': 'copilot/1.155.0',
          'User-Agent': 'GitHubCopilot/1.155.0',
          'Accept': 'application/json',
        };
        // Override standard buildUpstreamHeaders
        var r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!r.ok) { var errText = await r.text(); var err = new Error(errText || 'Copilot request failed'); err.status = r.status; throw err; }
        return r;
      } catch (e) {
        throw new Error('Copilot Token Refresh Failed: ' + e.message);
      }
    }
  }

  var r = await fetch(url, { method: 'POST', headers: buildUpstreamHeaders(target.apiKey), body: JSON.stringify(payload) });
  if (!r.ok) { var errText = await r.text(); var err = new Error(errText || 'Upstream request failed'); err.status = r.status; throw err; }
  return r;
}

app.post('/v1/messages', async function (req, res) {
  try {
    var body = req.body || {};
    var requestStart = Date.now();

    var dollarCmd = parseDollarCommand(body.messages);
    if (dollarCmd) {
      if (dollarCmd.handled) {
        if (body.stream) return sendDollarStream(res, dollarCmd.text, body.model);
        return res.json(buildDollarResponse(dollarCmd.text, body.model));
      }
      if (dollarCmd.rewriteContent && body.messages && body.messages.length) {
        body.messages[body.messages.length - 1].content = dollarCmd.rewriteContent;
      }
    }

    var routedProvider = null, routedModel = null, routedBaseUrl = null, routedChatPath = null;
    if (router.enabled) {
      var openAIMessages = (body.messages || []).map(function (m) { return { role: m.role, content: anthropicContentToText(m.content) }; });
      var routing = router.route(openAIMessages, runtimeOverride.providerLabel || 'default', getActiveModel());
      if (routing.routed) { routedProvider = routing.provider; routedModel = routing.model; routedBaseUrl = routing.baseUrl; routedChatPath = routing.chatPath; if (BRIDGE_LOG_REQUESTS) console.log('[routing] ' + routing.reason); }
    }

    // Resolve active provider to check capabilities
    var activeModel = routedModel || body.model || getActiveModel();
    var activeProviderLabel = routedProvider || runtimeOverride.providerLabel; // can be null if default

    // Find provider config
    var providerConfig = null;
    if (activeProviderLabel) {
      providerConfig = PROVIDERS.find(function (p) { return p.id === activeProviderLabel || p.label === activeProviderLabel; });
    }
    // Fallback: search by model or base URL if not found by label
    if (!providerConfig) {
      var targetUrl = routedBaseUrl || getActiveBaseUrl();
      providerConfig = PROVIDERS.find(function (p) { return p.model === activeModel || p.baseUrl === targetUrl; });
    }

    var supportsReasoning = providerConfig ? !!providerConfig.supportsReasoning : false;

    var upstreamPayload = anthropicToOpenAI(body, supportsReasoning);
    if (routedModel) upstreamPayload.model = routedModel;
    // activeModel and activeProvider already defined above
    var activeProvider = routedProvider || runtimeOverride.providerLabel || 'default';
    var url = (routedBaseUrl || getActiveBaseUrl()) + (routedChatPath || getActiveChatPath());
    if (BRIDGE_LOG_REQUESTS) console.log('/v1/messages model=' + activeModel + ' provider=' + activeProvider + ' stream=' + !!upstreamPayload.stream);

    if (!upstreamPayload.stream && cache.enabled) {
      var cached = cache.get(activeModel, upstreamPayload.messages, upstreamPayload.temperature);
      if (cached) {
        tracker.record({ model: activeModel, provider: activeProvider, inputTokens: 0, outputTokens: 0, latencyMs: 0, cached: true });
        if (BRIDGE_LOG_REQUESTS) console.log('[cache] HIT for ' + activeModel);
        return res.json(cached.value);
      }
    }

    var primary = { provider: activeProvider, model: activeModel, baseUrl: routedBaseUrl || getActiveBaseUrl(), chatPath: routedChatPath || getActiveChatPath(), apiKey: getActiveApiKey() };

    if (!upstreamPayload.stream) {
      var openaiResp;
      if (fallback.enabled && fallback.chain.length > 0) {
        var result = await fallback.execute(function (target) { return makeUpstreamRequest(target, upstreamPayload, false).then(function (r) { return r.json(); }); }, primary);
        openaiResp = result.response;
        activeProvider = result.usedProviderLabel || result.usedProvider;
        activeModel = result.usedModel || activeModel;
      } else {
        var r = await fetch(url, { method: 'POST', headers: buildUpstreamHeaders(), body: JSON.stringify(upstreamPayload) });
        var respText = await r.text();
        if (!r.ok) { tracker.record({ model: activeModel, provider: activeProvider, error: true, latencyMs: Date.now() - requestStart }); return res.status(r.status).json({ type: 'error', error: { type: 'upstream_error', message: respText || 'Upstream request failed' } }); }
        openaiResp = JSON.parse(respText);
      }
      var anthropicResp = openAIToAnthropicResponse(openaiResp, body.model);
      tracker.record({ model: activeModel, provider: activeProvider, inputTokens: (openaiResp && openaiResp.usage) ? openaiResp.usage.prompt_tokens || 0 : 0, outputTokens: (openaiResp && openaiResp.usage) ? openaiResp.usage.completion_tokens || 0 : 0, latencyMs: Date.now() - requestStart });
      if (cache.enabled) cache.set(activeModel, upstreamPayload.messages, upstreamPayload.temperature, anthropicResp, { model: activeModel, provider: activeProvider });
      return res.json(anthropicResp);
    }

    var streamTarget;
    if (fallback.enabled && fallback.chain.length > 0) {
      streamTarget = await fallback.execute(function (target) { return makeUpstreamRequest(target, upstreamPayload, true); }, primary);
    } else {
      var streamResp = await fetch(url, { method: 'POST', headers: buildUpstreamHeaders(), body: JSON.stringify(Object.assign({}, upstreamPayload, { stream: true })) });
      if (!streamResp.ok || !streamResp.body) { var txt = await streamResp.text(); tracker.record({ model: activeModel, provider: activeProvider, error: true, latencyMs: Date.now() - requestStart }); return res.status(streamResp.status || 502).json({ type: 'error', error: { type: 'upstream_error', message: txt || 'Upstream stream failed' } }); }
      streamTarget = { response: streamResp, usedProvider: activeProvider, usedModel: activeModel };
    }

    var streamResponse = streamTarget.response;
    if (streamTarget.usedProvider) activeProvider = streamTarget.usedProviderLabel || streamTarget.usedProvider;
    if (streamTarget.usedModel) activeModel = streamTarget.usedModel;

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    var msgId = 'msg_' + randomUUID().replace(/-/g, '');
    sseWrite(res, 'message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: body.model || getActiveModel(), content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });

    var decoder = new TextDecoder('utf-8');
    var buffer = '', finalFinishReason = 'end_turn', inputTokens = 0, outputTokens = 0, streamedTokens = 0, ttftMs = 0, firstChunk = true;

    // Track content blocks: text (index 0) and tool_calls (index 1+)
    var textBlockStarted = false;
    var reasoningStarted = false;
    var reasoningClosed = false;
    var toolCallAccumulators = {};  // keyed by tool_call index
    var nextContentIndex = 0;
    var toolCallIndexToContentIndex = {}; // maps OpenAI tool_call index to Anthropic content block index

    for await (var chunk of streamResponse.body) {
      buffer += decoder.decode(chunk, { stream: true });
      var events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (var ei = 0; ei < events.length; ei++) {
        var evLines = events[ei].split('\n').map(function (x) { return x.trim(); });
        var dataLines = evLines.filter(function (l) { return l.startsWith('data:'); }).map(function (l) { return l.slice(5).trim(); });
        if (!dataLines.length) continue;
        var payloadText = dataLines.join('');
        if (payloadText === '[DONE]') continue;
        var payload;
        try { payload = JSON.parse(payloadText); } catch (e) { continue; }

        var delta = payload && payload.choices && payload.choices[0] ? payload.choices[0].delta : undefined;
        if (!delta) {
          // Still check for usage and finish_reason even without delta
          var fr0 = payload && payload.choices && payload.choices[0] ? payload.choices[0].finish_reason : undefined;
          if (fr0) {
            if (fr0 === 'stop') finalFinishReason = 'end_turn';
            else if (fr0 === 'tool_calls') finalFinishReason = 'tool_use';
            else finalFinishReason = fr0;
          }
          if (payload && payload.usage) { inputTokens = payload.usage.prompt_tokens || inputTokens; outputTokens = payload.usage.completion_tokens || outputTokens; }
          continue;
        }

        // Handle text content
        var deltaText = delta.content;
        var deltaReasoning = delta.reasoning_content || delta.reasoning;

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
          // If we were reasoning and now switched to text or tools, close reasoning tag
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

        // Handle tool call deltas
        if (delta.tool_calls && delta.tool_calls.length) {
          // Close text block before starting tool blocks (if text was open)
          if (textBlockStarted && !toolCallAccumulators._textClosed) {
            sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
            toolCallAccumulators._textClosed = true;
          }
          if (!textBlockStarted && !toolCallAccumulators._textClosed) {
            // No text block was started — still need to set nextContentIndex right
            toolCallAccumulators._textClosed = true;
          }

          for (var tci = 0; tci < delta.tool_calls.length; tci++) {
            var tcDelta = delta.tool_calls[tci];
            var tcIdx = tcDelta.index !== undefined ? tcDelta.index : tci;

            if (!toolCallAccumulators[tcIdx]) {
              // New tool call starting
              var toolId = tcDelta.id || ('toolu_' + randomUUID().replace(/-/g, '').slice(0, 24));
              var toolName = (tcDelta.function && tcDelta.function.name) ? tcDelta.function.name : '';
              var contentIdx = nextContentIndex;
              nextContentIndex++;
              toolCallIndexToContentIndex[tcIdx] = contentIdx;
              toolCallAccumulators[tcIdx] = { id: toolId, name: toolName, arguments: '', contentIndex: contentIdx };

              sseWrite(res, 'content_block_start', { type: 'content_block_start', index: contentIdx, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } });
              if (firstChunk) { ttftMs = Date.now() - requestStart; firstChunk = false; }
            }

            // Accumulate function name (some providers stream the name)
            if (tcDelta.function && tcDelta.function.name && !toolCallAccumulators[tcIdx].name) {
              toolCallAccumulators[tcIdx].name = tcDelta.function.name;
            }

            // Accumulate arguments
            if (tcDelta.function && tcDelta.function.arguments) {
              toolCallAccumulators[tcIdx].arguments += tcDelta.function.arguments;
              streamedTokens++;
              sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: toolCallAccumulators[tcIdx].contentIndex, delta: { type: 'input_json_delta', partial_json: tcDelta.function.arguments } });
            }
          }
        }

        var fr = payload && payload.choices && payload.choices[0] ? payload.choices[0].finish_reason : undefined;
        if (fr) {
          if (fr === 'stop') finalFinishReason = 'end_turn';
          else if (fr === 'tool_calls') finalFinishReason = 'tool_use';
          else if (fr === 'function_call') finalFinishReason = 'tool_use';
          else finalFinishReason = fr;

          if (reasoningStarted && !reasoningClosed) {
            sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n</reasoning>\n\n' } });
            reasoningClosed = true;
          }
        }
        if (payload && payload.usage) { inputTokens = payload.usage.prompt_tokens || inputTokens; outputTokens = payload.usage.completion_tokens || outputTokens; }
      }
    }

    // Close any open text block that wasn't closed yet
    if (textBlockStarted && !toolCallAccumulators._textClosed) {
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    }

    // Close all tool call blocks
    var tcKeys = Object.keys(toolCallAccumulators).filter(function (k) { return k !== '_textClosed'; });
    for (var tck = 0; tck < tcKeys.length; tck++) {
      var acc = toolCallAccumulators[tcKeys[tck]];
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: acc.contentIndex });
    }

    // If nothing was started at all, send an empty text block
    if (!textBlockStarted && tcKeys.length === 0) {
      sseWrite(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    }

    sseWrite(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: finalFinishReason, stop_sequence: null }, usage: { output_tokens: outputTokens } });
    sseWrite(res, 'message_stop', { type: 'message_stop' });

    tracker.record({ model: activeModel, provider: activeProvider, inputTokens: inputTokens, outputTokens: outputTokens || streamedTokens, latencyMs: Date.now() - requestStart, ttftMs: ttftMs, streamTokens: streamedTokens, streamTimeMs: (Date.now() - requestStart) - ttftMs });
    return res.end();
  } catch (err) {
    tracker.record({ model: getActiveModel(), provider: runtimeOverride.providerLabel || 'default', error: true, latencyMs: Date.now() - (req._startTime || Date.now()) });
    return res.status(500).json({ type: 'error', error: { type: 'internal_error', message: err && err.message ? err.message : 'Unknown error' } });
  }
});

app.post('/v1/complete', async function (req, res) {
  var prompt = (req.body && req.body.prompt) ? req.body.prompt : '';
  req.body = { model: (req.body && req.body.model) ? req.body.model : getActiveModel(), max_tokens: (req.body && req.body.max_tokens_to_sample) ? req.body.max_tokens_to_sample : 1024, messages: [{ role: 'user', content: prompt }], stream: !!(req.body && req.body.stream) };
  return app._router.handle(req, res, function () { });
});

// Token counting endpoint — Claude Code calls this, return a fake count so it doesn't error
app.post('/v1/messages/count_tokens', function (req, res) {
  var body = req.body || {};
  // Rough estimate: 4 chars per token
  var text = JSON.stringify(body.messages || []) + (body.system || '');
  var estimate = Math.ceil(text.length / 4);
  res.json({ input_tokens: estimate });
});

// Catch-all for any other Anthropic API routes Claude might call
app.all('/v1/*', function (req, res) {
  if (BRIDGE_LOG_REQUESTS) console.log('[bridge] unhandled route: ' + req.method + ' ' + req.path);
  // Return a valid-looking empty response instead of 404
  res.json({ ok: true });
});

function shutdown() { console.log('[claudebridge] Saving session stats...'); tracker.saveSession(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, function () {
  console.log('[claudebridge] Anthropic shim listening on http://localhost:' + PORT);
  console.log('[claudebridge] $$ model switching enabled');
  var features = [];
  if (router.enabled) features.push('routing');
  if (cache.enabled) features.push('cache');
  if (fallback.enabled) features.push('fallback');
  if (BUDGET_LIMIT) features.push('budget:$' + BUDGET_LIMIT.toFixed(2));
  if (features.length) console.log('[claudebridge] Features: ' + features.join(', '));
});
