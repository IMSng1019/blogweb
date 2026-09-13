import { createFileRoute } from "@tanstack/react-router";
import { createApiContext } from "@/lib/orpc/create-context";
import { openAPIHandler } from "@/lib/orpc/openapi-handler";

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
          const headers = new Headers(response.headers);
          headers.set("Cache-Control", "no-store");
          if (response.status === 401) {
            headers.set("WWW-Authenticate", "Bearer");
          }
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
        return response;
      },
    },
  },
});
