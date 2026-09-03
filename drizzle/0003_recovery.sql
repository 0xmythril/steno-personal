DROP INDEX IF EXISTS `connections_live_channel`;--> statement-breakpoint
ALTER TABLE `connections` ADD `purpose` text DEFAULT 'archive' NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `recovery_outcome` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `recovery_key_id` text REFERENCES access_keys(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_live_channel_purpose` ON `connections` (`channel`,`purpose`) WHERE revoked_at IS NULL;
