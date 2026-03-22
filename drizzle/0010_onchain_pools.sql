CREATE TABLE `onchain_pools` (
	`network_id` text NOT NULL,
	`address` text NOT NULL,
	`dex_id` text NOT NULL,
	`name` text NOT NULL,
	`base_token_address` text NOT NULL,
	`base_token_symbol` text NOT NULL,
	`quote_token_address` text NOT NULL,
	`quote_token_symbol` text NOT NULL,
	`price_usd` real,
	`reserve_usd` real,
	`volume_24h_usd` real,
	`transactions_24h_buys` integer DEFAULT 0 NOT NULL,
	`transactions_24h_sells` integer DEFAULT 0 NOT NULL,
	`created_at_timestamp` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`network_id`, `address`),
	FOREIGN KEY (`network_id`) REFERENCES `onchain_networks`(`id`) ON UPDATE no action ON DELETE no action
);
