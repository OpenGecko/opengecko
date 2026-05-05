ALTER TABLE `derivative_tickers` ADD `source_kind` text NOT NULL DEFAULT 'seed';
--> statement-breakpoint
ALTER TABLE `derivative_tickers` ADD `source_provider` text;
--> statement-breakpoint
ALTER TABLE `derivative_tickers` ADD `source_fetched_at` integer;
