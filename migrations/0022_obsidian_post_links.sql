CREATE TABLE `obsidian_post_links` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`obsidian_path` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`content_hash` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
