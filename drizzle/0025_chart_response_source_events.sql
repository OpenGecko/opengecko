CREATE TABLE `chart_response_source_events` (
  `id` text PRIMARY KEY NOT NULL,
  `route` text NOT NULL,
  `source` text NOT NULL,
  `coin_id` text NOT NULL,
  `vs_currency` text NOT NULL,
  `interval` text,
  `request_kind` text NOT NULL,
  `days` text,
  `from_at` integer,
  `to_at` integer,
  `observed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chart_response_source_events_route_source_observed_at_idx` ON `chart_response_source_events` (`route`, `source`, `observed_at`);
--> statement-breakpoint
CREATE INDEX `chart_response_source_events_observed_at_idx` ON `chart_response_source_events` (`observed_at`);
