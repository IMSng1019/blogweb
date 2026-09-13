import { createFileRoute } from "@tanstack/react-router";
import { createApiContext } from "@/lib/orpc/create-context";
import { openAPIHandler } from "@/lib/orpc/openapi-handler";

export async function normalizeObsidianResponse(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  if (response.status === 401) {
    headers.set("WWW-Authenticate", "Bearer");
  }
  if (response.status >= 400) {
    try {
      const payload = (await response.clone().json()) as {
        code?: unknown;
        message?: unknown;
        data?: { current?: unknown };
      };
      if (typeof payload.code === "string") {
        const error: Record<string, unknown> = {
          code: payload.code,
          message:
            typeof payload.message === "string"
              ? payload.message
              : "Request failed.",
        };
        if (payload.data?.current !== undefined) {
          error.current = payload.data.current;
        }
        return new Response(JSON.stringify({ error }), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } catch {
      // Preserve non-JSON errors from the generic API handler.
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      ANY: async ({ request, context }) => {
        const { response } = await openAPIHandler.handle(request, {
          prefix: "/api",
          context: createApiContext(
            request.headers,
            context.env,
            context.executionCtx,
          ),
        });
        if (!response) return new Response("Not Found", { status: 404 });
        if (new URL(request.url).pathname.startsWith("/api/obsidian/")) {
          return normalizeObsidianResponse(response);
        }
        return response;
      },
    },
  },
});
