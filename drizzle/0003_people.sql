CREATE TABLE `channel_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text,
	`phone` text,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_contacts_connection_external_unique` ON `channel_contacts` (`connection_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `channel_contacts_channel_external_idx` ON `channel_contacts` (`channel`,`external_id`);--> statement-breakpoint
CREATE TABLE `dismissed_suggestions` (
	`telegram_external_id` text NOT NULL,
	`whatsapp_external_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`telegram_external_id`, `whatsapp_external_id`)
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `person_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text,
	`phone` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_identities_channel_external_unique` ON `person_identities` (`channel`,`external_id`);--> statement-breakpoint
CREATE INDEX `person_identities_person_idx` ON `person_identities` (`person_id`);