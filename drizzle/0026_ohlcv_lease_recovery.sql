ALTER TABLE `ohlcv_sync_targets` ADD `lease_owner` text;
--> statement-breakpoint
ALTER TABLE `ohlcv_sync_targets` ADD `lease_token` text;
--> statement-breakpoint
ALTER TABLE `ohlcv_sync_targets` ADD `lease_acquired_at` integer;
--> statement-breakpoint
ALTER TABLE `ohlcv_sync_targets` ADD `lease_expires_at` integer;
--> statement-breakpoint
ALTER TABLE `ohlcv_sync_targets` ADD `lease_recovery_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `ohlcv_sync_targets` ADD `last_lease_recovered_at` integer;
--> statement-breakpoint
ALTER TABLE `ohlcv_sync_targets` ADD `last_lease_recovery_reason` text;
