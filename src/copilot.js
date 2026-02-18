const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const COPILOT_CLIENT_ID = 'Iv1.b507a08c87ecfe98'; // Official GitHub CLI Client ID
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const USER_CODE_POLL_INTERVAL = 5500; // 5.5s

const CONFIG_DIR = path.join(os.homedir(), '.claudebridge');
const TOKEN_FILE = path.join(CONFIG_DIR, 'copilot-token.json');

// Ensure config dir exists
if (!fs.existsSync(CONFIG_DIR)) {
    try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch { }
}

async function requestDeviceCode() {
    const res = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: 'copilot' })
    });
    if (!res.ok) throw new Error(`Failed to get device code: ${res.statusText}`);
    return res.json();
}

async function pollForToken(deviceCode, interval) {
    while (true) {
        await new Promise(r => setTimeout(r, interval * 1000));
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({
                client_id: COPILOT_CLIENT_ID,
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
            })
        });
        const data = await res.json();
        if (data.access_token) return data;
        if (data.error === 'authorization_pending') continue;
        if (data.error === 'slow_down') { interval += 5; continue; }
        if (data.error) throw new Error(`Auth failed: ${data.error_description || data.error}`);
    }
}

function saveToken(tokenData) {
    try {
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
    } catch (e) {
        console.error('Failed to save Copilot token:', e.message);
    }
}

function loadToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) return null;
        return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    } catch { return null; }
}

async function getCachedCopilotToken() {
    const data = loadToken();
    if (!data || !data.access_token) return null;
    // Copilot tokens last 30m, but the OAuth token is long-lived.
    // We actually need to exchange the OAuth token for a Copilot-specific token (another step).
    // But wait! Users usually just use the OAuth token directly with the Copilot API endpoint?
    // Correct flow: OAuth Token -> GET /copilot_internal/v2/token -> Real Token for Chat API.
    return data.access_token; // Return OAuth token
}

async function getChatToken(oauthToken) {
    // Exchange OAuth token for temporary Copilot chat token
    const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
        headers: {
            'Authorization': `token ${oauthToken}`,
            'User-Agent': 'GitHubCopilot/1.155.0', // Emulate VS Code extension
            'Accept': 'application/json'
        }
    });
    if (!res.ok) throw new Error(`Failed to get Copilot chat token: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return data.token; // This is the 'tid=...' token
}

module.exports = {
    requestDeviceCode,
    pollForToken,
    saveToken,
    loadToken,
    getCachedCopilotToken,
    getChatToken
};
