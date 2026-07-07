-- CreateTable
CREATE TABLE `migration_jobs` (
    `id` CHAR(36) NOT NULL,
    `migration_id` CHAR(36) NOT NULL,
    `type` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `payload` JSON NULL,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `max_retries` INTEGER NOT NULL DEFAULT 3,
    `error_message` TEXT NULL,
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `migration_jobs_migration_id_idx`(`migration_id`),
    INDEX `migration_jobs_status_idx`(`status`),
    INDEX `migration_jobs_migration_id_status_idx`(`migration_id`, `status`),
    INDEX `migration_jobs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `transfer_logs` (
    `id` CHAR(36) NOT NULL,
    `migration_id` CHAR(36) NOT NULL,
    `item_id` CHAR(36) NOT NULL,
    `action` VARCHAR(32) NOT NULL,
    `bytes_transferred` BIGINT NOT NULL DEFAULT 0,
    `total_bytes` BIGINT NOT NULL DEFAULT 0,
    `error_message` TEXT NULL,
    `metadata` JSON NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `transfer_logs_migration_id_idx`(`migration_id`),
    INDEX `transfer_logs_item_id_idx`(`item_id`),
    INDEX `transfer_logs_migration_id_item_id_idx`(`migration_id`, `item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `migration_sessions_user_id_created_at_idx` ON `migration_sessions`(`user_id`, `created_at`);

-- AddForeignKey
ALTER TABLE `migration_jobs` ADD CONSTRAINT `migration_jobs_migration_id_fkey` FOREIGN KEY (`migration_id`) REFERENCES `migration_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
