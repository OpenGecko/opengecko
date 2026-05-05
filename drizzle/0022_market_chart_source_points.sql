CREATE TABLE `market_chart_source_points` (
  `coin_id` text NOT NULL,
  `vs_currency` text DEFAULT 'usd' NOT NULL,
  `interval` text DEFAULT '1d' NOT NULL,
  `timestamp` integer NOT NULL,
  `price` real NOT NULL,
  `market_cap` real,
  `total_volume` real,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `source_kind` text DEFAULT 'replay' NOT NULL,
  `source_provider` text DEFAULT 'unknown' NOT NULL,
  `source_fetched_at` integer,
  PRIMARY KEY(`coin_id`, `vs_currency`, `interval`, `timestamp`, `source_kind`, `source_provider`),
  FOREIGN KEY (`coin_id`) REFERENCES `coins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `market_chart_source_points_coin_currency_interval_timestamp_idx` ON `market_chart_source_points` (`coin_id`, `vs_currency`, `interval`, `timestamp`);
--> statement-breakpoint
CREATE INDEX `market_chart_source_points_source_fetched_at_idx` ON `market_chart_source_points` (`source_fetched_at`);
