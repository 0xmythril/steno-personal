CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`finished_at` integer,
	`kind` text NOT NULL,
	`operation` text NOT NULL,
	`surface` text NOT NULL,
	`actor_id` text,
	`actor_label` text NOT NULL,
	`outcome` text DEFAULT 'completed' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`run_id` text
);
--> statement-breakpoint
CREATE INDEX `events_time_idx` ON `events` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `events_kind_time_idx` ON `events` (`kind`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `events_actor_time_idx` ON `events` (`actor_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `event_sources` (
	`event_id` text NOT NULL,
	`source_id` text NOT NULL,
	`label` text NOT NULL,
	`channel` text NOT NULL,
	PRIMARY KEY(`event_id`, `source_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_sources_source_idx` ON `event_sources` (`source_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `history_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`enabled_at` integer NOT NULL,
	`trimmed_at` integer,
	`read_failures` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `message_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`revision` integer NOT NULL,
	`incoming_key_id` text NOT NULL,
	`incoming_text` text,
	`fingerprint` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`incoming_key_id`) REFERENCES `access_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `disputes_candidate_idx` ON `message_disputes` (`message_id`,`revision`,`incoming_key_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `disputes_key_idx` ON `message_disputes` (`incoming_key_id`);--> statement-breakpoint
ALTER TABLE `chats` ADD `last_push_at` integer;--> statement-breakpoint
ALTER TABLE `chats` ADD `last_push_key_id` text REFERENCES access_keys(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `content_key_id` text REFERENCES access_keys(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `content_actor` text;