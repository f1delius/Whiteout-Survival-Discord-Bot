const { ButtonBuilder, ButtonStyle, ActionRowBuilder, ContainerBuilder, MessageFlags, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize } = require('discord.js');
const { getUserInfo, assertUserMatches, handleError, updateComponentsV2AfterSeparator } = require('../../utility/commonFunctions');
const { getComponentEmoji, getEmojiMapForUser } = require('../../utility/emojis');
const { getAuthenticatedDriveClient, isGDriveConfigured, hasEnvGDriveCredentials } = require('./backupCreate');
const { findOrCreateBackupFolder, listBackupFiles } = require('./backupView');
const { ensureTempDir, extractBackupArchive, restorePluginDatabases, createBackupArchive, checkIntegrity, CORE_DB_PATH, PLUGINS_DIR } = require('./backupBundle');
const { installPlugin } = require('../../Plugin/pluginInstall');
const { db } = require('../../utility/database');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

/**
 * Creates the restore backup button
 * @param {string} userId - ID of the user who can interact with this button
 * @param {Object} lang - Language object for localized text
 * @returns {ButtonBuilder} The restore backup button
 */
function createBackupRestoreButton(userId, lang = {}) {
	return new ButtonBuilder()
		.setCustomId(`db_backup_restore_${userId}`)
		.setLabel(lang.settings.backup.mainPage.buttons.restore)
		.setStyle(ButtonStyle.Secondary)
		.setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1033'));
}

/**
 * Handle restore backup button - shows list of available backups
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleBackupRestoreButton(interaction) {
	const { adminData, lang } = getUserInfo(interaction.user.id);
	try {
		const expectedUserId = interaction.customId.split('_')[3];
		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Check if Google Drive is configured
		if (!isGDriveConfigured()) {
			return await interaction.reply({
				content: lang.settings.backup.backupRestore.error.noToken,
				ephemeral: true
			});
		}

		// Defer update since we'll be making API calls
		await interaction.deferUpdate();

		const container = [
			new ContainerBuilder()
				.setAccentColor(0x3498db)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.backupRestore.content.description.wait}`
					)
				)
		];

		interaction.editReply({
			components: updateComponentsV2AfterSeparator(interaction, container),
			flags: MessageFlags.IsComponentsV2
		});

		try {
			const drive = getAuthenticatedDriveClient();

			// Find backup folder
			const folderId = await findOrCreateBackupFolder(drive);

			// List all backup files
			const backups = await listBackupFiles(drive, folderId);

			if (backups.length === 0) {
				return await interaction.editReply({
					content: lang.settings.backup.backupRestore.error.noBackups,
					components: []
				});
			}

			// Show backup selection with restore buttons
			await showRestoreBackupSelection(interaction, lang, backups);
		} catch (error) {
			if (error.message.includes('OAuth setup incomplete')) {
				return await interaction.editReply({
					content: lang.settings.backup.backupRestore.error.setupIncomplete,
					components: []
				});
			}
			throw error;
		}
	} catch (error) {
		await handleError(interaction, lang, error, 'handleBackupRestoreButton');
	}
}

/**
 * Show backup selection with restore buttons
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {Object} lang - Language object
 * @param {Array} backups - Array of backup file objects
 */
