#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const os = require('node:os');
const { stdin, stdout } = require('node:process');
const { spawnSync } = require('node:child_process');
const { PROVIDERS } = require('./providers');
const { requestDeviceCode, pollForToken, saveToken, getChatToken } = require('./copilot');
const { fetchCopilotModels, STATIC_MODELS } = require('./copilot-models');
const { saveSession: saveClaudeWebSession, getOrgId } = require('./claude-web');

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
  const full = W + 2;
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

function clearLines(n = 1) {
  if (isTTY) {
    for (let i = 0; i < n; i++) {
      stdout.write('\x1b[1A\x1b[2K'); // Up and Clear
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
   WIZARD STATE & HELPERS
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

function providerIcon(id) {
  const map = {
    'openai': '🟢', 'openrouter': '🧩', 'opencode': '🔷', 'groq': '⚡',
    'together': '🤝', 'fireworks': '🎆', 'mistral': '🌪️', 'xai': '✴️',
    'deepinfra': '🔥', 'perplexity': '🧭', 'nvidia': '💚', 'cerebras': '🧠',
    'sambanova': '🟠', 'anyscale': '📐', 'deepseek': '🔍', 'moonshot': '🌙',
    '01ai': '🔢', 'hyperbolic': '🌀', 'novita': '✨', 'siliconflow': '🌊',
    'inference': '📡', 'friendli': '🫱', 'ollama': '🦙', 'lmstudio': '🖥️',
    'jan': '🤖', 'llamacpp': '🔧', 'vllm': '⚡', 'custom': '🛠️', 'modal': '🧱',
    'github-copilot': '🐙',
  };
  for (const [key, icon] of Object.entries(map)) {
    if (id.includes(key)) return icon;
  }
  return '🔹';
}

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
  console.log(`${' '.repeat(6)}${s('dgray', 'v2.0.13  |  npx claudebridge')}`);
  nl();
}

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
   STEP HANDLERS
   ══════════════════════════════════════════════════════════════════ */

async function step1_Provider(state, rl) {
  nl();
  progressBar(1, 5);
  stepHeader(1, 'Choose your AI provider', 'Select from pre-configured providers or bring your own');

  printProviderList();
  nl();

  while (true) {
    const pickRaw = await rl.question(promptDef('Provider number', '1'));
    const pickStr = pickRaw.trim().toLowerCase();

    // Back checking doesn't really apply to step 1 (except to quit), but for consistency:
    if (pickStr === 'b' || pickStr === 'back') return -1; // -1 to signal quit? Or ignore.

    const pick = Number.parseInt(pickStr, 10);
    const selected = PROVIDERS[(Number.isFinite(pick) ? pick : 1) - 1] || PROVIDERS[0];

    // Clear the prompt line to keep it clean if we re-render (not doing full re-render here mostly)
    // But for success, we just proceed.

    ok(`Selected ${s('bold', selected.label)} ${providerIcon(selected.id)}`);

    state.selectedProvider = selected;
    state.baseUrl = selected.baseUrl;
    state.chatPath = selected.chatPath;
    state.model = selected.model;

    // Handle custom endpoints
    if (selected.requiresEndpointInput) {
      let validEndpoint = false;
      while (!validEndpoint) {
        nl();
        const ep = await rl.question(promptStr('Full chat-completions URL'));
        if (ep.trim().toLowerCase() === 'b') {
          // User wants to go back to provider list.
          // We need to clear lines? or just restart step 1?
          // Returning 1 re-runs step 1.
          return 1;
        }
        try {
          const parsed = parseEndpoint(ep.trim());
          state.baseUrl = parsed.baseUrl;
          state.chatPath = parsed.chatPath;
          state.model = 'gpt-4o-mini';
          validEndpoint = true;
        } catch (e) {
          fail(e.message);
        }
      }
    } else {
      // Optional override
      nl();
      info(`Current endpoint: ${s('b6', `${state.baseUrl}${state.chatPath}`)}`);
      const epOverride = await rl.question(promptStr('Override endpoint?', 'Enter to keep'));
      if (epOverride.trim().toLowerCase() === 'b') {
        return 1;
      }
      if (epOverride.trim()) {
        try {
          const parsed = parseEndpoint(epOverride.trim());
          state.baseUrl = parsed.baseUrl;
          state.chatPath = parsed.chatPath;
          ok(`Endpoint → ${s('b6', `${state.baseUrl}${state.chatPath}`)}`);
        } catch (e) {
          fail('Invalid endpoint format. Keeping default.');
        }
      }
    }

    return 2; // Go to step 2
  }
}

async function step2_Auth(state, rl) {
  nl();
  progressBar(2, 5);
  stepHeader(2, 'Authentication', 'Enter your API key for the selected provider');

  // Back support
  console.log(boxLine(s('dgray', "Type 'b' or 'back' to return to the previous step.")));
  nl();

  if (state.selectedProvider.id === 'github-copilot') {
    // Copilot logic
    nl();
    console.log(boxLine(s('cyan', 'GitHub Copilot Setup')));
    console.log(boxLine('1. Requesting device code from GitHub...'));

    // ... logic for copilot ...
    // Note: Copilot flow is complex to back out of once started, but we can try catch.
    try {
      const codeData = await requestDeviceCode();
      nl();
      console.log(boxLine(s('bold', `Code: ${s('b5', codeData.user_code)}`)));
      console.log(boxLine(`Open: ${s('blue', codeData.verification_uri)}`));
      nl();

      // Try open
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      try { require('node:child_process').spawn(openCmd, [codeData.verification_uri], { shell: process.platform === 'win32' }); } catch { }

      // Polling spinner
      // We can't easily wait for user input 'b' during polling without rewriting polling to be cancellable or racing.
      // For now, let's just let it run. Ctrl+C to abort is standard.
      // But we should ask if they want to cancel? No, polling is auto.

      // ... poll ...
      const tokenData = await pollForToken(codeData.device_code, codeData.interval);
      // ... success ...
      saveToken(tokenData);

      // Get chat token
      const chatToken = await getChatToken(tokenData.access_token);
      console.log(boxLine(s('green', '✓ Copilot access verified.')));

      // Model discovery
      console.log(boxLine('Discovering included models...'));
      const liveModels = await fetchCopilotModels(chatToken);
      const modelsToUse = liveModels && liveModels.length ? liveModels : STATIC_MODELS;

      if (liveModels && liveModels.length) {
        console.log(boxLine(s('green', `✓ Found ${liveModels.length} models available`)));
      }

      nl();
      console.log(boxLine(s('cyan', 'Select a Model:')));
      modelsToUse.forEach((m, i) => {
        console.log(boxLine(` ${s('bold', i + 1)}) ${s('white', m.id)}`));
      });
      nl();

      const mIdxRaw = await rl.question(promptStr(`Model number (default: 1)`));
      if (mIdxRaw.trim() === 'b') return 1;

      const mIdx = parseInt(mIdxRaw.trim() || '1') - 1;
      const selectedModel = modelsToUse[mIdx] || modelsToUse[0];
      state.model = selectedModel.id;

      state.apiKey = 'github-copilot';
      return 3;

    } catch (e) {
      fail(`Auth failed: ${e.message}`);
      const retry = await rl.question(promptStr('Retry?', 'Y/n'));
      if (askYesNo(retry)) return 2;
      return 1;
    }

  } else if (state.selectedProvider.id === 'claude-web') {
    // Claude.ai Web Session auth
    nl();
    console.log(boxLine(s('cyan', 'Claude.ai Web Session Setup')));
    console.log(boxLine('To use Claude.ai for free, we need your browser session cookie.'));
    nl();
    console.log(boxLine(s('bold', 'How to get your cookie:')));
    console.log(boxLine('1. Open claude.ai in Chrome/Firefox'));
    console.log(boxLine('2. Press F12 → Network tab'));
    console.log(boxLine('3. Click any request to claude.ai'));
    console.log(boxLine('4. Find "Cookie" in request headers'));
    console.log(boxLine('5. Copy the entire value'));
    nl();

    while (true) {
      const cookieRaw = await rl.question(promptStr('Paste your cookie string'));
      const input = cookieRaw.trim();

      if (input === 'b' || input === 'back') return 1;
      if (!input) { fail('Cookie is required.'); continue; }

      // Validate by fetching org ID
      info('Verifying session...');
      try {
        saveClaudeWebSession({ cookie: input });
        const orgId = await getOrgId(input);
        saveClaudeWebSession({ cookie: input, orgId });
        ok(`Session verified! Org ID: ${s('cyan', orgId)}`);

        // Fetch available models from the model_configs endpoint
        const modelRes = await fetch(`https://claude.ai/api/organizations/${orgId}/model_configs/claude-sonnet-4-6`, {
          headers: {
            'Cookie': input,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/json',
          }
        });

        // Offer known claude.ai models
        const claudeWebModels = [
          { id: 'claude-opus-4-5', name: 'Claude Opus 4.5 (Best)' },
          { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Fast)' },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (Fastest)' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Latest)' },
        ];

        nl();
        console.log(boxLine(s('cyan', 'Select a Model:')));
        claudeWebModels.forEach((m, i) => {
          console.log(boxLine(` ${s('bold', i + 1)}) ${s('white', m.id)} ${s('gray', `(${m.name})`)}`))
        });
        nl();

        const mIdxRaw = await rl.question(promptStr('Model number (default: 2)'));
        if (mIdxRaw.trim() === 'b') return 1;
        const mIdx = parseInt(mIdxRaw.trim() || '2') - 1;
        const selectedModel = claudeWebModels[mIdx] || claudeWebModels[1];
        state.model = selectedModel.id;
        state.apiKey = 'claude-web';
        return 3;

      } catch (e) {
        fail(`Session verification failed: ${e.message}`);
        fail('Make sure you copied the full cookie string from DevTools.');
      }
    }

  } else {
    // Normal providers
    const provider = state.selectedProvider;

    // Display signup link if available
    if (provider.apiKeyUrl) {
      console.log(boxLine(s('gray', `Don't have a key? Get one here:`)));
      console.log(boxLine(s('b5', provider.apiKeyUrl)));
      nl();
    }

    while (true) {
      const promptText = provider.requiresApiKey === false
        ? 'API key (optional)'
        : 'API key';

      const apiKeyRaw = await rl.question(promptStr(promptText));
      const input = apiKeyRaw.trim();

      if (input === 'b' || input === 'back') {
        return 1; // Back to provider
      }

      if (!input && provider.requiresApiKey !== false) {
        clearLines(1); // clear the empty input line
        fail('API key is required for this provider.');
        continue;
      }

      state.apiKey = input.replace(/^Bearer\s+/i, '');
      ok('API key received');
      return 3;
    }
  }
}

async function step3_Model(state, rl) {
  nl();
  progressBar(3, 5);
  stepHeader(3, 'Select a model', 'Auto-discovering models from your provider...');
  console.log(boxLine(s('dgray', "Type 'b' or 'back' to return to authentication.")));

  const discovery = await withSpinner('Discovering models', () =>
    discoverModels({ baseUrl: state.baseUrl, chatPath: state.chatPath, apiKey: state.apiKey })
  );

  if (discovery.ok) {
    const models = discovery.models;
    const PAGE = 20;
    let page = 0;
    const totalPages = Math.ceil(models.length / PAGE);

    // render loop
    while (true) {
      const start = page * PAGE;
      const end = Math.min(start + PAGE, models.length);

      // Render list
      nl();
      const pageLabel = totalPages > 1 ? ` (page ${page + 1}/${totalPages})` : '';
      console.log(boxTop(s('bold', s('b6', ` ${models.length} Models Available${pageLabel} `))));
      for (let i = start; i < end; i++) {
        const num = s('b5', String(i + 1).padStart(3));
        const name = s('white', models[i]);
        const tag = models[i] === state.model ? s('green', ' ← default') : '';
        console.log(boxLine(`  ${num}  ${name}${tag}`));
      }
      console.log(boxEmpty());

      const hints = [];
      if (page < totalPages - 1) hints.push(s('b5', 'n') + s('gray', '=next'));
      if (page > 0) hints.push(s('b5', 'p') + s('gray', '=prev'));
      hints.push(s('b5', 'b') + s('gray', '=back'));
      console.log(boxLine(`  ${hints.join('  ')}`));
      console.log(boxBottom());

      nl();
      const answer = await rl.question(promptDef('Model (# / n / p)', state.model));
      const input = answer.trim().toLowerCase();

      if (input === 'b' || input === 'back') return 2;

      if (input === 'n' && page < totalPages - 1) {
        page++;
        continue;
      }
      if (input === 'p' && page > 0) {
        page--;
        continue;
      }

      const pn = parseInt(input, 10);
      if (Number.isFinite(pn) && pn >= 1 && pn <= models.length) {
        state.model = models[pn - 1];
        break;
      } else if (input) {
        state.model = input;
        break;
      } else {
        // Default kept
        break;
      }
    }
  } else {
    warn('Could not auto-discover models. Enter model ID manually.');
    const answer = await rl.question(promptDef('Model ID', state.model));
    const input = answer.trim();
    if (input === 'b' || input === 'back') return 2;
    if (input) state.model = input;
  }

  ok(`Using model ${s('cyan', state.model)}`);
  return 4;
}

async function step4_Bridge(state, rl) {
  nl();
  progressBar(4, 5);
  stepHeader(4, 'Bridge configuration', 'Configure the local Anthropic-compatible proxy');
  console.log(boxLine(s('dgray', "Type 'b' or 'back' to return to model selection.")));

  while (true) {
    const portIn = await rl.question(promptDef('Local port', '8787'));
    const input = portIn.trim();

    if (input === 'b' || input === 'back') return 3;

    const port = input ? parseInt(input, 10) : 8787;
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      fail('Port must be 1-65535.');
      continue;
    }

    state.port = port;
    ok(`Bridge will run on port ${s('b5', String(port))}`);

    // Save Config Logic
    const config = {
      baseUrl: state.baseUrl,
      chatPath: state.chatPath,
      apiKey: state.apiKey,
      model: state.model,
      port: state.port
    };

    const localEnvPath = path.join(ROOT, '.env');
    const envPath = fs.existsSync(localEnvPath) ? localEnvPath : GLOBAL_CONFIG_PATH;

    if (fs.existsSync(envPath)) {
      fs.copyFileSync(envPath, `${envPath}.backup`);
      info(`Backed up existing config → ${path.basename(envPath)}.backup`);
    }
    fs.writeFileSync(envPath, buildEnvText(config), 'utf8');
    try { fs.chmodSync(envPath, 0o600); } catch { }
    ok(`Wrote ${s('gray', path.basename(envPath))}`);

    const cePath = envPath === GLOBAL_CONFIG_PATH ? path.join(os.homedir(), '.claudebridge-env.sh') : path.join(ROOT, 'claude-env.sh');
    fs.writeFileSync(cePath, buildClaudeEnvText(port), 'utf8');
    try { fs.chmodSync(cePath, 0o600); } catch { }
    ok(`Wrote ${s('gray', path.basename(cePath))}`);

    try {
      installClaudeCodeSettings(port);
      ok(`Configured Claude Code globally ${s('gray', '(~/.claude/settings.json)')}`);
    } catch (e) {
      info(`Could not write Claude Code settings: ${e.message}`);
    }

    return 5;
  }
}

