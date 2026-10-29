CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`nickname` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`client_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`session_nonce` text NOT NULL,
	CONSTRAINT "nickname_length" CHECK(length("messages"."nickname") BETWEEN 1 AND 24),
	CONSTRAINT "content_length" CHECK(length("messages"."content") BETWEEN 2 AND 500)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_session_nonce_unique` ON `messages` (`session_nonce`);--> statement-breakpoint
CREATE INDEX `messages_chronological` ON `messages` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `messages_client_time` ON `messages` (`client_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `messages_duplicate` ON `messages` (`client_hash`,`content_hash`,`created_at`);