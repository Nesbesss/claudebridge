#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const { PROVIDERS, getProviderById } = require('./providers');
const { ProfileManager } = require('./profiles');
const { formatCost, formatTokens, formatDuration } = require('./tracker');
const { installClaudeCodeSettings, uninstallClaudeCodeSettings } = require('./wizard');

const ROOT = path.resolve(__dirname, '..');
const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.claudebridge.env');
const profileMgr = new ProfileManager();

/* ══════════════════════════════════════════════════════════════════
   DESIGN SYSTEM — shared palette with wizard.js
   ══════════════════════════════════════════════════════════════════ */

const isTTY = process.stdout.isTTY;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',
  b1: '\x1b[38;5;17m',
  b2: '\x1b[38;5;19m',
  b3: '\x1b[38;5;25m',
  b4: '\x1b[38;5;33m',
  b5: '\x1b[38;5;39m',
  b6: '\x1b[38;5;75m',
  b7: '\x1b[38;5;117m',
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

const B = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│', dot: '·',
  arrow: '›', check: '✔', cross: '✖', bullet: '●',
  diamond: '◆', star: '★', spark: '✦',
  bar: '█', barL: '░',
};

const W = 56;

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
   HERO BANNER
   ══════════════════════════════════════════════════════════════════ */

function printBanner() {
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
  for (let i = 0; i < art.length; i++) console.log(s(colors[i], art[i]));
  nl();
  console.log(`${' '.repeat(6)}${s('dim', s('b6', 'Any model. Any provider. Switch live with $$.'))}`);
  console.log(`${' '.repeat(6)}${s('dgray', 'v2.0.0  |  npx claudebridge')}`);
  nl();
}

/* ══════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════ */

function truncate(text, max = 48) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function maskKey(key) {
  if (!key) return s('red', 'missing');
  if (key.length <= 10) return '••••••••';
  return `${key.slice(0, 4)}${'•'.repeat(10)}${key.slice(-4)}`;
}

function secureFile(fp) {
  try { fs.chmodSync(fp, 0o600); } catch { /* best effort */ }
}

const isWin = process.platform === 'win32';

function killProc(proc) {
  if (!proc || proc.killed) return;
  try {
    if (isWin) { spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { stdio: 'ignore' }); }
    else { proc.kill('SIGTERM'); }
  } catch { /* best effort */ }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
   SPINNER
   ══════════════════════════════════════════════════════════════════ */

