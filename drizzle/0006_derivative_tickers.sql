CREATE TABLE `derivative_tickers` (
	`exchange_id` text NOT NULL,
	`symbol` text NOT NULL,
	`market` text NOT NULL,
	`index_id` text,
	`price` real,
	`price_percentage_change_24h` real,
	`contract_type` text NOT NULL,
	`index_value` real,
	`basis` real,
	`spread` real,
	`funding_rate` real,
	`open_interest_btc` real,
	`trade_volume_24h_btc` real,
	`last_traded_at` integer,
	`expired_at` integer,
	PRIMARY KEY(`exchange_id`, `symbol`),
	FOREIGN KEY (`exchange_id`) REFERENCES `derivatives_exchanges`(`id`) ON UPDATE no action ON DELETE no action
);
