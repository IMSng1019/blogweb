import { z } from "zod";
import { JsonContentSchema } from "@/features/posts/schema/json-content.schema";

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9\u4e00-\u9fa5]+(?:-[a-z0-9\u4e00-\u9fa5]+)*$/);

const articleContentSchema = JsonContentSchema.refine(
  (value) => value.type === "doc",
  "content must be a TipTap document",
);

export const ArticlePayloadSchema = z.object({
  title: z.string().trim().min(1).max(300),
  slug: slugSchema.optional(),
  content: articleContentSchema,
  path: z.string().trim().max(500).optional(),
  published: z.boolean().optional().default(false),
});

export const UpdateArticlePayloadSchema = ArticlePayloadSchema.extend({
  revision: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  force: z.boolean().optional().default(false),
});

export const ArticleIdSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const ArticleListQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(100),
});

export const SyncArticleSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  slug: z.string(),
  content: articleContentSchema,
  revision: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string(),
  createdAt: z.string(),
  published: z.boolean(),
  url: z.string().url(),
  obsidianUri: z.string().optional(),
});

export const ArticleListResponseSchema = z.object({
  items: z.array(SyncArticleSchema),
  nextCursor: z.number().int().positive().nullable(),
});

export type ArticlePayload = z.infer<typeof ArticlePayloadSchema>;
export type UpdateArticlePayload = z.infer<typeof UpdateArticlePayloadSchema>;
export type SyncArticle = z.infer<typeof SyncArticleSchema>;
