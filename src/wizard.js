#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const os = require('node:os');
const { stdin, stdout } = require('node:process');
const { spawnSync } = require('node:child_process');
const { PROVIDERS } = require('./providers');

const ROOT = path.resolve(__dirname, '..');
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.claudebridge.env');

/* ══════════════════════════════════════════════════════════════════
   DESIGN SYSTEM
   Unified palette + primitives for a world-class terminal UI.
   ══════════════════════════════════════════════════════════════════ */

const isTTY = stdout.isTTY;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  // blue gradient
  b1: '\x1b[38;5;17m',
  b2: '\x1b[38;5;19m',
  b3: '\x1b[38;5;25m',
  b4: '\x1b[38;5;33m',
  b5: '\x1b[38;5;39m',   // primary
  b6: '\x1b[38;5;75m',
  b7: '\x1b[38;5;117m',
  // accents
  cyan: '\x1b[38;5;87m',
  green: '\x1b[38;5;84m',
  red: '\x1b[38;5;196m',
  yellow: '\x1b[38;5;220m',
  orange: '\x1b[38;5;208m',
  magenta: '\x1b[38;5;141m',
  white: '\x1b[38;5;255m',
  gray: '\x1b[38;5;243m',
  dgray: '\x1b[38;5;237m',
};

function s(color, text) {
  if (!isTTY) return text;
  return `${C[color] || ''}${text}${C.reset}`;
}

/* ── Box-drawing chars ── */
const B = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│', dot: '·',
  arrow: '›', check: '✔', cross: '✖', bullet: '●',
  diamond: '◆', star: '★', spark: '✦',
  bar: '█', barL: '░',
};

const W = 56; // inner box width

