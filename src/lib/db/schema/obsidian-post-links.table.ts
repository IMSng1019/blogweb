import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { PostsTable } from "./posts.table";
import { updatedAt } from "./helper";

export const ObsidianPostLinksTable = sqliteTable("obsidian_post_links", {
  postId: integer("post_id")
    .primaryKey()
    .references(() => PostsTable.id, { onDelete: "cascade" }),
  obsidianPath: text("obsidian_path"),
  revision: integer("revision").notNull().default(1),
  contentHash: text("content_hash").notNull(),
  updatedAt,
});

export type ObsidianPostLink = typeof ObsidianPostLinksTable.$inferSelect;
