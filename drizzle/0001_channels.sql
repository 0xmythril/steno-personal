CREATE TABLE `chats` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_chat_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`last_message_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chats_connection_chat_unique` ON `chats` (`connection_id`,`external_chat_id`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`external_account_id` text,
	`display_name` text,
	`session_ciphertext` text,
	`login_qr_token` text,
	`login_qr_at` integer,
	`login_needs_password` integer DEFAULT false NOT NULL,
	`login_secret_ciphertext` text,
	`login_secret_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	`last_sync_at` integer
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`external_message_id` text NOT NULL,
	`sender_external_id` text,
	`sender_name` text,
	`from_owner` integer DEFAULT false NOT NULL,
	`sent_at` integer NOT NULL,
	`type` text NOT NULL,
	`text` text,
	`has_media` integer DEFAULT false NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	`raw` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_external_unique` ON `messages` (`chat_id`,`external_message_id`);--> statement-breakpoint
CREATE INDEX `messages_chat_sent_idx` ON `messages` (`chat_id`,`sent_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_live_channel` ON `connections` (`channel`) WHERE `revoked_at` IS NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE `search_index` USING fts5(`message_id` UNINDEXED, `body`, tokenize = 'unicode61');--> statement-breakpoint
CREATE TRIGGER `messages_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO `search_index`(`message_id`, `body`) VALUES (new.`id`, coalesce(new.`text`, ''));
END;--> statement-breakpoint
CREATE TRIGGER `messages_au` AFTER UPDATE OF `text` ON `messages` BEGIN
  DELETE FROM `search_index` WHERE `message_id` = old.`id`;
  INSERT INTO `search_index`(`message_id`, `body`) VALUES (new.`id`, coalesce(new.`text`, ''));
END;--> statement-breakpoint
CREATE TRIGGER `messages_ad` AFTER DELETE ON `messages` BEGIN
  DELETE FROM `search_index` WHERE `message_id` = old.`id`;
END;
