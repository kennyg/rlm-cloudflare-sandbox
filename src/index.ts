/**
 * RLM Cloudflare Sandbox Worker
 *
 * Implements the RLM sandbox API contract for executing Python code
 * in isolated Cloudflare Sandbox environments.
 *
 * Features:
 * - State persistence between executions (via session storage)
 * - LLM callbacks from sandbox code (llm_query, llm_query_batched)
 * - FINAL_VAR helper function
 */

import { getSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace;
  API_KEY?: string; // Optional: set via wrangler secret
}

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

interface SessionState {
  locals: Record<string, string>;
  llmRequests: LLMRequest[];
}

const sessionStates = new Map<string, SessionState>();

function generateId(): string {
  return crypto.randomUUID();
}

function getSessionState(sessionId: string): SessionState {
  if (!sessionStates.has(sessionId)) {
    sessionStates.set(sessionId, { locals: {}, llmRequests: [] });
  }
  return sessionStates.get(sessionId)!;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Build the Python execution script with:
 * - State restoration from previous executions
 * - llm_query() and llm_query_batched() functions
 * - FINAL_VAR() helper
 * - State serialization after execution
 */
function buildScript(
  code: string,
  workerUrl: string,
  sessionId: string,
  savedLocals: Record<string, string>
): string {
  const codeB64 = Buffer.from(code).toString("base64");
  const localsJson = JSON.stringify(savedLocals);
  const localsB64 = Buffer.from(localsJson).toString("base64");

  // Python script that handles everything
  const pythonScript = `
import sys
import io
import json
import base64
import traceback
import time

# Decode saved locals
_saved_locals_json = base64.b64decode('${localsB64}').decode()
_saved_locals = json.loads(_saved_locals_json)

# Restore locals (as actual values where possible)
_locals = {}
for k, v in _saved_locals.items():
    try:
        # Try to eval simple literals
        _locals[k] = eval(v)
    except:
        _locals[k] = v

# Worker URL for LLM callbacks
WORKER_URL = "${workerUrl}"
SESSION_ID = "${sessionId}"

def llm_query(prompt, model=None):
    """Query the LLM via the worker broker."""
    try:
        import requests
        # Submit request
        resp = requests.post(
            f"{WORKER_URL}/llm/request",
            json={"session_id": SESSION_ID, "type": "single", "prompt": prompt, "model": model},
            timeout=10
        )
        data = resp.json()
        request_id = data.get("request_id")
        if not request_id:
            return f"Error: {data.get('error', 'No request ID')}"

        # Poll for response (up to 5 minutes)
        for _ in range(300):
            time.sleep(1)
            poll_resp = requests.get(
                f"{WORKER_URL}/llm/poll",
                params={"session_id": SESSION_ID, "request_id": request_id},
                timeout=10
            )
            poll_data = poll_resp.json()
            if poll_data.get("resolved"):
                if poll_data.get("error"):
                    return f"Error: {poll_data['error']}"
                return poll_data.get("response", "")
        return "Error: LLM request timed out"
    except Exception as e:
        return f"Error: LLM query failed - {e}"

def llm_query_batched(prompts, model=None):
    """Query the LLM with multiple prompts."""
    try:
        import requests
        resp = requests.post(
            f"{WORKER_URL}/llm/request",
            json={"session_id": SESSION_ID, "type": "batched", "prompts": prompts, "model": model},
            timeout=10
        )
        data = resp.json()
        request_id = data.get("request_id")
        if not request_id:
            return [f"Error: {data.get('error', 'No request ID')}"] * len(prompts)

        # Poll for response
        for _ in range(300):
            time.sleep(1)
            poll_resp = requests.get(
                f"{WORKER_URL}/llm/poll",
                params={"session_id": SESSION_ID, "request_id": request_id},
                timeout=10
            )
            poll_data = poll_resp.json()
            if poll_data.get("resolved"):
                if poll_data.get("error"):
                    return [f"Error: {poll_data['error']}"] * len(prompts)
                return poll_data.get("responses", [])
        return ["Error: LLM request timed out"] * len(prompts)
    except Exception as e:
        return [f"Error: LLM query failed - {e}"] * len(prompts)

# Build execution globals
_globals = {
    "__builtins__": __builtins__,
    "__name__": "__main__",
    "llm_query": llm_query,
    "llm_query_batched": llm_query_batched,
}

# Decode and execute user code
code = base64.b64decode('${codeB64}').decode()

stdout_buf = io.StringIO()
stderr_buf = io.StringIO()
old_stdout, old_stderr = sys.stdout, sys.stderr

try:
    sys.stdout = stdout_buf
    sys.stderr = stderr_buf
    combined = {**_globals, **_locals}

    # FINAL_VAR needs to see variables in the current execution
    def FINAL_VAR(variable_name):
        variable_name = variable_name.strip().strip("\\"\\'")
        if variable_name in combined:
            return str(combined[variable_name])
        return f"Error: Variable '{variable_name}' not found"
    combined["FINAL_VAR"] = FINAL_VAR

    exec(code, combined, combined)
    # Update locals with new/modified values
    for key, value in combined.items():
        if key not in _globals and not key.startswith("_"):
            _locals[key] = value
except Exception as e:
    traceback.print_exc(file=stderr_buf)
finally:
    sys.stdout = old_stdout
    sys.stderr = old_stderr

# Serialize locals for persistence
def serialize_locals(state):
    result = {}
    for k, v in state.items():
        if k.startswith("_"):
            continue
        try:
            result[k] = repr(v)[:500]
        except:
            result[k] = f"<{type(v).__name__}>"
    return result

result = {
    "stdout": stdout_buf.getvalue(),
    "stderr": stderr_buf.getvalue(),
    "locals": serialize_locals(_locals),
}
print(json.dumps(result))
`;

  // Encode the entire Python script and run it
  const scriptB64 = Buffer.from(pythonScript).toString("base64");
  return `python3 -c "import base64; exec(base64.b64decode('${scriptB64}').decode())"`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check (no auth required)
    if (path === "/" || path === "/health") {
      return Response.json({ status: "ok" }, { headers: corsHeaders });
    }

    // API key authentication (if API_KEY is configured)
    if (env.API_KEY) {
      const authHeader = request.headers.get("Authorization");
      const providedKey = authHeader?.replace("Bearer ", "");

      if (providedKey !== env.API_KEY) {
        return Response.json(
          { error: "Unauthorized" },
          { status: 401, headers: corsHeaders }
        );
      }
    }

    try {

      // Create session
      if (method === "POST" && path === "/session") {
        const body = (await request.json()) as { session_id?: string };
        const sessionId = body.session_id || generateId();
        getSessionState(sessionId);
        return Response.json(
          { session_id: sessionId, status: "ready" },
          { headers: corsHeaders }
        );
      }

      // Execute code
      if (method === "POST" && path === "/execute") {
        const body = (await request.json()) as {
          session_id: string;
          code: string;
        };
        const { session_id: sessionId, code } = body;

        if (!sessionId || !code) {
          return Response.json(
            { error: "Missing session_id or code" },
            { status: 400, headers: corsHeaders }
          );
        }

        const state = getSessionState(sessionId);
        const sandboxId = env.Sandbox.idFromName(sessionId);
        const sandbox = getSandbox(
          env.Sandbox,
          sandboxId.toString().slice(0, 63)
        );

        const startTime = Date.now();

        // Get the worker URL for LLM callbacks
        const workerUrl = url.origin;
        const script = buildScript(code, workerUrl, sessionId, state.locals);

        try {
          const result = await sandbox.exec(script);
          const executionTime = (Date.now() - startTime) / 1000;

          const stdout = result.stdout || "";
          const stderr = result.stderr || "";

          // Parse JSON from output
          try {
            const parsed = JSON.parse(stdout.trim());

            // Save locals for next execution
            state.locals = parsed.locals || {};

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
            return Response.json(
              {
                stdout,
                stderr,
                locals: {},
                execution_time: executionTime,
              },
              { headers: corsHeaders }
            );
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Execution failed";
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

      // Load context - actually executes code to set the context variable
      if (method === "POST" && path === "/context") {
        const body = (await request.json()) as {
          session_id: string;
          context: unknown;
        };
        const { session_id: sessionId, context } = body;

        if (!sessionId) {
          return Response.json(
            { error: "Missing session_id" },
            { status: 400, headers: corsHeaders }
          );
        }

        const state = getSessionState(sessionId);

        // Store context as a serialized local variable
        if (typeof context === "string") {
          state.locals["context"] = JSON.stringify(context);
        } else {
          state.locals["context"] = JSON.stringify(JSON.stringify(context));
        }

        return Response.json({ status: "ok" }, { headers: corsHeaders });
      }

      // LLM request from sandbox code
      if (method === "POST" && path === "/llm/request") {
        const body = (await request.json()) as {
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

        const state = getSessionState(sessionId);
        const requestId = generateId();

        const llmRequest: LLMRequest = {
          id: requestId,
          request: { type, prompt, prompts, model },
          resolved: false,
        };

        state.llmRequests.push(llmRequest);

        return Response.json(
          { request_id: requestId, status: "pending" },
          { headers: corsHeaders }
        );
      }

      // Poll for LLM response (called by sandbox code)
      if (method === "GET" && path === "/llm/poll") {
        const sessionId = url.searchParams.get("session_id");
        const requestId = url.searchParams.get("request_id");

        if (!sessionId || !requestId) {
          return Response.json(
            { error: "Missing session_id or request_id" },
            { status: 400, headers: corsHeaders }
          );
        }

        const state = getSessionState(sessionId);
        const req = state.llmRequests.find((r) => r.id === requestId);

        if (!req) {
          return Response.json(
            { error: "Request not found" },
            { status: 404, headers: corsHeaders }
          );
        }

        if (req.resolved && req.response) {
          return Response.json(
            {
              resolved: true,
              response: req.response.response,
              responses: req.response.responses,
              error: req.response.error,
            },
            { headers: corsHeaders }
          );
        }

        return Response.json(
          { resolved: false },
          { headers: corsHeaders }
        );
      }

      // Get pending LLM requests (called by Python client)
      if (method === "GET" && path === "/pending") {
        const sessionId = url.searchParams.get("session_id");
        if (!sessionId) {
          return Response.json(
            { error: "Missing session_id" },
            { status: 400, headers: corsHeaders }
          );
        }

        const state = getSessionState(sessionId);
        const pending = state.llmRequests
          .filter((req) => !req.resolved)
          .map((req) => ({ id: req.id, request: req.request }));

        return Response.json({ pending }, { headers: corsHeaders });
      }

      // Respond to LLM request (called by Python client)
      if (method === "POST" && path === "/respond") {
        const body = (await request.json()) as {
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

        const state = getSessionState(sessionId);
        const req = state.llmRequests.find((r) => r.id === requestId);

        if (req) {
          req.response = response;
          req.resolved = true;
        }

        return Response.json({ status: "ok" }, { headers: corsHeaders });
      }

      // Delete session
      if (method === "DELETE" && path === "/session") {
        const body = (await request.json()) as { session_id: string };
        sessionStates.delete(body.session_id);
        return Response.json({ status: "deleted" }, { headers: corsHeaders });
      }

      return Response.json(
        { error: "Not found" },
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
