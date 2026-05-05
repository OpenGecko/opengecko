CREATE TABLE `coin_history_snapshots` (
  `coin_id` text NOT NULL,
  `vs_currency` text DEFAULT 'usd' NOT NULL,
  `snapshot_at` integer NOT NULL,
  `price` real NOT NULL,
  `market_cap` real,
  `total_volume` real,
  `market_cap_rank` integer,
  `fully_diluted_valuation` real,
  `circulating_supply` real,
  `total_supply` real,
  `max_supply` real,
  `ath` real,
  `ath_change_percentage` real,
  `ath_date` integer,
  `atl` real,
  `atl_change_percentage` real,
  `atl_date` integer,
  `price_change_24h` real,
  `price_change_percentage_24h` real,
  `source_kind` text DEFAULT 'replay' NOT NULL,
  `source_provider` text DEFAULT 'unknown' NOT NULL,
  `source_fetched_at` integer,
  `raw_payload_json` text DEFAULT '{}' NOT NULL,
  `updated_at` integer NOT NULL,
  `last_updated` integer NOT NULL,
  PRIMARY KEY(`coin_id`, `vs_currency`, `snapshot_at`, `source_kind`, `source_provider`),
  FOREIGN KEY (`coin_id`) REFERENCES `coins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `coin_history_snapshots_coin_currency_snapshot_idx` ON `coin_history_snapshots` (`coin_id`, `vs_currency`, `snapshot_at`);
--> statement-breakpoint
CREATE INDEX `coin_history_snapshots_source_fetched_at_idx` ON `coin_history_snapshots` (`source_fetched_at`);
