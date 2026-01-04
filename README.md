# RLM Cloudflare Sandbox

Cloudflare Worker that provides a sandbox environment for [RLM (Recursive Language Models)](https://github.com/alexzhang13/rlm).

## Overview

This Worker implements the RLM sandbox API contract, allowing Python code execution in isolated Cloudflare Sandbox containers with LLM callback support.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/session` | POST | Create/get a sandbox session |
| `/execute` | POST | Execute Python code |
| `/context` | POST | Load context data into sandbox |
| `/pending` | GET | Get pending LLM requests |
| `/respond` | POST | Submit LLM response |
| `/session` | DELETE | Cleanup sandbox session |

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run locally:
   ```bash
   npm run dev
   ```

3. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

## Usage with RLM

```python
from rlm import RLM

rlm = RLM(
    backend="openai",
    backend_kwargs={"model_name": "gpt-4"},
    environment="cloudflare",
    environment_kwargs={
        "worker_url": "https://rlm-sandbox.your-account.workers.dev",
    },
)

result = rlm.completion("Calculate 2+2 using Python")
```

## API Details

### POST /session
```json
// Request
{ "session_id": "optional-custom-id" }

// Response
{ "session_id": "abc123", "status": "ready" }
```

### POST /execute
```json
// Request
{ "session_id": "abc123", "code": "print('hello')" }

// Response
{
  "stdout": "hello\n",
  "stderr": "",
  "locals": { "x": "1" },
  "execution_time": 0.05
}
```

### POST /context
```json
// Request
{ "session_id": "abc123", "context": "your context data" }

// Response
{ "status": "ok" }
```

### GET /pending?session_id=abc123
```json
// Response
{
  "pending": [
    {
      "id": "req1",
      "request": { "type": "single", "prompt": "...", "model": null }
    }
  ]
}
```

### POST /respond
```json
// Request
{
  "session_id": "abc123",
  "id": "req1",
  "response": { "response": "LLM response here" }
}

// Response
{ "status": "ok" }
```

### DELETE /session
```json
// Request
{ "session_id": "abc123" }

// Response
{ "status": "deleted" }
```

## Architecture

```
Python (CloudflareREPL)              This Worker
├── Creates session         ──────►  POST /session
├── Sends code to execute   ──────►  POST /execute
│                                    │
│   ┌────────────────────────────────┘
│   │  Sandbox Container
│   │  ├── Executes Python code
│   │  ├── llm_query() calls enqueue to /internal/enqueue
│   │  └── Polls /internal/result for response
│   │
├── Polls for LLM requests  ──────►  GET /pending
├── Handles LLM via handler
└── Posts LLM responses     ──────►  POST /respond
```

## Development

The Worker uses in-memory storage for the LLM request queue. In production, consider using Durable Object storage for persistence.

## License

MIT
