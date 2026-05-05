CREATE TABLE `onchain_token_holders` (
	`network_id` text NOT NULL,
	`token_address` text NOT NULL,
	`holder_address` text NOT NULL,
	`balance` real NOT NULL,
	`share_of_supply` real NOT NULL,
	`pnl_usd` real DEFAULT 0 NOT NULL,
	`avg_buy_price_usd` real DEFAULT 0 NOT NULL,
	`realized_pnl_usd` real DEFAULT 0 NOT NULL,
	`source_kind` text DEFAULT 'replay' NOT NULL,
	`source_provider` text,
	`source_fetched_at` integer,
	PRIMARY KEY(`network_id`, `token_address`, `holder_address`),
	FOREIGN KEY (`network_id`) REFERENCES `onchain_networks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `onchain_token_holders_source_fetched_at_idx` ON `onchain_token_holders` (`source_fetched_at`);
--> statement-breakpoint
CREATE TABLE `onchain_token_traders` (
	`network_id` text NOT NULL,
	`token_address` text NOT NULL,
	`trader_address` text NOT NULL,
	`volume_usd` real NOT NULL,
	`buy_volume_usd` real NOT NULL,
	`sell_volume_usd` real NOT NULL,
	`realized_pnl_usd` real DEFAULT 0 NOT NULL,
	`trade_count` integer DEFAULT 0 NOT NULL,
	`address_label` text,
	`source_kind` text DEFAULT 'replay' NOT NULL,
	`source_provider` text,
	`source_fetched_at` integer,
	PRIMARY KEY(`network_id`, `token_address`, `trader_address`),
	FOREIGN KEY (`network_id`) REFERENCES `onchain_networks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `onchain_token_traders_source_fetched_at_idx` ON `onchain_token_traders` (`source_fetched_at`);
--> statement-breakpoint
CREATE TABLE `onchain_token_holder_counts` (
	`network_id` text NOT NULL,
	`token_address` text NOT NULL,
	`timestamp` integer NOT NULL,
	`holder_count` integer NOT NULL,
	`source_kind` text DEFAULT 'replay' NOT NULL,
	`source_provider` text,
	`source_fetched_at` integer,
	PRIMARY KEY(`network_id`, `token_address`, `timestamp`),
	FOREIGN KEY (`network_id`) REFERENCES `onchain_networks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `onchain_token_holder_counts_source_fetched_at_idx` ON `onchain_token_holder_counts` (`source_fetched_at`);
