
```text
   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗
  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝
  ██║     ██║     ███████║██║   ██║██║  ██║█████╗  
  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  
  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗
   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝
  ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗
  ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝
  ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  
  ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  
  ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗
  ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝
```
<div align="center">
  <p><strong>Universal Bridge for Claude Code</strong></p>
  <p>Any model. Any provider. One command. Zero config.</p>
</div>

---

**claudebridge** allows you to use Claude Code with any OpenAI-compatible provider. It features smart routing, cost tracking, fallback chains, and live model switching via `$$` commands.

## Features

- **Zero-Config Setup**: Automatic wizard guides you through provider selection.
- **Live Switching**: Switch models instantly without restarting via `$$` commands.
- **Smart Routing**: Automatically detects task types (coding, reasoning, creative) and routes to the best model.
- **Cost Tracking**: Real-time session cost and token usage monitoring.
- **Fallback Chains**: Automatic failover to backup providers if the primary one fails.
- **Response Caching**: Caches identical requests to save costs and reduce latency.
- **Cross-Platform**: Full support for macOS, Linux, and Windows.

## Installation

Install globally using npm:

```bash
npm install -g @nesbes/claudebridge
```

Or run directly with npx:

```bash
npx @nesbes/claudebridge
```

*Note: Requires Node.js 18 or higher.*

## Quick Start

1. **Setup**: Run the interactive wizard to configure your provider.
   ```bash
   claudebridge --wizard
   ```

2. **Launch**: Start the bridge.
   ```bash
   claudebridge
   ```

3. **Use**: Inside Claude Code, use `$$` commands to control the bridge.
   ```text
   $$groq          # Switch to Groq
   $$deepseek      # Switch to DeepSeek
   $$cost          # View session costs
   $$status        # View bridge status
   ```

## Advanced Usage

### Live Model Switching

Switch models on the fly directly from the Claude Code interface:

| Command | Description |
|---------|-------------|
| `$$groq` | Switch to Groq (fast inference) |
| `$$ollama` | Switch to local Ollama instance |
| `$$deepseek` | Switch to DeepSeek |
| `$$openrouter` | Switch to OpenRouter |
| `$$model:gpt-4o` | Change specific model ID |
| `$$status` | Show full status dashboard |
| `$$cost` | Show detailed cost breakdown |
| `$$help` | List all available commands |

### Smart Auto-Routing

Enable smart routing to automatically direct specialized tasks to the most appropriate model:

```bash
claudebridge --enable-routing
```

| Task Type | Detected Keywords | routed To |
|-----------|-------------------|-----------|
| **Thinking** | math, logic, reasoning | DeepSeek Reasoner |
| **Coding** | code, debug, refactor | DeepSeek, Fireworks |
| **Quick** | short questions | Groq, Cerebras |
| **Creative** | writing, brainstorming | OpenAI, Mistral |
| **Context** | large files, summaries | DeepInfra, Together |

### Fallback Chains

Configure a chain of providers to ensure reliability. If the primary provider fails, the bridge automatically retries with the next in line.

```bash
claudebridge --enable-fallback --fallback-chain groq,deepseek,openai
```

### Local Models

Easily connect to local inference servers:

- **Ollama**: `$$ollama` (port 11434)
- **LM Studio**: `$$lmstudio` (port 1234)
- **Jan**: `$$jan` (port 1337)
- **vLLM**: `$$vllm` (port 8000)

## CLI Reference

```text
Usage: claudebridge [options]

Options:
  --wizard                Run interactive setup wizard
  --doctor                Run diagnostics
  --profile <name>        Use a saved profile preset
  --stats                 Show session statistics
  --no-claude             Run in bridge-only mode
  --verbose               Enable verbose logging
  --help                  Show help
```

## Security

- API keys are stored with restricted permissions (`chmod 600`).
- Keys can be read from environment variables (`--api-key-env`).
- Bridge logs are hidden by default.
- Configuration files exclude sensitive data.

## License

MIT
