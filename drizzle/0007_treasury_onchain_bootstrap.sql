CREATE TABLE `treasury_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`symbol` text,
	`entity_type` text NOT NULL,
	`country` text,
	`description` text DEFAULT '' NOT NULL,
	`website_url` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `treasury_holdings` (
	`entity_id` text NOT NULL,
	`coin_id` text NOT NULL,
	`amount` real NOT NULL,
	`entry_value_usd` real,
	`reported_at` integer NOT NULL,
	`source_url` text,
	PRIMARY KEY(`entity_id`, `coin_id`),
	FOREIGN KEY (`entity_id`) REFERENCES `treasury_entities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coin_id`) REFERENCES `coins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `onchain_networks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`chain_identifier` integer,
	`coingecko_asset_platform_id` text,
	`native_currency_coin_id` text,
	`image_url` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `onchain_dexes` (
	`id` text NOT NULL,
	`network_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text,
	`image_url` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`network_id`, `id`),
	FOREIGN KEY (`network_id`) REFERENCES `onchain_networks`(`id`) ON UPDATE no action ON DELETE no action
);
