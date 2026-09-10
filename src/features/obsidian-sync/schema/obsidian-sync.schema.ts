import { z } from "zod";
import { JsonContentSchema } from "@/features/posts/schema/json-content.schema";

const slugSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9\u4e00-\u9fff]+(?:-[a-z0-9\u4e00-\u9fff]+)*$/);

export const ArticlePayloadSchema = z.object({
  title: z.string().trim().min(1).max(300),
  slug: slugSchema.optional(),
  content: JsonContentSchema.refine(
    (value) => value?.type === "doc",
    "content must be a TipTap document",
  ),
  path: z.string().max(500).optional(),
  published: z.boolean().optional().default(false),
});

export const UpdateArticlePayloadSchema = ArticlePayloadSchema.extend({
  revision: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  force: z.boolean().optional().default(false),
});

export const ArticleIdSchema = z.object({ id: z.coerce.number().int().positive() });

export const ArticleListQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(100),
});

export type ArticlePayload = z.infer<typeof ArticlePayloadSchema>;
export type UpdateArticlePayload = z.infer<typeof UpdateArticlePayloadSchema>;
