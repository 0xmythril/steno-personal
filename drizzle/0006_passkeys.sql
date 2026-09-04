CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`key_id` text,
	`passkey_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`key_id`) REFERENCES `access_keys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`passkey_id`) REFERENCES `passkeys`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_one_credential" CHECK(("key_id" IS NULL) <> ("passkey_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "key_id", "passkey_id", "created_at", "expires_at") SELECT "id", "key_id", NULL, "created_at", "expires_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `sessions_key_idx` ON `sessions` (`key_id`);--> statement-breakpoint
CREATE INDEX `sessions_passkey_idx` ON `sessions` (`passkey_id`);