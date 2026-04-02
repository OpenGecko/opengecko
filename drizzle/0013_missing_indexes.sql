CREATE INDEX IF NOT EXISTS `market_snapshots_coin_id_vs_currency_last_updated_idx` ON `market_snapshots` (`coin_id`, `vs_currency`, `last_updated`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `treasury_transactions_entity_id_happened_at_idx` ON `treasury_transactions` (`entity_id`, `happened_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `onchain_pools_dex_id_idx` ON `onchain_pools` (`dex_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `quote_snapshots_fetched_at_idx` ON `quote_snapshots` (`fetched_at`);
