import { Hono } from "hono";
import type { Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  ArticleIdSchema,
  ArticleListQuerySchema,
  ArticlePayloadSchema,
  UpdateArticlePayloadSchema,
} from "@/features/obsidian-sync/schema/obsidian-sync.schema";
import * as SyncService from "@/features/obsidian-sync/service/obsidian-sync.service";
import { getServiceContext } from "@/lib/hono/helper";
import { baseMiddleware } from "@/lib/hono/middlewares";

const app = new Hono<{ Bindings: Env }>();
app.use("*", baseMiddleware);

function unauthorized(c: Context<{ Bindings: Env }>) {
  return c.json(
    { error: { code: "UNAUTHORIZED", message: "A valid bearer token is required" } },
    401,
    { "WWW-Authenticate": "Bearer", "Cache-Control": "no-store" },
  );
}

function safeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

app.use("*", async (c, next) => {
  const authorization = c.req.header("Authorization") ?? "";
  const [scheme, token] = authorization.split(" ", 2);
  const expected = c.env.OBSIDIAN_SYNC_TOKEN;
  if (scheme !== "Bearer" || !token || !expected || !safeEqual(token, expected)) {
    return unauthorized(c);
  }
  await next();
});

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
});

app.get("/", zValidator("query", ArticleListQuerySchema), async (c) => {
  const query = c.req.valid("query");
  return c.json(await SyncService.listArticles(getServiceContext(c), query.cursor, query.limit));
});

app.post("/", zValidator("json", ArticlePayloadSchema), async (c) => {
  const article = await SyncService.createArticle(getServiceContext(c), c.req.valid("json"));
  return c.json(article, 201);
});

app.get("/:id", zValidator("param", ArticleIdSchema), async (c) => {
  const article = await SyncService.getArticle(getServiceContext(c), c.req.valid("param").id);
  if (!article) return c.json({ error: { code: "ARTICLE_NOT_FOUND", message: "Article not found" } }, 404);
  return c.json(article);
});

app.put("/:id", zValidator("param", ArticleIdSchema), zValidator("json", UpdateArticlePayloadSchema), async (c) => {
  const result = await SyncService.updateArticle(getServiceContext(c), c.req.valid("param").id, c.req.valid("json"));
  if (result.conflict) return c.json({ error: { code: "REVISION_CONFLICT", message: "The remote article changed since this note was last synced", current: result.conflict } }, 409);
  if (result.notFound) return c.json({ error: { code: "ARTICLE_NOT_FOUND", message: "Article not found" } }, 404);
  if (!result.article) return c.json({ error: { code: "ARTICLE_NOT_FOUND", message: "Article not found" } }, 404);
  return c.json(result.article);
});

app.delete("/:id", zValidator("param", ArticleIdSchema), async (c) => {
  const deleted = await SyncService.deleteArticle(getServiceContext(c), c.req.valid("param").id);
  if (!deleted) return c.json({ error: { code: "ARTICLE_NOT_FOUND", message: "Article not found" } }, 404);
  return c.json({ success: true });
});

export default app;
