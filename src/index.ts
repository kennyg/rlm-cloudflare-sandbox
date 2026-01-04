/**
 * RLM Cloudflare Sandbox Worker
 *
 * Implements the RLM sandbox API contract for executing Python code
 * in isolated Cloudflare Sandbox environments.
 */

import { getSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace;
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

const sessionRequests = new Map<string, LLMRequest[]>();

function generateId(): string {
  return crypto.randomUUID();
}

function getSessionQueue(sessionId: string): LLMRequest[] {
  if (!sessionRequests.has(sessionId)) {
    sessionRequests.set(sessionId, []);
  }
  return sessionRequests.get(sessionId)!;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Build Python execution script using base64 encoding - single line
function buildScript(code: string): string {
  const b64 = Buffer.from(code).toString("base64");
  // All on one line to avoid shell newline issues
  return `python3 -c "import sys,io,json,traceback,base64;code=base64.b64decode('${b64}').decode();stdout_buf,stderr_buf=io.StringIO(),io.StringIO();old_stdout,old_stderr=sys.stdout,sys.stderr;_locals={};sys.stdout,sys.stderr=stdout_buf,stderr_buf;exec(code,{'__builtins__':__builtins__},_locals);sys.stdout,sys.stderr=old_stdout,old_stderr;serialized={k:repr(v)[:200] for k,v in _locals.items() if not k.startswith('_')};print(json.dumps({'stdout':stdout_buf.getvalue(),'stderr':stderr_buf.getvalue(),'locals':serialized}))"`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health check
      if (path === "/" || path === "/health") {
        return Response.json({ status: "ok" }, { headers: corsHeaders });
      }

      // Create session
      if (method === "POST" && path === "/session") {
        const body = (await request.json()) as { session_id?: string };
        const sessionId = body.session_id || generateId();
        getSessionQueue(sessionId);
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

        const sandboxId = env.Sandbox.idFromName(sessionId);
        const sandbox = getSandbox(
          env.Sandbox,
          sandboxId.toString().slice(0, 63)
        );

        const startTime = Date.now();
        const script = buildScript(code);

        try {
          const result = await sandbox.exec(script);
          const executionTime = (Date.now() - startTime) / 1000;

          const stdout = result.stdout || "";
          const stderr = result.stderr || "";

          // Parse JSON from output
          try {
            const parsed = JSON.parse(stdout.trim());
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

      // Load context
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

        // Note: state doesn't persist between exec calls in this simple impl
        return Response.json({ status: "ok" }, { headers: corsHeaders });
      }

      // Get pending LLM requests
      if (method === "GET" && path === "/pending") {
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
          .map((req) => ({ id: req.id, request: req.request }));

        return Response.json({ pending }, { headers: corsHeaders });
      }

      // Respond to LLM request
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

        const queue = getSessionQueue(sessionId);
        const req = queue.find((r) => r.id === requestId);

        if (req) {
          req.response = response;
          req.resolved = true;
        }

        return Response.json({ status: "ok" }, { headers: corsHeaders });
      }

      // Delete session
      if (method === "DELETE" && path === "/session") {
        const body = (await request.json()) as { session_id: string };
        sessionRequests.delete(body.session_id);
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
