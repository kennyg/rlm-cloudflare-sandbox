/**
 * RLM Cloudflare Sandbox Worker
 *
 * Implements the RLM sandbox API contract for executing Python code
 * in isolated Cloudflare Sandbox environments with LLM callback support.
 *
 * API Endpoints:
 * - POST /session - Create/get a sandbox session
 * - POST /execute - Execute Python code
 * - POST /context - Load context data
 * - GET /pending - Get pending LLM requests
 * - POST /respond - Submit LLM response
 * - DELETE /session - Cleanup sandbox
 */

import { getSandbox, type Sandbox as SandboxType } from "@cloudflare/sandbox";

// Re-export Sandbox for Durable Object binding
export { Sandbox } from "@cloudflare/sandbox";

// Environment type with Sandbox binding
interface Env {
  Sandbox: DurableObjectNamespace<SandboxType>;
}

// Types for LLM request broker
interface LLMRequest {
  id: string;
  request: {
    type: "single" | "batched";
    prompt?: string;
    prompts?: string[];
    model?: string | null;
  };
  response?: {
    response?: string;
    responses?: string[];
    error?: string;
  };
  resolved: boolean;
}

// In-memory store for pending LLM requests per session
// In production, you'd want to use Durable Object storage
const sessionRequests = new Map<string, LLMRequest[]>();

// Generate unique request ID
function generateId(): string {
  return crypto.randomUUID();
}

// Get or create session request queue
function getSessionQueue(sessionId: string): LLMRequest[] {
  if (!sessionRequests.has(sessionId)) {
    sessionRequests.set(sessionId, []);
  }
  return sessionRequests.get(sessionId)!;
}