async function step5_Test(state, rl) {
  nl();
  progressBar(5, 5);
  stepHeader(5, 'Provider smoke test', 'Verify connectivity to your provider');
  console.log(boxLine(s('dgray', "Type 'b' or 'back' to return to config.")));

  const answer = await rl.question(promptStr('Run a quick test?', 'Y/n'));
  if (answer.trim() === 'b' || answer.trim() === 'back') return 4;

  if (askYesNo(answer, true)) {
    const config = {
      baseUrl: state.baseUrl,
      chatPath: state.chatPath,
      apiKey: state.apiKey,
      model: state.model,
      port: state.port
    };
    const result = await withSpinner('Testing provider endpoint', () =>
      new Promise(resolve => resolve(runCurlProviderTest(config)))
    );
    if (result.ok) ok(result.output);
    else fail(`Test failed: ${result.output}`);
  } else {
    info('Skipped connectivity test');
  }

  return 6; // Finish
}


/* ══════════════════════════════════════════════════════════════════
   MAIN LOOP & HELPERS
   ══════════════════════════════════════════════════════════════════ */

function parseEndpoint(endpoint) {
  if (!endpoint) throw new Error('Endpoint URL is required.');
  const parsed = new URL(endpoint);
  let chatPath = (parsed.pathname || '/v1/chat/completions').replace(/\/$/, '');
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

function installClaudeCodeSettings(port) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
  } catch { /* ok */ }

  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch { settings = {}; }

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


