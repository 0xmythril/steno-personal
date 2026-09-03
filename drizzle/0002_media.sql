CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer,
	`storage_path` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`is_voice_note` integer,
	`duration_seconds` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_message_idx` ON `media` (`message_id`);--> statement-breakpoint
CREATE INDEX `media_status_idx` ON `media` (`status`);--> statement-breakpoint
CREATE TABLE `media_analysis` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`medium` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`extracted_text` text,
	`description` text,
	`kind` text,
	`confidence` real,
	`language` text,
	`model` text,
	`cost_microusd` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_analysis_media_id_unique` ON `media_analysis` (`media_id`);--> statement-breakpoint
CREATE INDEX `media_analysis_status_idx` ON `media_analysis` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`openrouter_key_ciphertext` text,
	`analyze_images` integer DEFAULT false NOT NULL,
	`analyze_audio` integer DEFAULT false NOT NULL,
	`vision_model` text,
	`transcription_model` text
);
--> statement-breakpoint
INSERT INTO `settings` (`id`, `analyze_images`, `analyze_audio`) VALUES (1, 0, 0);
--> statement-breakpoint
-- Media text joins the same FTS index as message text, as a SECOND row for
-- the same message_id (searchMessages groups by message_id, M1). Fires on the
-- drain's UPDATE that sets extracted_text; a row inserted with NULL and later
-- failed or skipped never sets it, so it never lands here. Deleting the
-- message removes both rows through messages_ad.
CREATE TRIGGER `media_analysis_text_au` AFTER UPDATE OF `extracted_text` ON `media_analysis`
WHEN new.`extracted_text` IS NOT NULL BEGIN
  INSERT INTO `search_index`(`message_id`, `body`)
    SELECT m.`message_id`, new.`extracted_text` FROM `media` m WHERE m.`id` = new.`media_id`;
END;--> statement-breakpoint
-- From this migration on, one message can own more than one search_index row:
-- its own text, plus one per analysed attachment. M1's messages_au deletes
-- EVERY row for the message and reinserts only the message text, so an inbound
-- edit (applyEdit updates messages.text) would silently drop the OCR and the
-- transcript, and M4 has no re-analysis path to put them back. Recreate the
-- trigger here so it restores the media rows after reinserting the text.
-- 0001_channels.sql itself is applied and is never edited.
DROP TRIGGER `messages_au`;--> statement-breakpoint
CREATE TRIGGER `messages_au` AFTER UPDATE OF `text` ON `messages` BEGIN
  DELETE FROM `search_index` WHERE `message_id` = old.`id`;
  INSERT INTO `search_index`(`message_id`, `body`) VALUES (new.`id`, coalesce(new.`text`, ''));
  INSERT INTO `search_index`(`message_id`, `body`)
    SELECT m.`message_id`, a.`extracted_text` FROM `media_analysis` a
    JOIN `media` m ON m.`id` = a.`media_id`
    WHERE m.`message_id` = new.`id` AND a.`extracted_text` IS NOT NULL;
END;
