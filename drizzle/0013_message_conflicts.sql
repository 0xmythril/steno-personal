ALTER TABLE `connections` ADD `last_push_key_id` text REFERENCES access_keys(id);--> statement-breakpoint
ALTER TABLE `messages` ADD `conflicted_at` integer;