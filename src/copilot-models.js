const { loadToken, getChatToken } = require('./copilot');

async function fetchCopilotModels(chatToken) {
    try {
        const res = await fetch('https://api.githubcopilot.com/models', {
            headers: {
                'Authorization': `Bearer ${chatToken}`,
                'Accept': 'application/json',
                'User-Agent': 'GitHubCopilot/1.155.0',
                'Copilot-Integration-Id': 'vscode-chat'
            }
        });

        if (!res.ok) return null;

        const data = await res.json();
        if (!data || !Array.isArray(data.data)) return null;

        // Map to simple format and filter for chat models if possible
        // The debug output showed "id" fields are likely present in the objects
        return data.data.map(m => ({
            id: m.id,
            name: m.name || m.id,
            capabilities: m.capabilities
        })).filter(m => !m.id.includes('embedding')); // Basic filtering
    } catch (e) {
        return null;
    }
}

const STATIC_MODELS = [
    { id: 'gpt-4o', name: 'GPT-4o (Default)' },
    { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
    { id: 'o1-preview', name: 'o1 Preview' },
    { id: 'o1-mini', name: 'o1 Mini' }
];

module.exports = { fetchCopilotModels, STATIC_MODELS };