async function withSpinner(label, work) {
  if (!isTTY) return work();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let idx = 0;
  process.stdout.write(`  ${s('b5', frames[idx])}  ${s('gray', label)}`);
  const timer = setInterval(() => {
    idx = (idx + 1) % frames.length;
    process.stdout.write(`\r  ${s('b5', frames[idx])}  ${s('gray', label)}`);
  }, 80);
  try {
    const result = await work();
    clearInterval(timer);
    process.stdout.write(`\r  ${s('green', B.check)}  ${s('white', label)}\n`);
    return result;
  } catch (err) {
    clearInterval(timer);
    process.stdout.write(`\r  ${s('red', B.cross)}  ${s('red', label)}\n`);
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════════
   RUNTIME DASHBOARD
   ══════════════════════════════════════════════════════════════════ */

function providerLabelForConfig(cfg) {
  const hit = PROVIDERS.find(p => p.baseUrl === cfg.baseUrl && p.chatPath === cfg.chatPath);
  return hit ? `${hit.label}` : 'Custom endpoint';
}

function providerIdForConfig(cfg) {
  const hit = PROVIDERS.find(p => p.baseUrl === cfg.baseUrl && p.chatPath === cfg.chatPath);
  return hit ? hit.id : 'custom';
}

function printRuntimeDashboard(cfg, opts) {
  const pId = providerIdForConfig(cfg);
  const icon = providerIcon(pId);

  console.log(boxTop(s('bold', s('b6', ' Session '))));
  console.log(boxEmpty());
  console.log(boxLine(`  ${s('gray', 'Provider')}    ${icon}  ${s('white', providerLabelForConfig(cfg))}`));
  console.log(boxLine(`  ${s('gray', 'Endpoint')}    ${s('b6', truncate(`${cfg.baseUrl}${cfg.chatPath}`, 38))}`));
  console.log(boxLine(`  ${s('gray', 'Model')}       ${s('cyan', truncate(cfg.model, 38))}`));
  console.log(boxLine(`  ${s('gray', 'API Key')}     ${s('dgray', maskKey(cfg.apiKey))}`));
  console.log(boxLine(`  ${s('gray', 'Bridge')}      ${s('b5', `http://localhost:${cfg.port}`)}`));
  console.log(boxLine(`  ${s('gray', 'Mode')}        ${s('white', opts.noClaude ? 'bridge-only' : 'bridge + claude')}`));
  if (opts.profile) {
    console.log(boxLine(`  ${s('gray', 'Profile')}     ${s('magenta', opts.profile)}`));
  }
  console.log(boxEmpty());

  // Feature status line
  const features = [];
  if (opts.enableRouting) features.push(s('green', '●') + s('gray', ' routing'));
  if (opts.enableCache || !opts.disableCache) features.push(s('green', '●') + s('gray', ' cache'));
  if (opts.enableFallback) features.push(s('green', '●') + s('gray', ' fallback'));
  if (opts.budget) features.push(s('yellow', '●') + s('gray', ` budget:$${opts.budget}`));
  if (features.length) {
    console.log(boxLine(`  ${s('gray', 'Features')}    ${features.join('  ')}`));
    console.log(boxEmpty());
  }

  console.log(boxLine(s('dgray', 'Tip: type $$help inside Claude to switch models live')));
  console.log(boxBottom());
}

/* ══════════════════════════════════════════════════════════════════
   ARG PARSING
   ══════════════════════════════════════════════════════════════════ */

function parseArgs(argv) {
  const opts = {
    help: false, wizard: false, doctor: false, test: false,
    noClaude: false, listModels: false, listProviders: false, verbose: false,
    switchProvider: '', switchModel: '', switchReset: false, switchStatus: false,
    endpoint: '', provider: '', apiKeyEnv: '', noPersistApiKey: false,
    baseUrl: '', path: '', apiKey: '', model: '', port: undefined,
    claudeBin: 'claude', claudeArgs: [],
    // v2 features
    profile: '', listProfiles: false, saveProfile: '', deleteProfile: '',
    stats: false, statsReset: false, cacheStats: false, cacheClear: false,
    routingStatus: false, fallbackStatus: false,
    enableRouting: false, disableRouting: false,
    enableFallback: false, disableFallback: false,
    enableCache: false, disableCache: false,
    budget: undefined, fallbackChain: '',
    install: false, uninstall: false,
  };
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (passthrough) { opts.claudeArgs.push(a); continue; }
    if (a === '--') { passthrough = true; continue; }
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--wizard') opts.wizard = true;
    else if (a === '--doctor') opts.doctor = true;
    else if (a === '--test') opts.test = true;
    else if (a === '--no-claude') opts.noClaude = true;
    else if (a === '--list-models') opts.listModels = true;
    else if (a === '--list-providers') opts.listProviders = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--switch') opts.switchProvider = argv[++i] || '';
    else if (a === '--switch-model') opts.switchModel = argv[++i] || '';
    else if (a === '--switch-reset') opts.switchReset = true;
    else if (a === '--switch-status') opts.switchStatus = true;
    else if (a === '--endpoint') opts.endpoint = argv[++i] || '';
    else if (a === '--provider') opts.provider = argv[++i] || '';
    else if (a === '--base-url') opts.baseUrl = argv[++i] || '';
    else if (a === '--path') opts.path = argv[++i] || '';
    else if (a === '--api-key') opts.apiKey = argv[++i] || '';
    else if (a === '--api-key-env') opts.apiKeyEnv = argv[++i] || '';
    else if (a === '--no-persist-api-key') opts.noPersistApiKey = true;
    else if (a === '--model') opts.model = argv[++i] || '';
    else if (a === '--port') opts.port = Number.parseInt(argv[++i] || '', 10);
    else if (a === '--claude-bin') opts.claudeBin = argv[++i] || 'claude';
    // global install
    else if (a === '--install') opts.install = true;
    else if (a === '--uninstall') opts.uninstall = true;
    // v2 features
    else if (a === '--profile') opts.profile = argv[++i] || '';
    else if (a === '--list-profiles') opts.listProfiles = true;
    else if (a === '--save-profile') opts.saveProfile = argv[++i] || '';
    else if (a === '--delete-profile') opts.deleteProfile = argv[++i] || '';
    else if (a === '--stats') opts.stats = true;
    else if (a === '--stats-reset') opts.statsReset = true;
    else if (a === '--cache-stats') opts.cacheStats = true;
    else if (a === '--cache-clear') opts.cacheClear = true;
    else if (a === '--routing-status') opts.routingStatus = true;
    else if (a === '--fallback-status') opts.fallbackStatus = true;
    else if (a === '--enable-routing') opts.enableRouting = true;
    else if (a === '--disable-routing') opts.disableRouting = true;
    else if (a === '--enable-fallback') opts.enableFallback = true;
    else if (a === '--disable-fallback') opts.disableFallback = true;
    else if (a === '--enable-cache') opts.enableCache = true;
    else if (a === '--disable-cache') opts.disableCache = true;
    else if (a === '--budget') opts.budget = Number.parseFloat(argv[++i] || '0');
    else if (a === '--fallback-chain') opts.fallbackChain = argv[++i] || '';
    else opts.claudeArgs.push(a);
  }
  return opts;
}

/* ══════════════════════════════════════════════════════════════════
   HELP
   ══════════════════════════════════════════════════════════════════ */

function printHelp() {
  printBanner();
  console.log(boxTop(s('bold', s('b6', ' Usage '))));
  console.log(boxEmpty());
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge'))}               ${s('gray', 'launch')}`));
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge --wizard'))}      ${s('gray', 'setup')}`));
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge --doctor'))}      ${s('gray', 'diagnose')}`));
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge --profile fast'))} ${s('gray', 'preset')}`));
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge --stats'))}       ${s('gray', 'dashboard')}`));
  console.log(boxLine(`  ${s('b5', '❯')} ${s('bold', s('white', 'claudebridge --no-claude'))}   ${s('gray', 'bridge only')}`));
  console.log(boxEmpty());
  console.log(boxBottom());

  nl();
  console.log(boxTop(s('bold', s('b6', ' $$ Live Switching '))));
  console.log(boxEmpty());
  console.log(boxLine(`  ${s('gray', 'Type these')} ${s('bold', s('white', 'inside Claude'))} ${s('gray', 'to switch on-the-fly:')}`));
  console.log(boxEmpty());
  console.log(boxLine(`  ${s('b5', '$$groq')}              ${s('gray', 'switch to Groq')}`));
  console.log(boxLine(`  ${s('b5', '$$ollama')}            ${s('gray', 'switch to local Ollama')}`));
  console.log(boxLine(`  ${s('b5', '$$deepseek')}          ${s('gray', 'switch to DeepSeek')}`));
  console.log(boxLine(`  ${s('b5', '$$model:gpt-4o')}      ${s('gray', 'change model only')}`));
  console.log(boxLine(`  ${s('b5', '$$groq hello!')}       ${s('gray', 'one-shot with Groq')}`));
  console.log(boxLine(`  ${s('b5', '$$status')}            ${s('gray', 'show current config')}`));
  console.log(boxLine(`  ${s('b5', '$$models')}            ${s('gray', 'list providers')}`));
  console.log(boxLine(`  ${s('b5', '$$reset')}             ${s('gray', 'back to default')}`));
  console.log(boxLine(`  ${s('b5', '$$help')}              ${s('gray', 'show all commands')}`));
  console.log(boxEmpty());
  console.log(boxBottom());

  nl();
  console.log(boxTop(s('bold', s('b6', ' Options '))));
  console.log(boxEmpty());

  const opts = [
    ['--help, -h', 'Show this help'],
    ['--wizard', 'Run interactive setup wizard'],
    ['--doctor', 'Run diagnostics and exit'],
    ['--test', 'Run provider smoke test'],
    ['', ''],
    ['--provider <id>', 'Apply provider preset'],
    ['--list-models', 'Print models from provider'],
    ['--list-providers', 'Print all provider presets'],
    ['--model <id>', 'Override model for this run'],
    ['--endpoint <url>', 'Full chat-completions URL'],
    ['--base-url <url>', 'Override provider base URL'],
    ['--path <path>', 'Override provider chat path'],
    ['--api-key <key>', 'Override API key'],
    ['--api-key-env <var>', 'Read API key from env var'],
    ['--no-persist-api-key', 'Don\'t write key to .env'],
    ['--port <n>', 'Override local bridge port'],
    ['', ''],
    ['--profile <name>', 'Launch with a profile preset'],
    ['--list-profiles', 'Show all profiles'],
    ['--save-profile <name>', 'Save current cfg as profile'],
    ['--delete-profile <n>', 'Delete a custom profile'],
    ['', ''],
    ['--stats', 'Show session + cost stats'],
    ['--stats-reset', 'Reset session stats'],
    ['--budget <$>', 'Set session budget limit'],
    ['', ''],
    ['--enable-routing', 'Enable smart task routing'],
    ['--enable-fallback', 'Enable fallback chains'],
    ['--enable-cache', 'Enable response caching'],
    ['--disable-routing', 'Disable smart routing'],
    ['--disable-fallback', 'Disable fallback chains'],
    ['--disable-cache', 'Disable response caching'],
    ['--fallback-chain <ids>', 'Comma-separated providers'],
    ['--cache-clear', 'Flush the response cache'],
    ['', ''],
    ['--switch <provider>', 'Hot-switch running bridge'],
    ['--switch-model <id>', 'Hot-switch model on bridge'],
    ['--switch-reset', 'Reset bridge to defaults'],
    ['--switch-status', 'Show bridge runtime status'],
    ['', ''],
    ['--no-claude', 'Start bridge only, no Claude'],
    ['--install', 'Globally configure Claude Code'],
    ['--uninstall', 'Remove global configuration'],
    ['--claude-bin <bin>', 'Claude executable path'],
    ['--verbose, -v', 'Show bridge request logs'],
    ['--', 'Pass remaining args to Claude'],
  ];

  for (const [flag, desc] of opts) {
    if (!flag) { console.log(boxEmpty()); continue; }
    console.log(boxLine(`  ${s('b5', flag.padEnd(22))} ${s('gray', desc)}`));
  }

  console.log(boxEmpty());
  console.log(boxBottom());
  nl();
}

/* ══════════════════════════════════════════════════════════════════
   PROVIDER LIST
   ══════════════════════════════════════════════════════════════════ */

function printProviders() {
  nl();
  console.log(boxTop(s('bold', s('b6', ' Provider Presets '))));
  console.log(boxEmpty());

  for (const p of PROVIDERS) {
    const icon = providerIcon(p.id);
    const ep = p.baseUrl && p.chatPath ? `${p.baseUrl}${p.chatPath}` : 'custom';
    console.log(boxLine(`  ${icon}  ${s('bold', s('white', p.id.padEnd(16)))} ${s('gray', truncate(p.label, 32))}`));
    console.log(boxLine(`      ${s('dgray', truncate(ep, 50))}`));
  }

  console.log(boxEmpty());
  console.log(boxBottom());
  nl();
}

/* ══════════════════════════════════════════════════════════════════
   CONFIG LOADING
   ══════════════════════════════════════════════════════════════════ */

function parseEndpoint(endpoint) {
  const parsed = new URL(endpoint);
  let chatPath = (parsed.pathname || '/v1/chat/completions').replace(/\/$/, '');
  // Auto-fix: if user gave a base like /v1/ instead of /v1/chat/completions
  if (chatPath && !chatPath.includes('/chat/completions')) chatPath = chatPath + '/chat/completions';
  return {
    baseUrl: `${parsed.protocol}//${parsed.host}`,
    chatPath,
  };
}

function loadConfigFromEnvFile() {
  const localEnvPath = path.join(ROOT, '.env');
  const globalEnvPath = GLOBAL_CONFIG_PATH;

  let envPath = localEnvPath;
  let exists = fs.existsSync(localEnvPath);

  if (!exists && fs.existsSync(globalEnvPath)) {
    envPath = globalEnvPath;
    exists = true;
  }

  if (exists) dotenv.config({ path: envPath, override: true });

  return {
    exists, path: envPath, isGlobal: envPath === globalEnvPath,
    port: Number(process.env.PORT || 8787),
    apiKey: process.env.CLAUDEBRIDGE_API_KEY || process.env.ZEN_API_KEY || '',
    baseUrl: (process.env.ZEN_BASE_URL || '').replace(/\/$/, ''),
    chatPath: (() => {
      let p = (process.env.ZEN_CHAT_COMPLETIONS_PATH || '/v1/chat/completions').replace(/\/$/, '');
      if (p && !p.includes('/chat/completions')) p = p + '/chat/completions';
      return p;
    })(),
    model: process.env.MINIMAX_MODEL || 'minimax/minimax-2.5-chat',
  };
}

function applyOverrides(cfg, opts) {
  const out = { ...cfg };
  if (opts.provider) {
    const p = getProviderById(opts.provider);
    if (!p) throw new Error(`Unknown provider '${opts.provider}'. Use --list-providers.`);
    if (p.baseUrl) out.baseUrl = p.baseUrl;
    if (p.chatPath) out.chatPath = p.chatPath;
    if (p.model) out.model = p.model;
  }
  if (opts.endpoint) {
    const parsed = parseEndpoint(opts.endpoint);
    out.baseUrl = parsed.baseUrl;
    out.chatPath = parsed.chatPath;
  }
  if (opts.baseUrl) out.baseUrl = opts.baseUrl.replace(/\/$/, '');
  if (opts.path) out.chatPath = opts.path;
  if (opts.apiKeyEnv) out.apiKey = process.env[opts.apiKeyEnv] || '';
  if (opts.apiKey) out.apiKey = opts.apiKey;
  if (opts.model) out.model = opts.model;
  if (Number.isFinite(opts.port)) out.port = opts.port;
  return out;
}

function saveConfig(cfg, opts) {
  const key = opts.noPersistApiKey ? process.env.ZEN_API_KEY || '' : cfg.apiKey;
  const text = [
    `PORT=${cfg.port}`, `ZEN_API_KEY=${key}`, `ZEN_BASE_URL=${cfg.baseUrl}`,
    `ZEN_CHAT_COMPLETIONS_PATH=${cfg.chatPath}`, `MINIMAX_MODEL=${cfg.model}`,
    'DEFAULT_TEMPERATURE=0.2', 'FORCE_MINIMAX_MODEL=true', '',
  ].join('\n');

  // If a local .env exists, we update it. Otherwise, we update the global one.
  const localEnvPath = path.join(ROOT, '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : GLOBAL_CONFIG_PATH;

  fs.writeFileSync(envPath, text, 'utf8');
  secureFile(envPath);
}

/* ══════════════════════════════════════════════════════════════════
   NETWORK / MODEL / SMOKE
   ══════════════════════════════════════════════════════════════════ */

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

function deriveModelPaths(chatPath) {
  const c = [];
  if (chatPath.includes('/chat/completions')) c.push(chatPath.replace('/chat/completions', '/models'));
  c.push('/v1/models', '/api/v1/models', '/models');
  return [...new Set(c)];
}

function parseModelIds(payload) {
  if (!payload || !Array.isArray(payload.data)) return [];
  return payload.data.map(m => (typeof m === 'string' ? m : m?.id || m?.name || null)).filter(Boolean);
}

async function listModels(cfg) {
  const headers = { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' };
  for (const p of deriveModelPaths(cfg.chatPath)) {
    try {
      const res = await fetchJsonWithTimeout(`${cfg.baseUrl}${p}`, { method: 'GET', headers }, 12000);
      const ids = parseModelIds(res.data);
      if (res.ok && ids.length) return { ok: true, models: ids, source: p };
    } catch { /* next */ }
  }
  return { ok: false, models: [], source: '' };
}

function runProviderSmokeTest(cfg) {
  const body = JSON.stringify({
    model: cfg.model,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    max_tokens: 8, temperature: 0,
  });
  const url = `${cfg.baseUrl}${cfg.chatPath}`;
  const args = ['-sS', '-X', 'POST', url, '-H', 'Content-Type: application/json',
    '-H', `Authorization: Bearer ${cfg.apiKey}`, '-d', body, '--max-time', '20'];
  const res = spawnSync('curl', args, { encoding: 'utf8', shell: isWin });
  if (res.status !== 0) return { ok: false, detail: res.stderr || res.stdout || 'curl failed' };
  try {
    const parsed = JSON.parse((res.stdout || '').trim());
    if (parsed?.error) return { ok: false, detail: JSON.stringify(parsed.error) };
    return { ok: true, detail: 'Provider chat-completions request succeeded.' };
  } catch {
    return { ok: false, detail: `Non-JSON: ${(res.stdout || '').slice(0, 300)}` };
  }
}

async function waitForHealth(baseUrl, maxMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try { const r = await fetch(`${baseUrl}/health`); if (r.ok) return true; } catch { /* retry */ }
    await sleep(250);
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════
   DOCTOR
   ══════════════════════════════════════════════════════════════════ */

async function runDoctor(cfg) {
  nl();
  console.log(boxTop(s('bold', s('b6', ' Doctor '))));
  console.log(boxLine(s('gray', 'Running diagnostics...')));
  console.log(boxBottom());
  nl();

  const checks = [];
  checks.push({ name: 'API key present', ok: !!cfg.apiKey, detail: cfg.apiKey ? 'yes' : 'missing' });
  checks.push({ name: 'Base URL present', ok: !!cfg.baseUrl, detail: cfg.baseUrl || 'missing' });
  checks.push({ name: 'Chat path present', ok: !!cfg.chatPath, detail: cfg.chatPath || 'missing' });
  checks.push({ name: 'Model present', ok: !!cfg.model, detail: cfg.model || 'missing' });

  const modelRes = await listModels(cfg);
  checks.push({
    name: 'Model endpoint reachable',
    ok: modelRes.ok,
    detail: modelRes.ok ? `found ${modelRes.models.length} via ${modelRes.source}` : 'not reachable',
  });

  const smoke = runProviderSmokeTest(cfg);
  checks.push({ name: 'Chat-completions test', ok: smoke.ok, detail: smoke.detail });

  console.log(boxTop(s('bold', s('b6', ' Results '))));
  console.log(boxEmpty());

  for (const c of checks) {
    const mark = c.ok ? s('green', B.check) : s('red', B.cross);
    const label = s('white', c.name.padEnd(26));
    const detail = s(c.ok ? 'gray' : 'red', truncate(c.detail, 28));
    console.log(boxLine(`  ${mark}  ${label} ${detail}`));
  }

  console.log(boxEmpty());

  const allOk = checks.every(c => c.ok);
  const verdict = allOk
    ? s('bold', s('green', '  ALL CHECKS PASSED'))
    : s('bold', s('red', '  SOME CHECKS FAILED'));
  console.log(boxLine(verdict));
  console.log(boxEmpty());
  console.log(boxBottom());
  nl();

  process.exit(allOk ? 0 : 1);
}

/* ══════════════════════════════════════════════════════════════════
   PROFILES
   ══════════════════════════════════════════════════════════════════ */

function printProfiles() {
  const profiles = profileMgr.list();
  const active = profileMgr.getActive();
  nl();
  console.log(boxTop(s('bold', s('b6', ' Profiles '))));
  console.log(boxEmpty());

  for (const p of profiles) {
    const isActive = p.id === active;
    const tag = isActive ? s('green', ' ← active') : '';
    const builtinTag = p.builtin ? s('dgray', ' (built-in)') : '';
    console.log(boxLine(`  ${s('b5', B.diamond)}  ${s('bold', s('white', p.id.padEnd(12)))} ${s('gray', truncate(p.description || '', 28))}${tag}${builtinTag}`));
    console.log(boxLine(`      ${s('dgray', `${p.provider} → ${p.model}`)}`));
  }

  console.log(boxEmpty());
  console.log(boxLine(s('dgray', 'Use --profile <name> to launch with a profile')));
  console.log(boxBottom());
  nl();
}

/* ══════════════════════════════════════════════════════════════════
   STATS DASHBOARD
   ══════════════════════════════════════════════════════════════════ */

async function printStats(cfg) {
  const port = cfg.port || Number(process.env.PORT || 8787);
  const base = `http://127.0.0.1:${port}`;

  try {
    const r = await fetch(`${base}/v1/stats`);
    const data = await r.json();
    const sess = data.session || {};
    const allTime = data.allTime || {};
    const cacheInfo = data.cache || {};
    const routingInfo = data.routing || {};
    const fallbackInfo = data.fallback || {};

    nl();
    console.log(boxTop(s('bold', s('b6', ' Session Stats '))));
    console.log(boxEmpty());
    console.log(boxLine(`  ${s('gray', 'Requests')}     ${s('white', String(sess.requests || 0))}  ${s('dgray', `(${sess.errors || 0} errors)`)}`));
    console.log(boxLine(`  ${s('gray', 'Tokens')}       ${s('cyan', formatTokens(sess.totalTokens || 0))}  ${s('dgray', `(${formatTokens(sess.totalInputTokens || 0)} in / ${formatTokens(sess.totalOutputTokens || 0)} out)`)}`));
    console.log(boxLine(`  ${s('gray', 'Cost')}         ${s('green', sess.totalCostFormatted || '$0.00')}`));
    console.log(boxLine(`  ${s('gray', 'Avg Latency')}  ${s('white', `${sess.avgLatencyMs || 0}ms`)}`));
    console.log(boxLine(`  ${s('gray', 'Avg TTFT')}     ${s('white', `${sess.avgTTFTMs || 0}ms`)}`));
    console.log(boxLine(`  ${s('gray', 'Throughput')}   ${s('b5', `${sess.avgTokensPerSec || 0} tok/s`)}`));
    console.log(boxLine(`  ${s('gray', 'Uptime')}       ${s('white', sess.uptimeFormatted || '0s')}`));
    console.log(boxEmpty());

    // By model breakdown
    if (sess.byModel && Object.keys(sess.byModel).length > 0) {
      console.log(boxLine(s('bold', s('b6', 'By Model:'))));
      for (const [model, stats] of Object.entries(sess.byModel)) {
        const avgLat = stats.requests > 0 ? Math.round(stats.totalLatencyMs / stats.requests) : 0;
        console.log(boxLine(`  ${s('b5', B.bullet)}  ${s('white', truncate(model, 20).padEnd(22))} ${s('gray', `${stats.requests}req`)} ${s('green', formatCost(stats.cost))} ${s('dgray', `${avgLat}ms`)}`));
      }
      console.log(boxEmpty());
    }

    console.log(boxBottom());

    // Features status
    nl();
    console.log(boxTop(s('bold', s('b6', ' Features '))));
    console.log(boxEmpty());

    const routeStatus = routingInfo.enabled ? s('green', '● ON') : s('dgray', '○ OFF');
    const cacheStatus = cacheInfo.enabled ? s('green', '● ON') : s('dgray', '○ OFF');
    const fallbackStatus = fallbackInfo.enabled ? s('green', '● ON') : s('dgray', '○ OFF');

    console.log(boxLine(`  ${s('gray', 'Routing')}   ${routeStatus}  ${s('dgray', routingInfo.enabled ? `${routingInfo.totalRouted || 0} routed` : '')}`));
    console.log(boxLine(`  ${s('gray', 'Cache')}     ${cacheStatus}  ${s('dgray', cacheInfo.enabled ? `${cacheInfo.hitRate || '0%'} hit rate, ${cacheInfo.entries || 0} entries` : '')}`));
    console.log(boxLine(`  ${s('gray', 'Fallback')}  ${fallbackStatus}  ${s('dgray', fallbackInfo.enabled ? `${fallbackInfo.stats?.totalFallbacks || 0} fallbacks` : '')}`));

    if (sess.budget && sess.budget.status !== 'no-limit') {
      const budgetIcon = sess.budget.status === 'exceeded' ? s('red', '●') : sess.budget.status === 'warning' ? s('yellow', '●') : s('green', '●');
      console.log(boxLine(`  ${s('gray', 'Budget')}    ${budgetIcon}  ${s('dgray', `${sess.totalCostFormatted} used`)}`));
    }

    console.log(boxEmpty());
    console.log(boxBottom());

    // All-time
    if (allTime.sessions > 0) {
      nl();
      console.log(boxTop(s('bold', s('b6', ' All-Time '))));
      console.log(boxEmpty());
      console.log(boxLine(`  ${s('gray', 'Sessions')}  ${s('white', String(allTime.sessions))}`));
      console.log(boxLine(`  ${s('gray', 'Requests')}  ${s('white', String(allTime.totalRequests || 0))}`));
      console.log(boxLine(`  ${s('gray', 'Tokens')}    ${s('cyan', formatTokens(allTime.totalTokens || 0))}`));
      console.log(boxLine(`  ${s('gray', 'Spent')}     ${s('green', allTime.totalCostFormatted || '$0.00')}`));
      console.log(boxEmpty());
      console.log(boxBottom());
    }

    nl();
  } catch {
    console.log(`  ${s('red', B.cross)}  ${s('red', 'Bridge not running. Start first with: claudebridge')}`);
    process.exit(1);
  }
}

/* ══════════════════════════════════════════════════════════════════
   WIZARD
   ══════════════════════════════════════════════════════════════════ */

async function runWizard() {
  const r = spawn(process.execPath, ['src/wizard.js'], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  await new Promise((resolve, reject) => {
    r.on('error', reject);
    r.on('exit', code => code === 0 ? resolve() : reject(new Error(`Wizard exited with code ${code}`)));
  });
}

/* ══════════════════════════════════════════════════════════════════
   LAUNCH (bridge + claude)
   ══════════════════════════════════════════════════════════════════ */

async function runLaunch(cfg, opts) {
  const localBaseUrl = `http://127.0.0.1:${cfg.port}`;
  const logPath = cfg.isGlobal ? path.join(os.homedir(), '.claudebridge.log') : path.join(ROOT, '.claudebridge.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  secureFile(logPath);

  const serverEnv = {
    ...process.env,
    PORT: String(cfg.port),
    ZEN_API_KEY: cfg.apiKey,
    ZEN_BASE_URL: cfg.baseUrl,
    ZEN_CHAT_COMPLETIONS_PATH: cfg.chatPath,
    MINIMAX_MODEL: cfg.model,
    BRIDGE_LOG_REQUESTS: opts.verbose ? 'true' : 'false',
    CLAUDEBRIDGE_ROUTING: opts.enableRouting ? 'true' : 'false',
    CLAUDEBRIDGE_CACHE: opts.disableCache ? 'false' : 'true',
    CLAUDEBRIDGE_FALLBACK: opts.enableFallback ? 'true' : 'false',
    CLAUDEBRIDGE_BUDGET: opts.budget != null ? String(opts.budget) : '',
    CLAUDEBRIDGE_FALLBACK_CHAIN: opts.fallbackChain || '',
  };

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', d => {
    logStream.write(d);
    if (opts.verbose) process.stdout.write(`  ${s('dgray', '[bridge]')} ${d}`);
  });
  server.stderr.on('data', d => {
    logStream.write(d);
    if (opts.verbose) process.stderr.write(`  ${s('dgray', '[bridge]')} ${d}`);
  });

  const healthy = await withSpinner('Starting local bridge', () => waitForHealth(localBaseUrl));
  if (!healthy) {
    console.log(`  ${s('red', B.cross)}  ${s('red', 'Bridge health check failed.')}`);
    console.log(`      ${s('dgray', `See logs: ${logPath}`)}`);
    killProc(server);
    logStream.end();
    process.exit(1);
    return;
  }

  console.log(`  ${s('green', B.check)}  ${s('white', 'Bridge ready at')} ${s('b5', localBaseUrl)}`);
  if (!opts.verbose) {
    console.log(`      ${s('dgray', 'Bridge logs hidden. Use --verbose to see live logs.')}`);
  }

  if (opts.test) {
    const smoke = runProviderSmokeTest(cfg);
    if (!smoke.ok) {
      console.log(`  ${s('red', B.cross)}  ${s('red', `Provider test failed: ${smoke.detail}`)}`);
      if (!server.killed) server.kill('SIGTERM');
      logStream.end();
      process.exit(1);
      return;
    }
    console.log(`  ${s('green', B.check)}  ${s('white', 'Provider smoke test passed')}`);
  }

  /* Silently ensure Claude Code global settings are in place */
  try { installClaudeCodeSettings(PORT); } catch (_e) { /* best effort */ }

  if (opts.noClaude) {
    nl();
    console.log(boxTop(s('bold', s('b6', ' Bridge Mode '))));
    console.log(boxEmpty());
    console.log(boxLine(s('gray', 'Bridge is running. Press Ctrl+C to stop.')));
    console.log(boxEmpty());
    console.log(boxLine(`${s('white', 'Open any terminal and just run:')}  ${s('bold', s('b5', 'claude'))}`));
    console.log(boxLine(s('gray', 'All Claude sessions auto-route through the bridge.')));
    console.log(boxEmpty());
    console.log(boxLine(s('dgray', 'Not working? Run: claudebridge --install')));
    console.log(boxEmpty());
    console.log(boxBottom());
    nl();
    const shutdown = () => {
      killProc(server);
      logStream.end();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  // Configure Claude Code to route through our bridge.
  // Per Anthropic docs (code.claude.com/docs/en/llm-gateway):
  //   ANTHROPIC_BASE_URL  → points to our local bridge
  //   ANTHROPIC_AUTH_TOKEN → auth token (bridge ignores it, uses its own key)
  // We also disable beta headers since we translate to OpenAI format.
  const claudeEnv = { ...process.env };
  claudeEnv.ANTHROPIC_BASE_URL = localBaseUrl;
  claudeEnv.ANTHROPIC_API_URL = localBaseUrl;
  claudeEnv.ANTHROPIC_AUTH_TOKEN = 'claudebridge-local-proxy';
  claudeEnv.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
  // Remove any API key that could conflict with AUTH_TOKEN
  delete claudeEnv.ANTHROPIC_API_KEY;

  nl();
  console.log(`  ${s('b5', B.arrow)}  ${s('white', 'Launching')} ${s('bold', s('b5', opts.claudeBin))} ${s('gray', 'with bridged Anthropic URL...')}`);
  nl();

  const claude = spawn(opts.claudeBin, opts.claudeArgs, {
    cwd: process.cwd(), env: claudeEnv, stdio: 'inherit',
    shell: isWin,
  });

  const shutdown = () => {
    killProc(claude);
    killProc(server);
    logStream.end();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  claude.on('exit', (code, signal) => {
    killProc(server);
    logStream.end();
    if (signal && !isWin) { process.kill(process.pid, signal); return; }
    process.exit(code ?? 0);
  });

  claude.on('error', err => {
    console.log(`  ${s('red', B.cross)}  ${s('red', `Could not start Claude CLI: ${err.message}`)}`);
    killProc(server);
    logStream.end();
    process.exit(1);
  });
}

/* ╔══════════════════════════════════════════════════════════════════╗
   ║  MAIN                                                          ║
   ╚══════════════════════════════════════════════════════════════════╝ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }

  printBanner();

  if (opts.apiKey) {
    console.log(`  ${s('yellow', '⚠')}  ${s('yellow', 'Security: --api-key may be in shell history. Prefer --api-key-env <VAR>.')}`);
    nl();
  }

  if (opts.listProviders) {
    printProviders();
    return;
  }

  /* ── Global install/uninstall (writes to ~/.claude/settings.json) ── */
  if (opts.install) {
    const cfg = loadConfigFromEnvFile();
    const port = cfg.port || 8787;
    try {
      const settingsPath = installClaudeCodeSettings(port);
      nl();
      console.log(boxTop(s('bold', s('b6', ' Installed '))));
      console.log(boxEmpty());
      console.log(boxLine(`  ${s('green', B.check)}  ${s('white', 'Claude Code globally configured')}`));
      console.log(boxLine(`  ${s('gray', 'File')}    ${s('dgray', settingsPath)}`));
      console.log(boxEmpty());
      console.log(boxLine(s('white', 'How to use:')));
      console.log(boxLine(`  ${s('b5', '1.')} Start the bridge:  ${s('bold', 'node src/cli.js --no-claude')}`));
      console.log(boxLine(`  ${s('b5', '2.')} Open any terminal:  ${s('bold', 'claude')}`));
      console.log(boxLine(`  ${s('b5', '3.')} Open more terminals: ${s('bold', 'claude')}  ${s('gray', '(all share one bridge)')}`));
      console.log(boxEmpty());
      console.log(boxLine(s('dgray', 'Every Claude instance auto-routes through the bridge.')));
      console.log(boxLine(s('dgray', 'Run --uninstall to revert to direct Anthropic.')));
      console.log(boxEmpty());
      console.log(boxBottom());
      nl();
    } catch (e) {
      console.log(`  ${s('red', B.cross)}  ${s('red', `Install failed: ${e.message}`)}`);
    }
    return;
  }

  if (opts.uninstall) {
    const ok = uninstallClaudeCodeSettings();
    if (ok) {
      nl();
      console.log(`  ${s('green', B.check)}  ${s('white', 'ClaudeBridge removed from Claude Code settings')}`);
      console.log(`      ${s('gray', 'Claude will connect directly to Anthropic again.')}`);
      nl();
    } else {
      console.log(`  ${s('yellow', '⚠')}  ${s('yellow', 'No ClaudeBridge settings found to remove.')}`);
    }
    return;
  }

  if (opts.listProfiles) {
    printProfiles();
    return;
  }

  /* ── $$ hot-switch commands (talk to running bridge) ── */
  if (opts.switchStatus || opts.switchProvider || opts.switchModel || opts.switchReset) {
    const port = opts.port || Number(process.env.PORT || 8787);
    const base = `http://127.0.0.1:${port}`;

    if (opts.switchStatus) {
      try {
        const r = await fetch(`${base}/v1/switch/status`);
        const data = await r.json();
        nl();
        console.log(boxTop(s('bold', s('b6', ' Bridge Status '))));
        console.log(boxEmpty());
        console.log(boxLine(`  ${s('gray', 'Model')}       ${s('cyan', data.activeModel)}`));
        console.log(boxLine(`  ${s('gray', 'Provider')}    ${s('white', data.providerLabel)}`));
        console.log(boxLine(`  ${s('gray', 'Endpoint')}    ${s('b6', data.activeProvider + data.activePath)}`));
        console.log(boxLine(`  ${s('gray', 'Override')}    ${data.isOverridden ? s('yellow', 'yes') : s('green', 'no (default)')}`));
        console.log(boxEmpty());
        if (data.history?.length) {
          console.log(boxLine(s('bold', s('b6', 'Recent switches:'))));
          for (const h of data.history) {
            console.log(boxLine(`  ${s('dgray', h.time)}  ${s('b5', '→')}  ${s('white', h.model)} ${s('dgray', `(${h.provider})`)}`));
          }
          console.log(boxEmpty());
        }
        console.log(boxBottom());
        nl();
      } catch {
        console.log(`  ${s('red', B.cross)}  ${s('red', 'Bridge not running. Start with: claudebridge --no-claude')}`);
      }
      return;
    }

    if (opts.switchReset) {
      try {
        const r = await fetch(`${base}/v1/switch/reset`, { method: 'POST' });
        const data = await r.json();
        console.log(`  ${s('green', B.check)}  ${s('white', 'Reset to default:')} ${s('cyan', data.model)}`);
      } catch {
        console.log(`  ${s('red', B.cross)}  ${s('red', 'Bridge not running.')}`);
      }
      return;
    }

    if (opts.switchProvider) {
      try {
        const r = await fetch(`${base}/v1/switch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: opts.switchProvider }),
        });
        const data = await r.json();
        if (data.ok) {
          console.log(`  ${s('green', B.check)}  ${s('white', 'Switched to')} ${s('bold', s('cyan', data.provider))} ${s('gray', `(${data.model})`)}`);
        } else {
          console.log(`  ${s('red', B.cross)}  ${s('red', data.error)}`);
        }
      } catch {
        console.log(`  ${s('red', B.cross)}  ${s('red', 'Bridge not running.')}`);
      }
      return;
    }

    if (opts.switchModel) {
      try {
        const r = await fetch(`${base}/v1/switch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: opts.switchModel }),
        });
        const data = await r.json();
        if (data.ok) {
          console.log(`  ${s('green', B.check)}  ${s('white', 'Model switched to')} ${s('cyan', data.model)}`);
        } else {
          console.log(`  ${s('red', B.cross)}  ${s('red', data.error)}`);
        }
      } catch {
        console.log(`  ${s('red', B.cross)}  ${s('red', 'Bridge not running.')}`);
      }
      return;
    }
  }

  if (opts.wizard) {
    await runWizard();
  }

  /* ── Stats / cache / routing remote commands (talk to running bridge) ── */
  if (opts.stats || opts.statsReset || opts.cacheStats || opts.cacheClear ||
    opts.routingStatus || opts.fallbackStatus ||
    opts.enableRouting || opts.disableRouting ||
    opts.enableFallback || opts.disableFallback ||
    opts.enableCache || opts.disableCache) {

    const port = opts.port || Number(process.env.PORT || 8787);
    const base = `http://127.0.0.1:${port}`;

    if (opts.stats) {
      await printStats({ port });
      return;
    }

    try {
      if (opts.statsReset) {
        await fetch(`${base}/v1/stats/reset`, { method: 'POST' });
        console.log(`  ${s('green', B.check)}  ${s('white', 'Session stats reset')}`);
        return;
      }
      if (opts.cacheClear) {
        const r = await fetch(`${base}/v1/cache/clear`, { method: 'POST' });
        const d = await r.json();
        console.log(`  ${s('green', B.check)}  ${s('white', `Cache cleared: ${d.cleared} entries removed`)}`);
        return;
      }
      if (opts.cacheStats) {
        const r = await fetch(`${base}/v1/cache/stats`);
        const d = await r.json();
        nl();
        console.log(boxTop(s('bold', s('b6', ' Cache '))));
        console.log(boxEmpty());
        console.log(boxLine(`  ${s('gray', 'Status')}     ${d.enabled ? s('green', '● ON') : s('red', '● OFF')}`));
        console.log(boxLine(`  ${s('gray', 'Entries')}    ${s('white', `${d.entries}/${d.maxEntries}`)}`));
        console.log(boxLine(`  ${s('gray', 'Hit Rate')}   ${s('cyan', d.hitRate)}`));
        console.log(boxLine(`  ${s('gray', 'Hits')}       ${s('white', String(d.hits))}`));
        console.log(boxLine(`  ${s('gray', 'Misses')}     ${s('white', String(d.misses))}`));
        console.log(boxLine(`  ${s('gray', 'TTL')}        ${s('white', d.ttlFormatted)}`));
        console.log(boxEmpty());
        console.log(boxBottom());
        nl();
        return;
      }
      if (opts.enableRouting) {
        await fetch(`${base}/v1/routing/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
        console.log(`  ${s('green', B.check)}  ${s('white', 'Smart routing enabled')}`);
        return;
      }
      if (opts.disableRouting) {
        await fetch(`${base}/v1/routing/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
        console.log(`  ${s('green', B.check)}  ${s('white', 'Smart routing disabled')}`);
        return;
      }
      if (opts.enableFallback) {
        await fetch(`${base}/v1/fallback/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
        console.log(`  ${s('green', B.check)}  ${s('white', 'Fallback chains enabled')}`);
        return;
      }
      if (opts.disableFallback) {
        await fetch(`${base}/v1/fallback/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
        console.log(`  ${s('green', B.check)}  ${s('white', 'Fallback chains disabled')}`);
        return;
      }
      if (opts.enableCache) {
        await fetch(`${base}/v1/cache/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
        console.log(`  ${s('green', B.check)}  ${s('white', 'Response caching enabled')}`);
        return;
      }
      if (opts.disableCache) {
        await fetch(`${base}/v1/cache/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
        console.log(`  ${s('green', B.check)}  ${s('white', 'Response caching disabled')}`);
        return;
      }
      if (opts.routingStatus) {
        const r = await fetch(`${base}/v1/routing/status`);
        const d = await r.json();
        nl();
        console.log(boxTop(s('bold', s('b6', ' Routing '))));
        console.log(boxEmpty());
        console.log(boxLine(`  ${s('gray', 'Status')}     ${d.enabled ? s('green', '● ON') : s('red', '● OFF')}`));
        console.log(boxLine(`  ${s('gray', 'Routed')}     ${s('white', String(d.stats?.totalRouted || 0))}`));
        if (d.table) {
          console.log(boxEmpty());
          for (const row of d.table) {
            const statusIcon = row.active ? s('green', '●') : s('dgray', '○');
            console.log(boxLine(`  ${statusIcon}  ${s('white', row.type.padEnd(14))} ${s('gray', (row.prefer || []).join(', ') || '—')}`));
          }
        }
        console.log(boxEmpty());
        console.log(boxBottom());
        nl();
        return;
      }
      if (opts.fallbackStatus) {
        const r = await fetch(`${base}/v1/fallback/status`);
        const d = await r.json();
        nl();
        console.log(boxTop(s('bold', s('b6', ' Fallback '))));
        console.log(boxEmpty());
        console.log(boxLine(`  ${s('gray', 'Status')}      ${d.enabled ? s('green', '● ON') : s('red', '● OFF')}`));
        console.log(boxLine(`  ${s('gray', 'Retries')}     ${s('white', String(d.maxRetries))}`));
        console.log(boxLine(`  ${s('gray', 'Fallbacks')}   ${s('white', String(d.stats?.totalFallbacks || 0))}`));
        if (d.chain && d.chain.length) {
          console.log(boxEmpty());
          console.log(boxLine(s('bold', s('b6', 'Chain:'))));
          for (let i = 0; i < d.chain.length; i++) {
            const c = d.chain[i];
            const circuitIcon = c.circuit?.state === 'open' ? s('red', '●') : c.circuit?.state === 'half-open' ? s('yellow', '●') : s('green', '●');
            console.log(boxLine(`  ${s('dgray', `${i + 1}.`)} ${circuitIcon} ${s('white', c.label)}`));
          }
        }
        console.log(boxEmpty());
        console.log(boxBottom());
        nl();
        return;
      }
    } catch {
      console.log(`  ${s('red', B.cross)}  ${s('red', 'Bridge not running. Start with: claudebridge')}`);
      process.exit(1);
    }
    return;
  }

  /* ── Profile management ── */
  if (opts.saveProfile) {
    const cfg = loadConfigFromEnvFile();
    const profileData = profileMgr.fromConfig(opts.saveProfile, cfg);
    profileMgr.save(opts.saveProfile, profileData);
    console.log(`  ${s('green', B.check)}  ${s('white', `Profile '${opts.saveProfile}' saved`)}`);
    return;
  }

  if (opts.deleteProfile) {
    const deleted = profileMgr.delete(opts.deleteProfile);
    if (deleted) {
      console.log(`  ${s('green', B.check)}  ${s('white', `Profile '${opts.deleteProfile}' deleted`)}`);
    } else {
      console.log(`  ${s('red', B.cross)}  ${s('red', `Profile '${opts.deleteProfile}' not found (built-in profiles can't be deleted)`)}`);
    }
    return;
  }

  let cfg = loadConfigFromEnvFile();

  if (!cfg.exists && isTTY) {
    console.log(`  ${s('yellow', '⚠')}  ${s('yellow', 'No configuration found. Starting wizard...')}`);
    nl();
    await runWizard();
    cfg = loadConfigFromEnvFile();
  } else if (cfg.isGlobal && opts.verbose) {
    console.log(`  ${s('gray', 'ℹ')}  ${s('gray', `Using global config: ${cfg.path}`)}`);
  }

  cfg = applyOverrides(cfg, opts);

  // Apply profile if specified
  if (opts.profile) {
    const profile = profileMgr.get(opts.profile);
    if (!profile) {
      console.log(`  ${s('red', B.cross)}  ${s('red', `Profile '${opts.profile}' not found. Use --list-profiles.`)}`);
      process.exit(1);
      return;
    }
    const profileCfg = profileMgr.toConfig(profile, cfg.apiKey);
    if (profileCfg.baseUrl) cfg.baseUrl = profileCfg.baseUrl;
    if (profileCfg.chatPath) cfg.chatPath = profileCfg.chatPath;
    if (profileCfg.model) cfg.model = profileCfg.model;
    if (profileCfg.port) cfg.port = profileCfg.port;
    // Set feature flags from profile
    if (profile.routing) opts.enableRouting = true;
    if (profile.fallbackChain && profile.fallbackChain.length) {
      opts.enableFallback = true;
      opts.fallbackChain = profile.fallbackChain.join(',');
    }
    if (profile.budgetLimit != null) opts.budget = profile.budgetLimit;
    profileMgr.setActive(opts.profile);
  }

  printRuntimeDashboard(cfg, opts);
  nl();

  if (!cfg.apiKey || !cfg.baseUrl || !cfg.chatPath || !cfg.model) {
    console.log(`  ${s('red', B.cross)}  ${s('red', 'Missing required config. Run:')} ${s('bold', s('b5', 'claudebridge --wizard'))}`);
    process.exit(1);
    return;
  }

  if (!Number.isFinite(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    console.log(`  ${s('red', B.cross)}  ${s('red', 'Invalid port. Use --port <1..65535>')}`);
    process.exit(1);
    return;
  }

  saveConfig(cfg, opts);

  if (opts.listModels) {
    const m = await listModels(cfg);
    if (!m.ok) {
      console.log(`  ${s('red', B.cross)}  ${s('red', 'Could not retrieve models.')}`);
      process.exit(1);
      return;
    }
    nl();
    console.log(boxTop(s('bold', s('b6', ` ${m.models.length} Models `))));
    console.log(boxEmpty());
    for (const id of m.models) {
      const isCurrent = id === cfg.model;
      const tag = isCurrent ? s('green', ' ← active') : '';
      console.log(boxLine(`  ${s('b5', B.bullet)}  ${s('white', id)}${tag}`));
    }
    console.log(boxEmpty());
    console.log(boxBottom());
    nl();
    return;
  }

  if (opts.doctor) {
    await runDoctor(cfg);
    return;
  }

  await runLaunch(cfg, opts);
}

main().catch(err => {
  console.log(`  ${s('red', B.cross)}  ${s('red', err.message)}`);
  process.exit(1);
});
