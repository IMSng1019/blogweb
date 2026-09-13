import { z } from "zod";
import {
  ArticleIdSchema,
  ArticleListQuerySchema,
  ArticleListResponseSchema,
  ArticlePayloadSchema,
  SyncArticleSchema,
  UpdateArticlePayloadSchema,
} from "@/features/obsidian-sync/schema/obsidian-sync.schema";
import * as SyncService from "@/features/obsidian-sync/service/obsidian-sync.service";
import { publicProcedure } from "@/lib/orpc/procedure";

const syncErrors = {
  ARTICLE_NOT_FOUND: { status: 404, message: "Article not found." },
  REVISION_CONFLICT: {
    status: 409,
    message: "The remote article changed since this note was last synced.",
    data: z.object({ current: SyncArticleSchema }),
  },
} as const;

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

const obsidianProcedure = publicProcedure
  .errors(syncErrors)
  .use(async ({ context, errors, next }) => {
    const authorization = context.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/.exec(authorization);
    const expected = context.env.OBSIDIAN_SYNC_TOKEN;
    if (!match?.[1] || !expected || !safeEqual(match[1], expected)) {
      throw errors.UNAUTHORIZED();
    }
    return next();
  });

const list = obsidianProcedure
  .route({
    method: "GET",
    path: "/obsidian/articles",
    summary: "List articles for Obsidian sync",
    tags: ["Obsidian Sync"],
  })
  .input(ArticleListQuerySchema)
  .output(ArticleListResponseSchema)
  .handler(({ context, input }) =>
    SyncService.listArticles(context, input.cursor, input.limit),
  );

const create = obsidianProcedure
  .route({
    method: "POST",
    path: "/obsidian/articles",
    successStatus: 201,
    summary: "Create an article from an Obsidian note",
    tags: ["Obsidian Sync"],
  })
  .input(ArticlePayloadSchema)
  .output(SyncArticleSchema)
  .handler(({ context, input }) => SyncService.createArticle(context, input));

const get = obsidianProcedure
  .errors(syncErrors)
  .route({
    method: "GET",
    path: "/obsidian/articles/{id}",
    summary: "Get an article by id",
    tags: ["Obsidian Sync"],
  })
  .input(ArticleIdSchema)
  .output(SyncArticleSchema)
  .handler(async ({ context, input, errors }) => {
    const article = await SyncService.getArticle(context, input.id);
    if (!article) throw errors.ARTICLE_NOT_FOUND();
    return article;
  });

const update = obsidianProcedure
  .errors(syncErrors)
  .route({
    method: "PUT",
    path: "/obsidian/articles/{id}",
    summary: "Update an article from an Obsidian note",
    tags: ["Obsidian Sync"],
  })
  .input(ArticleIdSchema.merge(UpdateArticlePayloadSchema))
  .output(SyncArticleSchema)
  .handler(async ({ context, input, errors }) => {
    const { id, ...payload } = input;
    const result = await SyncService.updateArticle(context, id, payload);
    if (result.notFound) throw errors.ARTICLE_NOT_FOUND();
    if (result.conflict) {
      throw errors.REVISION_CONFLICT({ data: { current: result.conflict } });
    }
    return result.article;
  });

const remove = obsidianProcedure
  .errors(syncErrors)
  .route({
    method: "DELETE",
    path: "/obsidian/articles/{id}",
    summary: "Delete an article",
    tags: ["Obsidian Sync"],
  })
  .input(ArticleIdSchema)
  .output(z.object({ success: z.literal(true) }))
  .handler(async ({ context, input, errors }) => {
    if (!(await SyncService.deleteArticle(context, input.id))) {
      throw errors.ARTICLE_NOT_FOUND();
    }
    return { success: true as const };
  });

export default {
  list,
  create,
  get,
  update,
  remove,
};
