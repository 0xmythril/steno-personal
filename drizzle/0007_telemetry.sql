ALTER TABLE `settings` ADD `telemetry_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `telemetry_instance_id` text;