async function showRestoreBackupSelection(interaction, lang, backups) {
	const userId = interaction.user.id;

	// Limit to latest 5 backups for button display
	const latestBackups = backups.slice(0, 5);

	let contentText = `${lang.settings.backup.backupRestore.content.title.base}\n` +
		`${lang.settings.backup.backupRestore.content.description.base}\n`;

	const buttons = [];

	latestBackups.forEach((backup, index) => {
		const date = new Date(backup.createdTime);
		const formattedDate = date.toUTCString();
		const sizeInMB = (parseInt(backup.size) / (1024 * 1024)).toFixed(2);

		contentText += `${lang.settings.backup.backupRestore.content.backupField.name.replace('{index}', index + 1).replace('{backupName}', backup.name)}\n`;
		contentText += `${lang.settings.backup.backupRestore.content.backupField.value.replace('{createdAt}', formattedDate).replace('{fileSize}', sizeInMB)}\n`;

		// Create restore button for this backup (max 5 buttons per row)
		if (index < 5) {
			const restoreBtn = new ButtonBuilder()
				.setCustomId(`db_backup_restore_confirm_${userId}_${backup.id}`)
				.setLabel(`${index + 1}`)
				.setStyle(ButtonStyle.Secondary)
				.setEmoji(getComponentEmoji(getEmojiMapForUser(userId), '1033'));

			buttons.push(restoreBtn);
		}
	});

	const actionRow = new ActionRowBuilder().addComponents(...buttons);

	const container = [
		new ContainerBuilder()
			.setAccentColor(0xe74c3c)
			.addTextDisplayComponents(
				new TextDisplayBuilder().setContent(contentText)
			)
			.addSeparatorComponents(
				new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
			)
			.addActionRowComponents(actionRow)
	];

	await interaction.editReply({
		components: updateComponentsV2AfterSeparator(interaction, container),
		flags: MessageFlags.IsComponentsV2
	});
}

