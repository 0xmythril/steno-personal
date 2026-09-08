DROP INDEX `connections_live_channel_purpose`;--> statement-breakpoint
ALTER TABLE `connections` ADD `mode` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `push_key_id` text REFERENCES access_keys(id);--> statement-breakpoint
CREATE UNIQUE INDEX `connections_push_source` ON `connections` (`channel`,`external_account_id`) WHERE revoked_at IS NULL AND mode = 'push';--> statement-breakpoint
CREATE UNIQUE INDEX `connections_live_channel_purpose` ON `connections` (`channel`,`purpose`) WHERE revoked_at IS NULL AND mode = 'live';--> statement-breakpoint
ALTER TABLE `access_keys` ADD `can_read` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `access_keys` ADD `can_push` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `push_key_id` text REFERENCES access_keys(id);--> statement-breakpoint
CREATE INDEX `messages_push_key_idx` ON `messages` (`push_key_id`);