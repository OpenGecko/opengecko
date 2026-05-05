CREATE TABLE `onchain_pool_ohlcv` (
	`network_id` text NOT NULL,
	`pool_address` text NOT NULL,
	`timeframe` text NOT NULL,
	`aggregate` integer DEFAULT 1 NOT NULL,
	`timestamp` integer NOT NULL,
	`open` real NOT NULL,
	`high` real NOT NULL,
	`low` real NOT NULL,
	`close` real NOT NULL,
	`volume_usd` real,
	`source_kind` text DEFAULT 'replay' NOT NULL,
	`source_provider` text,
	`source_fetched_at` integer,
	PRIMARY KEY(`network_id`, `pool_address`, `timeframe`, `aggregate`, `timestamp`),
	FOREIGN KEY (`network_id`) REFERENCES `onchain_networks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `onchain_pool_ohlcv_source_fetched_at_idx` ON `onchain_pool_ohlcv` (`source_fetched_at`);
