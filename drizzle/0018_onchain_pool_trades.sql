CREATE TABLE `onchain_pool_trades` (
  `network_id` text NOT NULL,
  `pool_address` text NOT NULL,
  `trade_id` text NOT NULL,
  `token_address` text NOT NULL,
  `side` text NOT NULL,
  `volume_usd` real NOT NULL,
  `price_usd` real NOT NULL,
  `tx_hash` text NOT NULL,
  `block_timestamp` integer NOT NULL,
  `source_kind` text DEFAULT 'replay' NOT NULL,
  `source_provider` text,
  `source_fetched_at` integer,
  PRIMARY KEY(`network_id`, `pool_address`, `trade_id`),
  FOREIGN KEY (`network_id`) REFERENCES `onchain_networks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `onchain_pool_trades_pool_timestamp_idx` ON `onchain_pool_trades` (`network_id`, `pool_address`, `block_timestamp`);
--> statement-breakpoint
CREATE INDEX `onchain_pool_trades_token_timestamp_idx` ON `onchain_pool_trades` (`network_id`, `token_address`, `block_timestamp`);
--> statement-breakpoint
CREATE INDEX `onchain_pool_trades_source_fetched_at_idx` ON `onchain_pool_trades` (`source_fetched_at`);
