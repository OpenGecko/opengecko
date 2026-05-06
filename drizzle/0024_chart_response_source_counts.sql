CREATE TABLE `chart_response_source_counts` (
  `route` text NOT NULL,
  `source` text NOT NULL,
  `count` integer DEFAULT 0 NOT NULL,
  `first_seen_at` integer NOT NULL,
  `last_seen_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`route`, `source`)
);
--> statement-breakpoint
CREATE INDEX `chart_response_source_counts_updated_at_idx` ON `chart_response_source_counts` (`updated_at`);
