import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { ObsidianPostLinksTable, PostsTable } from "@/lib/db/schema";

export async function findPostLink(db: DB, postId: number) {
  return await db.query.ObsidianPostLinksTable.findFirst({
    where: eq(ObsidianPostLinksTable.postId, postId),
  });
}

export async function upsertPostLink(
  db: DB,
  data: typeof ObsidianPostLinksTable.$inferInsert,
) {
  const [link] = await db
    .insert(ObsidianPostLinksTable)
    .values(data)
    .onConflictDoUpdate({
      target: ObsidianPostLinksTable.postId,
      set: {
        obsidianPath: data.obsidianPath,
        revision: data.revision,
        contentHash: data.contentHash,
        updatedAt: new Date(),
      },
    })
    .returning();
  return link;
}

export async function updatePostLink(
  db: DB,
  postId: number,
  data: {
    obsidianPath?: string | null;
    revision: number;
    contentHash: string;
    expectedRevision?: number;
    expectedHash?: string;
  },
) {
  const [link] = await db
    .update(ObsidianPostLinksTable)
    .set({
      obsidianPath: data.obsidianPath,
      revision: data.revision,
      contentHash: data.contentHash,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ObsidianPostLinksTable.postId, postId),
        data.expectedRevision === undefined
          ? undefined
          : eq(ObsidianPostLinksTable.revision, data.expectedRevision),
        data.expectedHash === undefined
          ? undefined
          : eq(ObsidianPostLinksTable.contentHash, data.expectedHash),
      ),
    )
    .returning();
  return link;
}

export async function deletePostLink(db: DB, postId: number) {
  await db
    .delete(ObsidianPostLinksTable)
    .where(eq(ObsidianPostLinksTable.postId, postId));
}

export async function listPosts(db: DB, cursor: number, limit: number) {
  const rows = await db
    .select()
    .from(PostsTable)
    .where(gt(PostsTable.id, cursor))
    .orderBy(asc(PostsTable.id))
    .limit(limit + 1);
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function findLinks(db: DB, postIds: number[]) {
  if (postIds.length === 0) return [];
  return await db
    .select()
    .from(ObsidianPostLinksTable)
    .where(inArray(ObsidianPostLinksTable.postId, postIds));
}
