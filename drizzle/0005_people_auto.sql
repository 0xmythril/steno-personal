ALTER TABLE `people` ADD `name_source` text DEFAULT 'channel' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `archived_at` integer;--> statement-breakpoint
CREATE INDEX `people_archived_idx` ON `people` (`archived_at`);