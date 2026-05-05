CREATE TABLE `treasury_source_documents` (
	`source_url` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`provider` text DEFAULT 'disclosure_replay' NOT NULL,
	`document_type` text DEFAULT 'treasury_disclosure' NOT NULL,
	`accepted_at` integer NOT NULL,
	`content_hash` text NOT NULL,
	`raw_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `treasury_entities`(`id`) ON UPDATE no action ON DELETE no action
);
