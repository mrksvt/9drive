-- CreateTable
CREATE TABLE `migration_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `source_account_id` CHAR(36) NOT NULL,
    `target_account_id` CHAR(36) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `total_files` INTEGER NOT NULL DEFAULT 0,
    `total_folders` INTEGER NOT NULL DEFAULT 0,
    `completed_files` INTEGER NOT NULL DEFAULT 0,
    `failed_files` INTEGER NOT NULL DEFAULT 0,
    `skipped_files` INTEGER NOT NULL DEFAULT 0,
    `total_bytes` BIGINT NOT NULL DEFAULT 0,
    `migrated_bytes` BIGINT NOT NULL DEFAULT 0,
    `error_message` TEXT NULL,
    `cursor` JSON NULL,
    `started_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `migration_sessions_user_id_idx`(`user_id`),
    INDEX `migration_sessions_user_id_status_idx`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `migration_items` (
    `id` CHAR(36) NOT NULL,
    `migration_id` CHAR(36) NOT NULL,
    `source_file_id` VARCHAR(191) NOT NULL,
    `source_parent_id` VARCHAR(191) NULL,
    `name` VARCHAR(255) NOT NULL,
    `mime_type` VARCHAR(191) NOT NULL,
    `size_bytes` BIGINT NOT NULL,
    `is_folder` BOOLEAN NOT NULL DEFAULT false,
    `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
    `target_file_id` VARCHAR(191) NULL,
    `target_folder_id` CHAR(36) NULL,
    `error_message` TEXT NULL,
    `retry_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `migration_items_migration_id_idx`(`migration_id`),
    INDEX `migration_items_migration_id_status_idx`(`migration_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `migration_sessions` ADD CONSTRAINT `migration_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `migration_sessions` ADD CONSTRAINT `migration_sessions_source_account_id_fkey` FOREIGN KEY (`source_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `migration_sessions` ADD CONSTRAINT `migration_sessions_target_account_id_fkey` FOREIGN KEY (`target_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `migration_items` ADD CONSTRAINT `migration_items_migration_id_fkey` FOREIGN KEY (`migration_id`) REFERENCES `migration_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
