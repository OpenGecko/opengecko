CREATE INDEX `coins_status_market_cap_rank_id_idx` ON `coins` (`status`,`market_cap_rank`,`id`);
--> statement-breakpoint
CREATE INDEX `market_snapshots_vs_currency_market_cap_rank_coin_id_idx` ON `market_snapshots` (`vs_currency`,`market_cap_rank`,`coin_id`);
