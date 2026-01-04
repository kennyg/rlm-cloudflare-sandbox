# RLM Cloudflare Sandbox

Cloudflare Worker that provides isolated Python execution environments for [RLM (Recursive Language Models)](https://github.com/alexzhang13/rlm).

## Features

- **Isolated Python Execution** - Run Python code in secure Cloudflare Sandbox containers
- **State Persistence** - Variables persist between executions within a session
- **LLM Callbacks** - `llm_query()` and `llm_query_batched()` functions available in sandbox code
- **FINAL_VAR Helper** - Extract variable values by name
- **API Key Authentication** - Optional bearer token auth for production

## Requirements

- Node.js 18+
- [Cloudflare account](https://dash.cloudflare.com/sign-up) with Workers Paid plan (for Containers)
- Docker or OrbStack (for local development)

## Local Development

```bash
# Install dependencies
npm install

# Start local dev server (requires Docker running)
npm run dev
```

The worker will be available at `http://localhost:8787`.

### Test with curl

```bash
# Health check
curl http://localhost:8787/health

# Create session and execute code
curl -X POST http://localhost:8787/execute \
  -H "Content-Type: application/json" \
  -d '{"session_id": "test", "code": "x = 42\nprint(x)"}'

# Variables persist across executions
curl -X POST http://localhost:8787/execute \
  -H "Content-Type: application/json" \
  -d '{"session_id": "test", "code": "print(x * 2)"}'
```

## Deployment

```bash
# Login to Cloudflare
npx wrangler login

# Deploy
npx wrangler deploy

# Set API key for authentication (recommended for production)
npx wrangler secret put API_KEY
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (no auth required) |
| POST | `/session` | Create or retrieve a session |
| POST | `/execute` | Execute Python code |
| POST | `/context` | Load context data into session |
| GET | `/pending` | Get pending LLM requests (for client polling) |
| POST | `/respond` | Submit LLM response |
| DELETE | `/session` | Delete a session |

### Authentication

If `API_KEY` secret is set, all endpoints (except `/health`) require:
```
Authorization: Bearer <your-api-key>
```

## Usage with RLM

```python
from rlm import RLM

rlm = RLM(
    backend='openai',
    backend_kwargs={'model_name': 'gpt-4o-mini'},
    environment='cloudflare',
    environment_kwargs={
        'worker_url': 'https://rlm-sandbox.your-account.workers.dev',
        'api_key': 'your-api-key',  # if API_KEY secret is set
    },
)

result = rlm.completion('Calculate the square root of 144 using Python.')
print(result.response)
```

### Direct CloudflareREPL Usage

```python
from rlm.environments.cloudflare_repl import CloudflareREPL

repl = CloudflareREPL(
    worker_url='http://localhost:8787',  # or deployed URL
    api_key='your-api-key',  # optional
)

# Execute code
result = repl.execute_code('x = 10\nprint(x)')
print(result.stdout)  # "10\n"

# State persists
result = repl.execute_code('print(x * 2)')
print(result.stdout)  # "20\n"

# Load context
repl.load_context({'data': [1, 2, 3]})
result = repl.execute_code('print(sum(context["data"]))')
print(result.stdout)  # "6\n"

# Cleanup
repl.cleanup()
```

## Sandbox Features

Code executed in the sandbox has access to:

- **`llm_query(prompt, model=None)`** - Query the LLM and get a response
- **`llm_query_batched(prompts, model=None)`** - Query with multiple prompts
- **`FINAL_VAR(variable_name)`** - Get a variable's string value by name
- **Pre-installed packages** - numpy, pandas (in `-python` image)

### Installing Packages at Runtime

```python
repl.execute_code('''
import os
os.system("curl -LsSf https://astral.sh/uv/install.sh | sh")
os.system("/root/.local/bin/uv pip install requests --system")
import requests
print(requests.__version__)
''')
```

## Architecture

```
┌─────────────────────┐     HTTP      ┌─────────────────────────────┐
│  CloudflareREPL     │◄────────────►│  Cloudflare Worker          │
│  (Python Client)    │               │                             │
│                     │               │  ┌───────────────────────┐  │
│  - execute_code()   │               │  │  Sandbox Container    │  │
│  - load_context()   │               │  │  (Python 3.11)        │  │
│  - polls /pending   │               │  │                       │  │
│  - responds to LLM  │               │  │  - exec user code     │  │
│                     │               │  │  - state persistence  │  │
└─────────────────────┘               │  │  - llm_query()        │  │
                                      │  └───────────────────────┘  │
                                      └─────────────────────────────┘
```

## License

MIT