/* ══════════════════════════════════════════════════════════════════
   LAYOUT PRIMITIVES
   ══════════════════════════════════════════════════════════════════ */

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function pad(text, width = W) {
  const diff = width - stripAnsi(text).length;
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

function boxLine(content) {
  return `  ${s('b4', B.v)} ${pad(content, W)} ${s('b4', B.v)}`;
}

function boxTop(label = '') {
  const full = W + 2; // +2 for the spaces boxLine uses around content
  if (label) {
    const clean = stripAnsi(label);
    const left = 2;
    const right = full - left - clean.length;
    return `  ${s('b4', B.tl + B.h.repeat(left))}${label}${s('b4', B.h.repeat(Math.max(0, right)) + B.tr)}`;
  }
  return `  ${s('b4', B.tl + B.h.repeat(full) + B.tr)}`;
}

function boxBottom() {
  return `  ${s('b4', B.bl + B.h.repeat(W + 2) + B.br)}`;
}

function boxEmpty() {
  return boxLine('');
}

function nl() { console.log(''); }

/* ══════════════════════════════════════════════════════════════════
   ASCII ART HERO
   ══════════════════════════════════════════════════════════════════ */

function printHero() {
  const art = [
    '   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗',
    '  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝',
    '  ██║     ██║     ███████║██║   ██║██║  ██║█████╗  ',
    '  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ',
    '  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗',
    '   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝',
    '  ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗',
    '  ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝',
    '  ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  ',
    '  ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  ',
    '  ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗',
    '  ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝',
  ];

  const colors = ['b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];
  nl();
  for (let i = 0; i < art.length; i++) {
    console.log(s(colors[i] || 'b5', art[i]));
  }
  nl();
  console.log(`${' '.repeat(6)}${s('dim', s('b6', 'Any model. Any provider. Switch live with $$.'))}`);
  console.log(`${' '.repeat(6)}${s('dgray', 'v1.0.0  |  npx claudebridge')}`);
  nl();
}

/* ══════════════════════════════════════════════════════════════════
   PROGRESS BAR
   ══════════════════════════════════════════════════════════════════ */

const STEPS = [
  { icon: '🌐', label: 'Provider' },
  { icon: '🔑', label: 'Auth' },
  { icon: '🤖', label: 'Model' },
  { icon: '⚙️', label: 'Bridge' },
  { icon: '🧪', label: 'Test' },
];

function progressBar(current, total) {
  const filled = Math.round((current / total) * 20);
  const empty = 20 - filled;
  const bar = s('b5', B.bar.repeat(filled)) + s('dgray', B.barL.repeat(empty));
  const pct = Math.round((current / total) * 100);

  const dots = STEPS.map((st, i) => {
    const num = i + 1;
    if (num < current) return s('green', B.check);
    if (num === current) return s('b5', B.bullet);
    return s('dgray', B.dot);
  }).join('  ');

  console.log(boxTop());
  console.log(boxLine(`${dots}     ${bar}  ${s('b6', `${pct}%`)}`));
  console.log(boxBottom());
}

function stepHeader(step, title, subtitle = '') {
  nl();
  const badge = s('bold', s('b5', `STEP ${step}`));
  const label = s('bold', s('white', title));
  const icon = STEPS[step - 1]?.icon || '•';
  console.log(`  ${icon}  ${badge}  ${s('b4', B.h.repeat(3))}  ${label}`);
  if (subtitle) {
    console.log(`      ${s('gray', subtitle)}`);
  }
  nl();
}

/* ══════════════════════════════════════════════════════════════════
   PROMPT + STATUS HELPERS
   ══════════════════════════════════════════════════════════════════ */

function promptStr(label, hint = '') {
  const h = hint ? s('dgray', ` (${hint})`) : '';
  return `  ${s('b5', B.arrow)} ${s('white', label)}${h}${s('b5', ':')} `;
}

function promptDef(label, def) {
  return promptStr(label, `default: ${def}`);
}

function info(text) {
  console.log(`  ${s('b6', 'ℹ')}  ${s('gray', text)}`);
}

function ok(text) {
  console.log(`  ${s('green', B.check)}  ${s('white', text)}`);
}

function warn(text) {
  console.log(`  ${s('yellow', '⚠')}  ${s('yellow', text)}`);
}

function fail(text) {
  console.log(`  ${s('red', B.cross)}  ${s('red', text)}`);
}

/* ══════════════════════════════════════════════════════════════════
   PROVIDER ICONS
   ══════════════════════════════════════════════════════════════════ */

function providerIcon(id) {
  const map = {
    'openai': '🟢', 'openrouter': '🧩', 'opencode': '🔷', 'groq': '⚡',
    'together': '🤝', 'fireworks': '🎆', 'mistral': '🌪️', 'xai': '✴️',
    'deepinfra': '🔥', 'perplexity': '🧭', 'nvidia': '💚', 'cerebras': '🧠',
    'sambanova': '🟠', 'anyscale': '📐', 'deepseek': '🔍', 'moonshot': '🌙',
    '01ai': '🔢', 'hyperbolic': '🌀', 'novita': '✨', 'siliconflow': '🌊',
    'inference': '📡', 'friendli': '🫱', 'ollama': '🦙', 'lmstudio': '🖥️',
    'jan': '🤖', 'llamacpp': '🔧', 'vllm': '⚡', 'custom': '🛠️', 'modal': '🧱',
  };
  for (const [key, icon] of Object.entries(map)) {
    if (id.includes(key)) return icon;
  }
  return '🔹';
}

/* ══════════════════════════════════════════════════════════════════
   PROVIDER LIST
   ══════════════════════════════════════════════════════════════════ */

function printProviderList() {
  console.log(boxTop(s('bold', s('b6', ' Providers '))));
  console.log(boxEmpty());

  // split into two columns
  const half = Math.ceil(PROVIDERS.length / 2);
  for (let i = 0; i < half; i++) {
    const left = PROVIDERS[i];
    const right = PROVIDERS[i + half];

    const lNum = s('b5', String(i + 1).padStart(2));
    const lIcon = providerIcon(left.id);
    const lName = s('white', left.label.slice(0, 18).padEnd(18));

    let rPart = '';
    if (right) {
      const rNum = s('b5', String(i + half + 1).padStart(2));
      const rIcon = providerIcon(right.id);
      const rName = s('white', right.label.slice(0, 18));
      rPart = `  ${rNum} ${rIcon} ${rName}`;
    }

    console.log(boxLine(`${lNum} ${lIcon} ${lName}${rPart}`));
  }

  console.log(boxEmpty());
  console.log(boxBottom());
}

/* ══════════════════════════════════════════════════════════════════
   SUMMARY & LAUNCH CARDS
   ══════════════════════════════════════════════════════════════════ */

function summaryCard(config) {
  const mask = config.apiKey
    ? `${config.apiKey.slice(0, 4)}${'•'.repeat(12)}${config.apiKey.slice(-4)}`
    : 'not set';

  console.log(boxTop(s('bold', s('green', ' ✔ Configuration Saved '))));
  console.log(boxEmpty());
  console.log(boxLine(`  ${s('gray', 'Provider')}    ${s('white', config.baseUrl)}`));
  console.log(boxLine(`  ${s('gray', 'Endpoint')}    ${s('b6', `${config.baseUrl}${config.chatPath}`)}`));
  console.log(boxLine(`  ${s('gray', 'Model')}       ${s('cyan', config.model)}`));
  console.log(boxLine(`  ${s('gray', 'API Key')}     ${s('dgray', mask)}`));
  console.log(boxLine(`  ${s('gray', 'Bridge')}      ${s('b5', `http://localhost:${config.port}`)}`));
  console.log(boxEmpty());
  console.log(boxBottom());
}

function launchCard(port) {
  console.log(boxTop(s('bold', s('b6', ' Quick Start '))));
  console.log(boxEmpty());
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge'))}                ${s('gray', 'start bridge + claude')}`));
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge --doctor'))}       ${s('gray', 'run diagnostics')}`));
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge --help'))}         ${s('gray', 'all options')}`));
  console.log(boxEmpty());
  console.log(boxBottom());
}

/* ══════════════════════════════════════════════════════════════════
   NETWORK HELPERS
   ══════════════════════════════════════════════════════════════════ */

function parseEndpoint(endpoint) {
  if (!endpoint) throw new Error('Endpoint URL is required.');
  const parsed = new URL(endpoint);
  let chatPath = (parsed.pathname || '/v1/chat/completions').replace(/\/$/, '');
  // Auto-fix: if user gave a base like /v1/ instead of /v1/chat/completions
  if (chatPath && !chatPath.includes('/chat/completions')) chatPath = chatPath + '/chat/completions';
  return {
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    chatPath,
  };
}

function deriveModelPaths(chatPath) {
  const cands = [];
  if (chatPath.includes('/chat/completions')) {
    cands.push(chatPath.replace('/chat/completions', '/models'));
  }
  if (chatPath.endsWith('/completions')) {
    cands.push(chatPath.replace(/\/completions$/, '/models'));
  }
  const segs = chatPath.split('/').filter(Boolean);
  if (segs.length >= 2) cands.push(`/${segs[0]}/${segs[1]}/models`);
  cands.push('/v1/models', '/api/v1/models', '/models');
  return [...new Set(cands)];
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: r.ok, status: r.status, data, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

function parseModelIds(payload) {
  if (!payload || !Array.isArray(payload.data)) return [];
  return payload.data
    .map(m => { if (!m) return null; return typeof m === 'string' ? m : m.id || m.name || null; })
    .filter(Boolean);
}

async function discoverModels(config) {
  const paths = deriveModelPaths(config.chatPath);
  const headers = { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' };
  for (const mp of paths) {
    try {
      const res = await fetchJsonWithTimeout(`${config.baseUrl}${mp}`, { method: 'GET', headers }, 12000);
      const ids = parseModelIds(res.data);
      if (res.ok && ids.length) return { ok: true, source: mp, models: [...new Set(ids)] };
    } catch { /* next */ }
  }
  return { ok: false, source: null, models: [] };
}

/* ══════════════════════════════════════════════════════════════════
   SPINNER
   ══════════════════════════════════════════════════════════════════ */

async function withSpinner(label, work) {
  if (!isTTY) return work();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let idx = 0;
  stdout.write(`  ${s('b5', frames[idx])}  ${s('gray', label)}`);
  const timer = setInterval(() => {
    idx = (idx + 1) % frames.length;
    stdout.write(`\r  ${s('b5', frames[idx])}  ${s('gray', label)}`);
  }, 80);
  try {
    const result = await work();
    clearInterval(timer);
    stdout.write(`\r  ${s('green', B.check)}  ${s('white', label)}\n`);
    return result;
  } catch (err) {
    clearInterval(timer);
    stdout.write(`\r  ${s('red', B.cross)}  ${s('red', label)}\n`);
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════════
   FILE / ENV HELPERS
   ══════════════════════════════════════════════════════════════════ */

function buildEnvText(c) {
  return [
    `PORT=${c.port}`, `ZEN_API_KEY=${c.apiKey}`, `ZEN_BASE_URL=${c.baseUrl}`,
    `ZEN_CHAT_COMPLETIONS_PATH=${c.chatPath}`, `MINIMAX_MODEL=${c.model}`,
    'DEFAULT_TEMPERATURE=0.2', 'FORCE_MINIMAX_MODEL=true', '',
  ].join('\n');
}

function buildClaudeEnvText(port) {
  return [
    '# Source this file before launching Claude Code',
    '# Or better yet: run "node src/cli.js --install" to auto-configure',
    `export ANTHROPIC_BASE_URL="http://localhost:${port}"`,
    `export ANTHROPIC_API_URL="http://localhost:${port}"`,
    'export ANTHROPIC_AUTH_TOKEN="claudebridge-local-proxy"',
    'export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="1"', '',
  ].join('\n');
}

/**
 * Write to ~/.claude/settings.json so ALL Claude Code sessions
 * automatically route through the bridge. No manual exports needed.
 */
function installClaudeCodeSettings(port) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch { /* ok */ }

  // Load existing settings
  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch { settings = {}; }

  // Merge our env vars into settings.env
  if (!settings.env) settings.env = {};
  settings.env.ANTHROPIC_BASE_URL = `http://localhost:${port}`;
  settings.env.ANTHROPIC_AUTH_TOKEN = 'claudebridge-local-proxy';
  settings.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  return settingsPath;
}

function uninstallClaudeCodeSettings() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.env) {
      delete settings.env.ANTHROPIC_BASE_URL;
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
      delete settings.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
      delete settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
      if (Object.keys(settings.env).length === 0) delete settings.env;
    }
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function askYesNo(v, def = true) {
  const x = String(v || '').trim().toLowerCase();
  if (!x) return def;
  if (['y', 'yes'].includes(x)) return true;
  if (['n', 'no'].includes(x)) return false;
  return def;
}

function runCurlProviderTest(config) {
  const body = JSON.stringify({
    model: config.model,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    max_tokens: 8, temperature: 0,
  });
  const url = `${config.baseUrl}${config.chatPath}`;
  const args = ['-sS', '-X', 'POST', url, '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${config.apiKey}`, '-d', body, '--max-time', '20'];
  const res = spawnSync('curl', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (res.status !== 0) return { ok: false, output: res.stderr || res.stdout || 'curl error' };
  const text = (res.stdout || '').trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return { ok: false, output: `Non-JSON response:\n${text.slice(0, 500)}` };
  }
  const content = parsed?.choices?.[0]?.message?.content;
  return {
    ok: !parsed?.error,
    output: parsed?.error ? JSON.stringify(parsed.error)
      : `Model replied: ${JSON.stringify(content).slice(0, 160)}`,
  };
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MAIN WIZARD FLOW                                              ║
   ╚══════════════════════════════════════════════════════════════════╝ */

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    // ── HERO ──
    printHero();

    console.log(boxTop(s('bold', s('b6', ' Setup Wizard '))));
    console.log(boxLine(s('gray', 'Interactive setup — configure your AI provider in 5 steps.')));
    console.log(boxLine(s('dgray', 'Press Enter to accept defaults. Ctrl+C to abort.')));
    console.log(boxBottom());

    /* ═══════════════════════════════════════════════════════
       STEP 1 — PROVIDER
       ═══════════════════════════════════════════════════════ */
    nl();
    progressBar(1, 5);
    stepHeader(1, 'Choose your AI provider', 'Select from 24 pre-configured providers or bring your own');

    printProviderList();

    nl();
    const pickRaw = await rl.question(promptDef('Provider number', '1'));
    const pick = Number.parseInt(pickRaw, 10);
    const selected = PROVIDERS[(Number.isFinite(pick) ? pick : 1) - 1] || PROVIDERS[0];

    ok(`Selected ${s('bold', selected.label)} ${providerIcon(selected.id)}`);

    let baseUrl = selected.baseUrl;
    let chatPath = selected.chatPath;
    let model = selected.model;

    if (selected.requiresEndpointInput) {
      nl();
      const ep = await rl.question(promptStr('Full chat-completions URL'));
      const parsed = parseEndpoint(ep.trim());
      baseUrl = parsed.baseUrl;
      chatPath = parsed.chatPath;
      model = 'gpt-4o-mini';
    }

    nl();
    info(`Current endpoint: ${s('b6', `${baseUrl}${chatPath}`)}`);
    const epOverride = await rl.question(promptStr('Override endpoint?', 'Enter to keep'));
    if (epOverride.trim()) {
      const parsed = parseEndpoint(epOverride.trim());
      baseUrl = parsed.baseUrl;
      chatPath = parsed.chatPath;
      ok(`Endpoint → ${s('b6', `${baseUrl}${chatPath}`)}`);
    }

    /* ═══════════════════════════════════════════════════════
       STEP 2 — AUTH
       ═══════════════════════════════════════════════════════ */
    nl();
    progressBar(2, 5);
    stepHeader(2, 'Authentication', 'Enter your API key for the selected provider');

    const apiKeyRaw = await rl.question(promptStr('API key'));
    if (!apiKeyRaw.trim()) throw new Error('API key is required.');
    const apiKey = apiKeyRaw.trim().replace(/^Bearer\s+/i, '');
    ok('API key received');

    /* ═══════════════════════════════════════════════════════
       STEP 3 — MODEL
       ═══════════════════════════════════════════════════════ */
    nl();
    progressBar(3, 5);
    stepHeader(3, 'Select a model', 'Auto-discovering models from your provider...');

    const discovery = await withSpinner('Discovering models', () =>
      discoverModels({ baseUrl, chatPath, apiKey: apiKey.trim() })
    );

    if (discovery.ok) {
      const PAGE = 20;
      let page = 0;
      const totalPages = Math.ceil(discovery.models.length / PAGE);

      const showPage = (p) => {
        const start = p * PAGE;
        const end = Math.min(start + PAGE, discovery.models.length);
        nl();
        const pageLabel = totalPages > 1 ? ` (page ${p + 1}/${totalPages})` : '';
        console.log(boxTop(s('bold', s('b6', ` ${discovery.models.length} Models Available${pageLabel} `))));
        for (let i = start; i < end; i++) {
          const num = s('b5', String(i + 1).padStart(3));
          const name = s('white', discovery.models[i]);
          const tag = discovery.models[i] === model ? s('green', ' ← default') : '';
          console.log(boxLine(`  ${num}  ${name}${tag}`));
        }
        console.log(boxEmpty());
        const hints = [];
        if (p < totalPages - 1) hints.push(s('b5', 'n') + s('gray', '=next'));
        if (p > 0) hints.push(s('b5', 'p') + s('gray', '=prev'));
        if (totalPages > 1) hints.push(s('b5', '#') + s('gray', '=select by number'));
        if (hints.length) console.log(boxLine(`  ${hints.join('  ')}`));
        console.log(boxBottom());
      };

      showPage(page);

      let picked = false;
      while (!picked) {
        nl();
        const mc = await rl.question(promptDef('Model (# / n / p)', model));
        const input = mc.trim().toLowerCase();
        if (input === 'n' && page < totalPages - 1) {
          page++;
          showPage(page);
        } else if (input === 'p' && page > 0) {
          page--;
          showPage(page);
        } else {
          const pn = Number.parseInt(input, 10);
          if (Number.isFinite(pn) && pn >= 1 && pn <= discovery.models.length) {
            model = discovery.models[pn - 1];
          } else if (input) {
            model = input;
          }
          picked = true;
        }
      }
    } else {
      warn('Could not auto-discover models. Enter model ID manually.');
      const mi = await rl.question(promptDef('Model ID', model));
      if (mi.trim()) model = mi.trim();
    }

    ok(`Using model ${s('cyan', model)}`);

    /* ═══════════════════════════════════════════════════════
       STEP 4 — BRIDGE
       ═══════════════════════════════════════════════════════ */
    nl();
    progressBar(4, 5);
    stepHeader(4, 'Bridge configuration', 'Configure the local Anthropic-compatible proxy');

    const portIn = await rl.question(promptDef('Local port', '8787'));
    const port = portIn.trim() ? Number.parseInt(portIn.trim(), 10) : 8787;
    if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535.');
    ok(`Bridge will run on port ${s('b5', String(port))}`);

    // ── write config ──
    const config = { baseUrl, chatPath, apiKey: apiKey.trim(), model, port };

    // If a local .env exists, we update it. Otherwise, we write to the global one.
    const localEnvPath = path.join(ROOT, '.env');
    const envPath = fs.existsSync(localEnvPath) ? localEnvPath : GLOBAL_CONFIG_PATH;

    if (fs.existsSync(envPath)) {
      fs.copyFileSync(envPath, `${envPath}.backup`);
      info(`Backed up existing config → ${path.basename(envPath)}.backup`);
    }
    fs.writeFileSync(envPath, buildEnvText(config), 'utf8');
    try { fs.chmodSync(envPath, 0o600); } catch { /* best effort */ }
    ok(`Wrote ${s('gray', path.basename(envPath))}`);

    const cePath = envPath === GLOBAL_CONFIG_PATH ? path.join(os.homedir(), '.claudebridge-env.sh') : path.join(ROOT, 'claude-env.sh');
    fs.writeFileSync(cePath, buildClaudeEnvText(port), 'utf8');
    try { fs.chmodSync(cePath, 0o600); } catch { /* best effort */ }
    ok(`Wrote ${s('gray', path.basename(cePath))}`);

    // Auto-install into Claude Code's settings.json
    try {
      const settingsPath = installClaudeCodeSettings(port);
      ok(`Configured Claude Code globally ${s('gray', '(~/.claude/settings.json)')}`);
    } catch (e) {
      info(`Could not write Claude Code settings: ${e.message}`);
    }

    /* ═══════════════════════════════════════════════════════
       STEP 5 — TEST
       ═══════════════════════════════════════════════════════ */
    nl();
    progressBar(5, 5);
    stepHeader(5, 'Provider smoke test', 'Verify connectivity to your provider');

    const doTest = await rl.question(promptStr('Run a quick test?', 'Y/n'));
    if (askYesNo(doTest, true)) {
      const result = await withSpinner('Testing provider endpoint', () =>
        new Promise(resolve => resolve(runCurlProviderTest(config)))
      );
      if (result.ok) ok(result.output);
      else fail(`Test failed: ${result.output}`);
    } else {
      info('Skipped connectivity test');
    }

    /* ═══════════════════════════════════════════════════════
       DONE
       ═══════════════════════════════════════════════════════ */
    nl();
    progressBar(5, 5);
    nl();
    summaryCard(config);
    nl();
    launchCard(port);
    nl();
    console.log(`  ${s('green', B.spark)}  ${s('bold', s('white', 'Setup complete!'))} ${s('gray', 'Run')} ${s('bold', s('b5', 'claudebridge'))} ${s('gray', 'to start.')}`);
    nl();

  } catch (err) {
    nl();
    fail(`Wizard error: ${err.message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

module.exports = { installClaudeCodeSettings, uninstallClaudeCodeSettings };

if (require.main === module) main();