/**
 * Handle restore confirm button - shows final confirmation warning
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleRestoreConfirmButton(interaction) {
	const { adminData, lang } = getUserInfo(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const expectedUserId = parts[4];
		// File ID can contain underscores, so join all remaining parts
		const fileId = parts.slice(5).join('_');

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		// Show final confirmation with execute button
		const executeBtn = new ButtonBuilder()
			.setCustomId(`db_backup_restore_execute_${expectedUserId}_${fileId}`)
			.setLabel(lang.settings.backup.backupRestore.buttons.confirm)
			.setStyle(ButtonStyle.Secondary)
			.setEmoji(getComponentEmoji(getEmojiMapForUser(expectedUserId), '1004'));

		const cancelBtn = new ButtonBuilder()
			.setCustomId(`db_backup_restore_cancel_${expectedUserId}`)
			.setLabel(lang.settings.backup.backupRestore.buttons.cancel)
			.setStyle(ButtonStyle.Secondary)
			.setEmoji(getComponentEmoji(getEmojiMapForUser(expectedUserId), '1051'));

		const actionRow = new ActionRowBuilder().addComponents(executeBtn, cancelBtn);

		const container = [
			new ContainerBuilder()
				.setAccentColor(0xc0392b)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.backupRestore.content.title.warning}\n` +
						`${lang.settings.backup.backupRestore.content.warningField.name}\n` +
						`${lang.settings.backup.backupRestore.content.warningField.value}`
					)
				)
				.addSeparatorComponents(
					new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
				)
				.addActionRowComponents(actionRow)
		];

		await interaction.update({
			components: updateComponentsV2AfterSeparator(interaction, container),
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await handleError(interaction, lang, error, 'handleRestoreConfirmButton');
	}
}

/**
 * Handle restore cancel button
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleRestoreCancelButton(interaction) {
	const { lang } = getUserInfo(interaction.user.id);
	try {

		if (!(await assertUserMatches(interaction, interaction.customId.split('_')[4], lang))) return;
		const container = [
			new ContainerBuilder()
				.setAccentColor(0x27ae60)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.backupRestore.content.cancelled}`
					)
				)
		];

		await interaction.update({
			components: updateComponentsV2AfterSeparator(interaction, container),
			flags: MessageFlags.IsComponentsV2
		});
	} catch (error) {
		await handleError(interaction, lang, error, 'handleRestoreCancelButton');
	}
}

/**
 * Handle restore execute button - performs the actual restoration
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleRestoreExecuteButton(interaction) {
	const { adminData, lang } = getUserInfo(interaction.user.id);
	try {
		const parts = interaction.customId.split('_');
		const expectedUserId = parts[4];
		// File ID can contain underscores, so join all remaining parts
		const fileId = parts.slice(5).join('_');

		if (!(await assertUserMatches(interaction, expectedUserId, lang))) return;

		if (!adminData?.is_owner) {
			return await interaction.reply({
				content: lang.common.noPermission,
				ephemeral: true
			});
		}

		await interaction.deferUpdate({});

		const drive = getAuthenticatedDriveClient();

		// Get file metadata to determine file type (backward compatibility with old .zip backups)
		const fileMetadata = await drive.files.get({
			fileId: fileId,
			fields: 'id, name, size, mimeType'
		});

		const fileName = fileMetadata.data.name;
		const isZipFile = fileName.endsWith('.zip');

		const container = [
			new ContainerBuilder()
				.setAccentColor(0xe67e22)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.backupRestore.content.downloading}`
					)
				)
		];

		const content = updateComponentsV2AfterSeparator(interaction, container);

		// Show progress message
		await interaction.editReply({
			components: content,
			flags: MessageFlags.IsComponentsV2
		});

		const tempDir = ensureTempDir();

		// Create safety backup of the current state (core + plugin databases) so a
		// bad restore is fully recoverable. Non-fatal: proceed even if it fails.
		try {
			const safetyBackupPath = path.join(tempDir, `pre-restore-backup_${Date.now()}.zip`);
			await createBackupArchive(safetyBackupPath);
			console.log(`[Database Restore] Safety backup written to ${safetyBackupPath}`);
		} catch (safetyError) {
			console.warn(`[Database Restore] Safety backup failed (continuing): ${safetyError.message}`);
		}

		// Download the backup file from Google Drive
		const downloadPath = await downloadBackupFile(drive, fileId, fileName);

		const container2 = [
			new ContainerBuilder()
				.setAccentColor(0xe67e22)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.backupRestore.content.restoring}`
					)
				)
		];

		// Perform database restoration
		await interaction.editReply({
			components: updateComponentsV2AfterSeparator(interaction, container2),
			flags: MessageFlags.IsComponentsV2
		});

		const pluginRestoreSummary = await applyBackupFile(downloadPath);

		// Show success message
		let pluginLine = '';
		if (isZipFile) {
			if (pluginRestoreSummary.restored.length) {
				pluginLine = `\nPlugin databases restored: ${pluginRestoreSummary.restored.length}`;
			}
			if (pluginRestoreSummary.skipped.length) {
				pluginLine += `\nPlugin databases skipped: ${pluginRestoreSummary.skipped.join(', ')}`;
			}
		}

		const successContainer = [
			new ContainerBuilder()
				.setAccentColor(0x27ae60)
				.addTextDisplayComponents(
					new TextDisplayBuilder().setContent(
						`${lang.settings.backup.backupRestore.content.title.success}\n` +
						`${lang.settings.backup.backupRestore.content.description.success}\n` +
						`${lang.settings.backup.backupRestore.content.restartingField.name}\n` +
						`${lang.settings.backup.backupRestore.content.restartingField.value}` +
						pluginLine
					)
				)
		];

		await interaction.editReply({
			components: updateComponentsV2AfterSeparator(interaction, successContainer),
			flags: MessageFlags.IsComponentsV2
		});

		// Automatically restart the bot after a brief delay
		setTimeout(() => {
			if (typeof global.restartBot === 'function') {
				global.restartBot();
			} else {
				console.warn('\n[Database Restore] Auto-restart unavailable. Please restart manually.');
			}
		}, 2000); // 2 second delay to allow message to send
	} catch (error) {
		await handleError(interaction, lang, error, 'handleRestoreExecuteButton');
	}
}

/**
 * Download a backup file from Google Drive into the temp directory
 * @param {import('googleapis').drive_v3.Drive} drive - Authenticated Drive client
 * @param {string} fileId - Drive file ID
 * @param {string} fileName - Drive file name (decides archive vs legacy .db)
 * @returns {Promise<string>} Path of the downloaded file
 */
