CREATE TABLE `supply_chart_points` (
  `coin_id` text NOT NULL,
  `supply_type` text NOT NULL,
  `timestamp` integer NOT NULL,
  `value` real NOT NULL,
  `source_kind` text DEFAULT 'replay' NOT NULL,
  `source_provider` text DEFAULT 'unknown' NOT NULL,
  `source_fetched_at` integer,
  PRIMARY KEY(`coin_id`, `supply_type`, `timestamp`, `source_kind`, `source_provider`),
  FOREIGN KEY (`coin_id`) REFERENCES `coins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `supply_chart_points_coin_type_timestamp_idx` ON `supply_chart_points` (`coin_id`, `supply_type`, `timestamp`);
--> statement-breakpoint
CREATE INDEX `supply_chart_points_source_fetched_at_idx` ON `supply_chart_points` (`source_fetched_at`);
