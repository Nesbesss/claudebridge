const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const TOKEN_PATH = path.join(os.homedir(), '.claudebridge', 'claude-web-session.json');

// ─── Session storage ────────────────────────────────────────────────────────

function saveSession(data) {
    const dir = path.dirname(TOKEN_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function loadSession() {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    } catch {
        return null;
    }
}

// ─── curl-impersonate detection ─────────────────────────────────────────────

const CURL_IMPERSONATE_CANDIDATES = [
    'curl_chrome131',
    'curl_chrome124',
    'curl_chrome116',
    'curl_chrome110',
    'curl-impersonate-chrome',
    'curl-impersonate',
];

let _curlBin = null;

function findCurlImpersonate() {
    if (_curlBin !== null) return _curlBin;
    for (const bin of CURL_IMPERSONATE_CANDIDATES) {
        try {
            execFileSync('which', [bin], { stdio: 'pipe' });
            _curlBin = bin;
            return bin;
        } catch { }
    }
    _curlBin = false;
    return false;
}

// ─── Headers ────────────────────────────────────────────────────────────────

function extractSessionCookies(cookieStr) {
    const keep = ['sessionKey', 'anthropic-device-id', 'lastActiveOrg', '__ssid', 'routingHint'];
    return cookieStr
        .split(';')
        .map(p => p.trim())
        .filter(p => keep.some(k => p.startsWith(k + '=')))
        .join('; ');
}

function buildHeaders(cookie) {
    return {
        'Cookie': extractSessionCookies(cookie),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Referer': 'https://claude.ai/new',
        'Origin': 'https://claude.ai',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'anthropic-client-platform': 'web_claude_ai',
        'anthropic-client-version': '2024-12-20',
    };
}

// ─── API calls ───────────────────────────────────────────────────────────────

async function getOrgId(cookie) {
    const session = loadSession();
    if (session && session.orgId) return session.orgId;

    const res = await fetch('https://claude.ai/api/organizations', {
        headers: buildHeaders(cookie),
    });
    if (!res.ok) throw new Error(`Failed to get org: ${res.status} ${res.statusText}`);
    const orgs = await res.json();
    if (!Array.isArray(orgs) || orgs.length === 0) throw new Error('No organizations found');
    const orgId = orgs[0].uuid;

    const existing = loadSession() || {};
    saveSession({ ...existing, orgId });
    return orgId;
}

async function createConversation(cookie, orgId) {
    const uuid = randomUUID();
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
        method: 'POST',
        headers: buildHeaders(cookie),
        body: JSON.stringify({ name: '', uuid }),
    });
    if (!res.ok) throw new Error(`Failed to create conversation: ${res.status}`);
    const data = await res.json();
    return data.uuid;
}

/**
 * Sends a message using curl-impersonate and returns a streaming response.
 * This fixes the previous bottleneck where we waited for the entire response.
 */
function sendMessageWithCurl(bin, cookie, orgId, conversationId, messages, model) {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    const rawPrompt = lastUserMsg
        ? (typeof lastUserMsg.content === 'string'
            ? lastUserMsg.content
            : lastUserMsg.content.map(c => c.text || '').join(''))
        : '';

    const systemMsg = messages.find(m => m.role === 'system');
    const fullPrompt = systemMsg
        ? `${typeof systemMsg.content === 'string' ? systemMsg.content : systemMsg.content.map(c => c.text || '').join('')}\n\n${rawPrompt}`
        : rawPrompt;

    const bodyJson = JSON.stringify({
        prompt: fullPrompt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Amsterdam',
        model: model || 'claude-sonnet-4-5',
        attachments: [],
        files: [],
        sync_sources: [],
        rendering_mode: 'raw',
        request_id: randomUUID(),
    });

    const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}/completion`;
    const headers = buildHeaders(cookie);

    // Use temporary file for body to avoid shell escaping issues with large prompts
    const tmpBody = path.join(os.tmpdir(), `cb-body-${Date.now()}-${randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(tmpBody, bodyJson);

    const args = [
        '--silent',
        '--location',
        '-X', 'POST',
        '-H', 'Accept: text/event-stream',
    ];

    for (const [k, v] of Object.entries(headers)) {
        args.push('-H', `${k}: ${v}`);
    }

    args.push('--data-binary', `@${tmpBody}`);
    args.push(url);

    const proc = spawn(bin, args);

    // Clean up temp file when process exits
    proc.on('exit', () => {
        try {
            if (fs.existsSync(tmpBody)) fs.unlinkSync(tmpBody);
        } catch { }
    });

    // Return a web Response object containing the process's stdout stream
    // We use Readable.toWeb to convert the Node stream to a Web Stream
    return new Response(Readable.toWeb(proc.stdout), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

// ─── Main entry point ────────────────────────────────────────────────────────

async function claudeWebRequest(messages, model) {
    const session = loadSession();
    if (!session || !session.cookie) {
        throw new Error('No claude.ai session found. Run claudebridge --wizard to set up.');
    }

    const { cookie } = session;
    const curlBin = findCurlImpersonate();
    if (!curlBin) {
        throw new Error(
            'curl-impersonate is required for the Claude.ai web provider.\n\n' +
            'Install it with:\n' +
            '  brew tap shakacode/brew\n' +
            '  brew install curl-impersonate\n\n' +
            'Then restart claudebridge.'
        );
    }

    const orgId = await getOrgId(cookie);
    const conversationId = await createConversation(cookie, orgId);
    return sendMessageWithCurl(curlBin, cookie, orgId, conversationId, messages, model);
}

module.exports = { claudeWebRequest, saveSession, loadSession, getOrgId };
