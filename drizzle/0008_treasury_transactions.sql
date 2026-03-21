CREATE TABLE `treasury_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`coin_id` text NOT NULL,
	`type` text NOT NULL,
	`holding_net_change` real NOT NULL,
	`transaction_value_usd` real,
	`holding_balance` real NOT NULL,
	`average_entry_value_usd` real,
	`happened_at` integer NOT NULL,
	`source_url` text,
	FOREIGN KEY (`entity_id`) REFERENCES `treasury_entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coin_id`) REFERENCES `coins`(`id`) ON UPDATE no action ON DELETE no action
);