async function downloadBackupFile(drive, fileId, fileName) {
	const downloadExt = fileName.endsWith('.zip') ? '.zip' : '.db';
	const downloadPath = path.join(ensureTempDir(), `restore_temp_${Date.now()}${downloadExt}`);
	const dest = fs.createWriteStream(downloadPath);

	const response = await drive.files.get(
		{ fileId: fileId, alt: 'media' },
		{ responseType: 'stream' }
	);

	await new Promise((resolve, reject) => {
		response.data
			.on('error', reject)
			.pipe(dest)
			.on('finish', resolve)
			.on('error', reject);
	});

	// Verify download completed successfully
	if (!fs.existsSync(downloadPath)) {
		throw new Error('Download failed: file not found');
	}
	if (fs.statSync(downloadPath).size === 0) {
		throw new Error('Download failed: file is empty');
	}

	return downloadPath;
}

/**
 * Restore the core database (and plugin databases, for archive backups) from a
 * downloaded backup file, then remove the downloaded and extracted temp files
 * @param {string} downloadPath - Path returned by downloadBackupFile
 * @param {{ installMissingPlugins?: boolean }} [options] - Reinstall the backup's plugins first when they are not on disk
 * @returns {Promise<{ restored: string[], skipped: string[] }>} Plugin database restore summary
 */
