ALTER TABLE `events` ADD `subject_key_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `subject_label` text;--> statement-breakpoint
CREATE UNIQUE INDEX `events_run_idx` ON `events` (`run_id`);