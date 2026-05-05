CREATE TABLE `optional_provider_job_runs` (
  `job_id` text PRIMARY KEY NOT NULL,
  `status` text NOT NULL,
  `started_at` integer NOT NULL,
  `finished_at` integer,
  `targets_attempted` integer DEFAULT 0 NOT NULL,
  `rows_written` integer,
  `failure_reason` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `optional_provider_job_runs_status_updated_at_idx` ON `optional_provider_job_runs` (`status`, `updated_at`);
