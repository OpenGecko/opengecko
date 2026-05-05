CREATE TABLE `exchange_volume_source_points` (
  `exchange_id` text NOT NULL,
  `timestamp` integer NOT NULL,
  `volume_btc` real NOT NULL,
  `source_kind` text DEFAULT 'replay' NOT NULL,
  `source_provider` text DEFAULT 'unknown' NOT NULL,
  `source_fetched_at` integer,
  PRIMARY KEY(`exchange_id`, `timestamp`, `source_kind`, `source_provider`),
  FOREIGN KEY (`exchange_id`) REFERENCES `exchanges`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `exchange_volume_source_points_exchange_timestamp_idx` ON `exchange_volume_source_points` (`exchange_id`, `timestamp`);
--> statement-breakpoint
CREATE INDEX `exchange_volume_source_points_source_fetched_at_idx` ON `exchange_volume_source_points` (`source_fetched_at`);