async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  printHero();

  console.log(boxTop(s('bold', s('b6', ' Setup Wizard '))));
  console.log(boxLine(s('gray', 'Interactive setup — configure your AI provider.')));
  console.log(boxLine(s('dgray', 'Press Enter for defaults. Type \'b\' to go back.')));
  console.log(boxBottom());

  const state = {
    // Shared state across steps
    selectedProvider: null,
    baseUrl: '',
    chatPath: '',
    model: '',
    apiKey: '',
    port: 8787
  };

  const steps = [
    null,
    step1_Provider,
    step2_Auth,
    step3_Model,
    step4_Bridge,
    step5_Test
  ];

  let currentStep = 1;

  try {
    while (currentStep > 0 && currentStep < steps.length) {
      const stepFn = steps[currentStep];
      // Each step returns the index of the next step
      // e.g., step 1 returns 2 on success, or stays 1 on retry?
      // or -1 to exit?
      const nextStep = await stepFn(state, rl);

      if (nextStep === -1) {
        console.log('Aborted.');
        process.exit(0);
      }
      currentStep = nextStep;
    }

    // Done
    if (currentStep === 6) {
      nl();
      summaryCard(state);
      nl();
      launchCard(state.port);
      nl();
      console.log(`  ${s('green', B.spark)}  ${s('bold', s('white', 'Setup complete!'))} ${s('gray', 'Run')} ${s('bold', s('b5', 'claudebridge'))} ${s('gray', 'to start.')}`);
      nl();
    }

  } catch (err) {
    fail(`Wizard error: ${err.message}`);
    process.exit(1);
  } finally {
    rl.close();
  }
}

module.exports = { installClaudeCodeSettings, uninstallClaudeCodeSettings };

if (require.main === module) main();