async function applyBackupFile(downloadPath, { installMissingPlugins = false } = {}) {
	const extractDir = path.join(ensureTempDir(), `restore_extract_${Date.now()}`);
	let pluginRestoreSummary = { restored: [], skipped: [] };

	try {
		if (downloadPath.endsWith('.zip')) {
			// Archive backup: extract, restore the core database, then plugin databases.
			const { coreDbPath, pluginDbs, manifest } = extractBackupArchive(downloadPath, extractDir);
			await restoreDatabase(CORE_DB_PATH, coreDbPath);
			if (installMissingPlugins) await installBackedUpPlugins(manifest);
			pluginRestoreSummary = restorePluginDatabases(pluginDbs);
			if (pluginRestoreSummary.restored.length) {
				console.log(`[Database Restore] Restored plugin databases: ${pluginRestoreSummary.restored.join(', ')}`);
			}
		} else {
			// Legacy backup: a bare core .db file.
			await restoreDatabase(CORE_DB_PATH, downloadPath);
		}
	} finally {
		// Clean up temp files
		try { fs.existsSync(downloadPath) && fs.unlinkSync(downloadPath); } catch { /* ignore */ }
		try { fs.existsSync(extractDir) && fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
	}

	return pluginRestoreSummary;
}

/**
 * Install, from the plugin registry, every plugin the backup was taken with that
 * is missing on disk, so its database has somewhere to be restored to. Plugin
 * modules are not registered: the caller restarts the bot, which loads them.
 * Backups made before the manifest listed installed plugins only name the
 * plugins that had a database.
 * @param {object|null} manifest - Backup manifest
 */
async function installBackedUpPlugins(manifest) {
	const pluginNames = manifest?.installedPlugins
		|| [...new Set((manifest?.plugins || []).map(entry => entry.plugin))];

	for (const pluginName of pluginNames) {
		if (fs.existsSync(path.join(PLUGINS_DIR, pluginName))) continue;
		const result = await installPlugin(pluginName, null);
		console.log(`[Auto Restore] Plugin ${pluginName}: ${result.message}`);
	}
}

/**
 * Count the rows that only exist once the bot has been set up
 * @returns {number}
 */
function countSetupRows() {
	return db.prepare(`
		SELECT (SELECT COUNT(*) FROM admins) + (SELECT COUNT(*) FROM alliance) + (SELECT COUNT(*) FROM players) AS total
	`).get().total;
}

/**
 * On startup, restore the latest Google Drive backup when the database is empty
 * and Drive credentials are supplied through env vars. Lets a host with an
 * ephemeral filesystem get its data back by itself after a redeploy.
 * Never touches a database that already holds data.
 * @returns {Promise<boolean>} True when a backup was restored and the bot is restarting
 */
async function autoRestoreIfEmpty() {
	if (!hasEnvGDriveCredentials()) return false;
	if (countSetupRows() > 0) return false;

	try {
		console.log('[Auto Restore] Database is empty, checking Google Drive for a backup...');
		const drive = getAuthenticatedDriveClient();
		const folderId = await findOrCreateBackupFolder(drive);
		const [latest] = await listBackupFiles(drive, folderId);
		if (!latest) {
			console.log('[Auto Restore] No backup found on Google Drive, starting with an empty database.');
			return false;
		}

		console.log(`[Auto Restore] Restoring ${latest.name} (created ${latest.createdTime})...`);
		const downloadPath = await downloadBackupFile(drive, latest.id, latest.name);
		await applyBackupFile(downloadPath, { installMissingPlugins: true });
	} catch (error) {
		console.error(`[Auto Restore] Failed, starting with an empty database: ${error.message}`);
		return false;
	}

	// A backup with no data would otherwise restore and restart forever.
	if (countSetupRows() === 0) {
		console.warn('[Auto Restore] The latest backup holds no data, starting with an empty database.');
		return false;
	}

	if (typeof global.restartBot !== 'function') {
		console.warn('[Auto Restore] Backup restored. Auto-restart unavailable, please restart manually.');
		return false;
	}

	console.log('[Auto Restore] Backup restored, restarting to load it...');
	global.restartBot();
	return true;
}

/**
 * Restore database from backup while preserving custom_emojis and settings tables
 * @param {string} currentDbPath - Path to current database
 * @param {string} backupDbPath - Path to backup database
 */
async function restoreDatabase(currentDbPath, backupDbPath) {
	const backupCheck = checkIntegrity(backupDbPath);
	if (!backupCheck.ok) {
		throw new Error(`Backup database integrity check failed: ${backupCheck.detail}`);
	}

	const currentDb = new Database(currentDbPath);
	const backupDb = new Database(backupDbPath);

	try {
		// Get all table names from current database except custom_emojis, settings, and processes
		const tables = currentDb.prepare(`
			SELECT name FROM sqlite_master 
			WHERE type='table' 
			  AND name NOT IN ('custom_emojis', 'settings', 'processes', 'sqlite_sequence')
		`).all();

		// Disable foreign keys temporarily
		currentDb.pragma('foreign_keys = OFF');

		// Drop all tables except custom_emojis, settings, and processes
		for (const table of tables) {
			currentDb.prepare(`DROP TABLE IF EXISTS ${table.name}`).run();
		}

		// Get all tables from backup database except custom_emojis, settings, and processes
		const backupTables = backupDb.prepare(`
			SELECT name, sql FROM sqlite_master 
			WHERE type='table' 
			  AND name NOT IN ('custom_emojis', 'settings', 'processes', 'sqlite_sequence')
		`).all();

		// Recreate tables from backup
		for (const table of backupTables) {
			currentDb.prepare(table.sql).run();
		}

		// Attach backup database
		currentDb.prepare(`ATTACH DATABASE '${backupDbPath}' AS backup_db`).run();

		// Copy data from backup to current database (excluding custom_emojis, settings, and processes)
		for (const table of backupTables) {
			const columns = backupDb.prepare(`PRAGMA table_info(${table.name})`).all();
			const columnNames = columns.map(col => col.name).join(', ');

			currentDb.prepare(`INSERT INTO ${table.name} (${columnNames}) SELECT ${columnNames} FROM backup_db.${table.name}`).run();
		}

		// Detach backup database
		currentDb.prepare('DETACH DATABASE backup_db').run();

		// Re-enable foreign keys
		currentDb.pragma('foreign_keys = ON');

		// Note: VACUUM is skipped because the bot's main database connection is still active.
		// The database will be optimized on the next bot restart.
	} finally {
		currentDb.close();
		backupDb.close();
	}
}

module.exports = {
	createBackupRestoreButton,
	handleBackupRestoreButton,
	handleRestoreConfirmButton,
	handleRestoreCancelButton,
	handleRestoreExecuteButton,
	autoRestoreIfEmpty
};