// Build Python execution script with llm_query support
function buildExecutionScript(
  code: string,
  sessionId: string,
  workerUrl: string
): string {
  // Escape the code for embedding in Python string
  const escapedCode = code
    .replace(/\\/g, "\\\\")
    .replace(/"""/g, '\\"\\"\\"');

  return `
import sys
import io
import json
import traceback
import os

try:
    import dill
except ImportError:
    import pickle as dill

try:
    import requests
except ImportError:
    requests = None

# =============================================================================
# LLM Query Functions (via Worker broker)
# =============================================================================

WORKER_URL = "${workerUrl}"
SESSION_ID = "${sessionId}"

def llm_query(prompt, model=None):
    """Query the LM via the Worker broker."""
    if requests is None:
        return "Error: requests library not available"
    try:
        # Submit request to broker
        response = requests.post(
            f"{WORKER_URL}/internal/enqueue",
            json={
                "session_id": SESSION_ID,
                "type": "single",
                "prompt": prompt,
                "model": model
            },
            timeout=300,
        )
        data = response.json()
        if data.get("error"):
            return f"Error: {data['error']}"

        # Poll for response
        request_id = data.get("request_id")
        if not request_id:
            return "Error: No request ID returned"

        import time
        for _ in range(3000):  # 5 minute timeout
            time.sleep(0.1)
            resp = requests.get(
                f"{WORKER_URL}/internal/result",
                params={"session_id": SESSION_ID, "request_id": request_id},
                timeout=10
            )
            result = resp.json()
            if result.get("resolved"):
                if result.get("error"):
                    return f"Error: {result['error']}"
                return result.get("response", "Error: No response")

        return "Error: LLM query timed out"
    except Exception as e:
        return f"Error: LM query failed - {e}"


def llm_query_batched(prompts, model=None):
    """Query the LM with multiple prompts."""
    if requests is None:
        return ["Error: requests library not available"] * len(prompts)
    try:
        response = requests.post(
            f"{WORKER_URL}/internal/enqueue",
            json={
                "session_id": SESSION_ID,
                "type": "batched",
                "prompts": prompts,
                "model": model
            },
            timeout=300,
        )
        data = response.json()
        if data.get("error"):
            return [f"Error: {data['error']}"] * len(prompts)

        request_id = data.get("request_id")
        if not request_id:
            return ["Error: No request ID returned"] * len(prompts)

        import time
        for _ in range(3000):
            time.sleep(0.1)
            resp = requests.get(
                f"{WORKER_URL}/internal/result",
                params={"session_id": SESSION_ID, "request_id": request_id},
                timeout=10
            )
            result = resp.json()
            if result.get("resolved"):
                if result.get("error"):
                    return [f"Error: {result['error']}"] * len(prompts)
                return result.get("responses", ["Error: No response"] * len(prompts))

        return ["Error: LLM query timed out"] * len(prompts)
    except Exception as e:
        return [f"Error: LM query failed - {e}"] * len(prompts)


# =============================================================================
# State Management
# =============================================================================

STATE_FILE = "/workspace/state.dill"

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "rb") as f:
                return dill.load(f)
        except:
            pass
    return {}

def save_state(state):
    clean_state = {}
    for k, v in state.items():
        if k.startswith("_"):
            continue
        try:
            dill.dumps(v)
            clean_state[k] = v
        except:
            pass
    with open(STATE_FILE, "wb") as f:
        dill.dump(clean_state, f)

def serialize_locals(state):
    result = {}
    for k, v in state.items():
        if k.startswith("_"):
            continue
        try:
            result[k] = repr(v)
        except:
            result[k] = f"<{type(v).__name__}>"
    return result

# =============================================================================
# Execution
# =============================================================================

_locals = load_state()

def FINAL_VAR(variable_name):
    variable_name = variable_name.strip().strip("\\"'")
    if variable_name in _locals:
        return str(_locals[variable_name])
    return f"Error: Variable '{variable_name}' not found"

_globals = {
    "__builtins__": __builtins__,
    "__name__": "__main__",
    "llm_query": llm_query,
    "llm_query_batched": llm_query_batched,
    "FINAL_VAR": FINAL_VAR,
}

code = """${escapedCode}"""

stdout_buf = io.StringIO()
stderr_buf = io.StringIO()
old_stdout, old_stderr = sys.stdout, sys.stderr

try:
    sys.stdout = stdout_buf
    sys.stderr = stderr_buf
    combined = {**_globals, **_locals}
    exec(code, combined, combined)
    for key, value in combined.items():
        if key not in _globals and not key.startswith("_"):
            _locals[key] = value
except Exception as e:
    traceback.print_exc(file=stderr_buf)
finally:
    sys.stdout = old_stdout
    sys.stderr = old_stderr

save_state(_locals)

result = {
    "stdout": stdout_buf.getvalue(),
    "stderr": stderr_buf.getvalue(),
    "locals": serialize_locals(_locals),
}
print(json.dumps(result))
`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    // CORS headers for development
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route requests
      if (method === "POST" && path === "/session") {
        return await handleCreateSession(request, env, corsHeaders);
      }

      if (method === "POST" && path === "/execute") {
        return await handleExecute(request, env, url.origin, corsHeaders);
      }

      if (method === "POST" && path === "/context") {
        return await handleLoadContext(request, env, corsHeaders);
      }

      if (method === "GET" && path === "/pending") {
        return handleGetPending(url, corsHeaders);
      }

      if (method === "POST" && path === "/respond") {
        return await handleRespond(request, corsHeaders);
      }

      if (method === "DELETE" && path === "/session") {
        return await handleDeleteSession(request, corsHeaders);
      }

      // Internal endpoints for sandbox LLM communication
      if (method === "POST" && path === "/internal/enqueue") {
        return await handleInternalEnqueue(request, corsHeaders);
      }

      if (method === "GET" && path === "/internal/result") {
        return handleInternalResult(url, corsHeaders);
      }

      return Response.json(
        { error: "Not found", endpoints: ["/session", "/execute", "/context", "/pending", "/respond"] },
        { status: 404, headers: corsHeaders }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return Response.json(
        { error: message },
        { status: 500, headers: corsHeaders }
      );
    }
  },
};

// =============================================================================
// Request Handlers
// =============================================================================

async function handleCreateSession(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as { session_id?: string };
  const sessionId = body.session_id || generateId();

  // Get or create sandbox for this session
  const sandboxId = env.Sandbox.idFromName(sessionId);
  const sandbox = getSandbox(env.Sandbox, sandboxId.toString().slice(0, 63));

  // Initialize the sandbox with a simple test
  try {
    await sandbox.exec("python3 --version");
  } catch {
    // Sandbox may need time to start
  }

  // Initialize session queue
  getSessionQueue(sessionId);

  return Response.json(
    { session_id: sessionId, status: "ready" },
    { headers: corsHeaders }
  );
}

async function handleExecute(
  request: Request,
  env: Env,
  workerUrl: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as { session_id: string; code: string };
  const { session_id: sessionId, code } = body;

  if (!sessionId || !code) {
    return Response.json(
      { error: "Missing session_id or code" },
      { status: 400, headers: corsHeaders }
    );
  }

  const sandboxId = env.Sandbox.idFromName(sessionId);
  const sandbox = getSandbox(env.Sandbox, sandboxId.toString().slice(0, 63));

  const startTime = Date.now();

  // Build execution script with LLM support
  const script = buildExecutionScript(code, sessionId, workerUrl);

  try {
    // Execute the script
    const result = await sandbox.exec("python3", "-c", script);

    const executionTime = (Date.now() - startTime) / 1000;

    // Parse JSON output from the script
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";

    // Try to extract JSON result from stdout
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1] || "{}";

    try {
      const parsed = JSON.parse(lastLine);
      return Response.json(
        {
          stdout: parsed.stdout || "",
          stderr: parsed.stderr || stderr,
          locals: parsed.locals || {},
          execution_time: executionTime,
        },
        { headers: corsHeaders }
      );
    } catch {
      // Couldn't parse JSON, return raw output
      return Response.json(
        {
          stdout: stdout,
          stderr: stderr,
          locals: {},
          execution_time: executionTime,
        },
        { headers: corsHeaders }
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed";
    return Response.json(
      {
        stdout: "",
        stderr: message,
        locals: {},
        execution_time: (Date.now() - startTime) / 1000,
      },
      { headers: corsHeaders }
    );
  }
}

async function handleLoadContext(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as { session_id: string; context: unknown };
  const { session_id: sessionId, context } = body;

  if (!sessionId) {
    return Response.json(
      { error: "Missing session_id" },
      { status: 400, headers: corsHeaders }
    );
  }

  const sandboxId = env.Sandbox.idFromName(sessionId);
  const sandbox = getSandbox(env.Sandbox, sandboxId.toString().slice(0, 63));

  // Build context loading code
  let contextCode: string;
  if (typeof context === "string") {
    const escaped = context.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
    contextCode = `context = """${escaped}"""`;
  } else {
    const contextJson = JSON.stringify(context);
    const escapedJson = contextJson.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    contextCode = `import json; context = json.loads('${escapedJson}')`;
  }

  // Wrap in state-saving script
  const script = `
import os
try:
    import dill
except ImportError:
    import pickle as dill

STATE_FILE = "/workspace/state.dill"

def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "rb") as f:
                return dill.load(f)
        except:
            pass
    return {}

def save_state(state):
    clean_state = {}
    for k, v in state.items():
        if k.startswith("_"):
            continue
        try:
            dill.dumps(v)
            clean_state[k] = v
        except:
            pass
    with open(STATE_FILE, "wb") as f:
        dill.dump(clean_state, f)

_locals = load_state()
${contextCode}
_locals["context"] = context
save_state(_locals)
print("ok")
`;

  try {
    await sandbox.exec("python3", "-c", script);
    return Response.json({ status: "ok" }, { headers: corsHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load context";
    return Response.json(
      { error: message },
      { status: 500, headers: corsHeaders }
    );
  }
}

function handleGetPending(
  url: URL,
  corsHeaders: Record<string, string>
): Response {
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId) {
    return Response.json(
      { error: "Missing session_id" },
      { status: 400, headers: corsHeaders }
    );
  }

  const queue = getSessionQueue(sessionId);
  const pending = queue
    .filter((req) => !req.resolved)
    .map((req) => ({
      id: req.id,
      request: req.request,
    }));

  return Response.json({ pending }, { headers: corsHeaders });
}

async function handleRespond(
  request: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as {
    session_id: string;
    id: string;
    response: { response?: string; responses?: string[]; error?: string };
  };
  const { session_id: sessionId, id: requestId, response } = body;

  if (!sessionId || !requestId) {
    return Response.json(
      { error: "Missing session_id or id" },
      { status: 400, headers: corsHeaders }
    );
  }

  const queue = getSessionQueue(sessionId);
  const req = queue.find((r) => r.id === requestId);

  if (!req) {
    return Response.json(
      { error: "Request not found" },
      { status: 404, headers: corsHeaders }
    );
  }

  req.response = response;
  req.resolved = true;

  return Response.json({ status: "ok" }, { headers: corsHeaders });
}

async function handleDeleteSession(
  request: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as { session_id: string };
  const { session_id: sessionId } = body;

  if (!sessionId) {
    return Response.json(
      { error: "Missing session_id" },
      { status: 400, headers: corsHeaders }
    );
  }

  // Clean up session queue
  sessionRequests.delete(sessionId);

  return Response.json({ status: "deleted" }, { headers: corsHeaders });
}

// =============================================================================
// Internal Endpoints (for sandbox -> Worker communication)
// =============================================================================

async function handleInternalEnqueue(
  request: Request,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const body = await request.json() as {
    session_id: string;
    type: "single" | "batched";
    prompt?: string;
    prompts?: string[];
    model?: string | null;
  };
  const { session_id: sessionId, type, prompt, prompts, model } = body;

  if (!sessionId) {
    return Response.json(
      { error: "Missing session_id" },
      { status: 400, headers: corsHeaders }
    );
  }

  const requestId = generateId();
  const queue = getSessionQueue(sessionId);

  queue.push({
    id: requestId,
    request: { type, prompt, prompts, model },
    resolved: false,
  });

  return Response.json({ request_id: requestId }, { headers: corsHeaders });
}

function handleInternalResult(
  url: URL,
  corsHeaders: Record<string, string>
): Response {
  const sessionId = url.searchParams.get("session_id");
  const requestId = url.searchParams.get("request_id");

  if (!sessionId || !requestId) {
    return Response.json(
      { error: "Missing session_id or request_id" },
      { status: 400, headers: corsHeaders }
    );
  }

  const queue = getSessionQueue(sessionId);
  const req = queue.find((r) => r.id === requestId);

  if (!req) {
    return Response.json(
      { error: "Request not found", resolved: false },
      { status: 404, headers: corsHeaders }
    );
  }

  if (!req.resolved) {
    return Response.json({ resolved: false }, { headers: corsHeaders });
  }

  // Return the response and remove from queue
  const response = req.response;
  const index = queue.indexOf(req);
  if (index > -1) {
    queue.splice(index, 1);
  }

  return Response.json(
    {
      resolved: true,
      response: response?.response,
      responses: response?.responses,
      error: response?.error,
    },
    { headers: corsHeaders }
  );
}
