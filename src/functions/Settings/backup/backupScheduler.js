const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { getAuthenticatedDriveClient, isGDriveConfigured } = require('./backupCreate');
const { findOrCreateBackupFolder } = require('./backupView');
const { ensureTempDir, createBackupArchive } = require('./backupBundle');

let scheduledTask = null;
let client = null;

/**
 * Maximum number of backups to retain
 */
const MAX_BACKUPS = 5;

/**
 * Initialize the automated backup scheduler
 * @param {import('discord.js').Client} discordClient - Discord client instance
 */
function initializeBackupScheduler(discordClient) {
	client = discordClient;

	// Check if scheduler is already running
	if (scheduledTask) {
		return;
	}

	// Schedule daily backups at 00:00 UTC
	// Cron format: second minute hour day month weekday
	// '0 0 * * *' = At 00:00 (midnight) every day
	scheduledTask = cron.schedule('0 0 * * *', async () => {
		await performScheduledBackup();
	}, {
		scheduled: true,
		timezone: 'UTC'
	});
}

/**
 * Performs the scheduled backup operation
 */
async function performScheduledBackup() {
	try {
		// Check if Google Drive is configured
		if (!isGDriveConfigured()) {
			return;
		}

		// Create backup
		const backupPath = await createDatabaseBackup();

		// Upload to Google Drive
		await uploadBackupToDrive(backupPath);

		// Enforce retention policy
		await enforceBackupRetention();

		// Clean up local backup file
		if (fs.existsSync(backupPath)) {
			fs.unlinkSync(backupPath);
		}

	} catch (error) {
		console.error('[Backup Scheduler] Backup failed:', error.message);

		// Log error to admin logs if available
		try {
			const { logAdminAction } = require('../../utility/AdminLogs');
			await logAdminAction(
				client,
				null,
				'AUTOMATED_BACKUP_FAILED',
				`Scheduled backup failed: ${error.message}`,
				{ error: error.stack }
			);
		} catch (logError) {
			console.error('[Backup Scheduler] Failed to log error:', logError.message);
		}
	}
}

/**
 * Creates a backup archive (core database + every plugin database).
 * @returns {Promise<string>} Path to the created .zip backup file
 */
async function createDatabaseBackup() {
	const tempDir = ensureTempDir();

	// Format: 2026-02-08T00-00-00
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('.')[0];
	const backupPath = path.join(tempDir, `wosland_backup_${timestamp}.zip`);

	const result = await createBackupArchive(backupPath);
	console.log(`[Backup Scheduler] Bundled core database + ${result.plugins.length} plugin database(s)`);

	return backupPath;
}

/**
 * Uploads backup to Google Drive
 * @param {string} backupPath - Path to the backup file
 * @returns {Promise<string>} File ID of the uploaded backup
 */
async function uploadBackupToDrive(backupPath) {

	const drive = getAuthenticatedDriveClient();
	const folderId = await findOrCreateBackupFolder(drive);

	const fileName = path.basename(backupPath);
	const fileSize = fs.statSync(backupPath).size;

	const response = await drive.files.create({
		requestBody: {
			name: fileName,
			parents: [folderId]
		},
		media: {
			mimeType: 'application/zip',
			body: fs.createReadStream(backupPath)
		},
		fields: 'id, name, size'
	});

	return response.data.id;
}

/**
 * Enforces backup retention policy (keeps only the latest MAX_BACKUPS)
 */
async function enforceBackupRetention() {

	const drive = getAuthenticatedDriveClient();
	const folderId = await findOrCreateBackupFolder(drive);

	// List all backups sorted by creation time (newest first)
	const response = await drive.files.list({
		q: `'${folderId}' in parents and trashed = false`,
		fields: 'files(id, name, createdTime, size)',
		orderBy: 'createdTime desc'
	});

	const backups = response.data.files;

	if (backups.length <= MAX_BACKUPS) {
		return;
	}

	// Delete oldest backups (keep only MAX_BACKUPS)
	const backupsToDelete = backups.slice(MAX_BACKUPS);


	for (const backup of backupsToDelete) {
		try {
			await drive.files.delete({ fileId: backup.id });
		} catch (error) {
			console.error(`[Backup Scheduler] Failed to delete ${backup.name}:`, error.message);
		}
	}

}

/**
 * Stops the backup scheduler
 */
function stopBackupScheduler() {
	if (scheduledTask) {
		scheduledTask.stop();
		scheduledTask = null;
	}
}

/**
 * Manually trigger a backup (for testing or manual execution)
 */
async function triggerManualBackup() {
	await performScheduledBackup();
}

/**
 * Get scheduler status
 * @returns {Object} Scheduler status information
 */
function getSchedulerStatus() {
	return {
		isRunning: scheduledTask !== null,
		isConfigured: isGDriveConfigured(),
		schedule: '00:00 UTC daily',
		maxBackups: MAX_BACKUPS,
		nextRun: scheduledTask ? 'Next midnight UTC' : 'Not scheduled'
	};
}

module.exports = {
	initializeBackupScheduler,
	stopBackupScheduler,
	triggerManualBackup,
	getSchedulerStatus
};
