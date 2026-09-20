/**
 * Backup bundling helpers.
 *
 * Historically a backup was a single copy of the core `Database.db`. It is now a
 * ZIP archive that also contains every plugin database, so a full restore brings
 * back plugin configuration (translation groups, web-panel settings, ...) too.
 *
 * Archive layout (format 2):
 *   manifest.json
 *   database/Database.db
 *   plugins/<plugin-name>/<file>.db
 *
 * Restore stays backward compatible with:
 *   - a bare `.db` file (legacy format)
 *   - an older `.zip` with no manifest (core db located heuristically)
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const AdmZip = require('adm-zip');

const BACKUP_DIR = __dirname;
const CORE_DB_PATH = path.join(BACKUP_DIR, '../../../database/Database.db');
const PLUGINS_DIR = path.join(BACKUP_DIR, '../../../../plugins');
const TEMP_DIR = path.join(BACKUP_DIR, '../../../temp');

const ARCHIVE_FORMAT = 2;
const CORE_ARCHIVE_PATH = 'database/Database.db';

function ensureTempDir() {
	if (!fs.existsSync(TEMP_DIR)) {
		fs.mkdirSync(TEMP_DIR, { recursive: true });
	}
	return TEMP_DIR;
}

/**
 * Validate a SQLite database file with PRAGMA integrity_check.
 * @param {string} dbPath
 * @returns {{ ok: boolean, detail?: string }}
 */
function checkIntegrity(dbPath) {
	let db;
	try {
		db = new Database(dbPath, { readonly: true });
		const result = db.pragma('integrity_check');
		const first = Array.isArray(result) && result.length ? result[0] : null;
		const value = first && typeof first === 'object' ? first.integrity_check : first;
		if (value === 'ok') return { ok: true };
		return { ok: false, detail: JSON.stringify(Array.isArray(result) ? result.slice(0, 3) : result) };
	} catch (error) {
		return { ok: false, detail: error.message };
	} finally {
		try { db && db.close(); } catch { /* ignore */ }
	}
}

/**
 * Create a transactionally-consistent snapshot of a live database using the
 * SQLite backup API (safe while the source is in use / in WAL mode).
 * @param {string} sourcePath
 * @param {string} destPath
 */
async function snapshotDatabase(sourcePath, destPath) {
	const sourceDb = new Database(sourcePath, { readonly: true });
	try {
		await sourceDb.backup(destPath);
	} finally {
		try { sourceDb.close(); } catch { /* ignore */ }
	}
}

/**
 * Discover top-level `*.db` files inside every installed plugin directory.
 * WAL/SHM/journal sidecars and nested paths (node_modules) are ignored.
 * @returns {Array<{ pluginName: string, fileName: string, absPath: string, archivePath: string }>}
 */
function discoverPluginDatabases(pluginsDir = PLUGINS_DIR) {
	const found = [];
	if (!fs.existsSync(pluginsDir)) return found;

	for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pluginDir = path.join(pluginsDir, entry.name);
		if (!fs.existsSync(path.join(pluginDir, 'plugin.json'))) continue;

		let files;
		try {
			files = fs.readdirSync(pluginDir);
		} catch {
			continue;
		}

		for (const fileName of files) {
			if (!/\.db$/i.test(fileName)) continue;
			const absPath = path.join(pluginDir, fileName);
			try {
				if (!fs.statSync(absPath).isFile()) continue;
			} catch {
				continue;
			}
			found.push({
				pluginName: entry.name,
				fileName,
				absPath,
				archivePath: `plugins/${entry.name}/${fileName}`
			});
		}
	}

	return found;
}

/**
 * Build the backup ZIP: core database + every plugin database + manifest.
 * The core database is validated and a failed check aborts the backup; a plugin
 * database that fails its check is skipped (logged) so one broken plugin cannot
 * block the whole backup.
 *
 * @param {string} archivePath - Where to write the .zip
 * @returns {Promise<{ archivePath: string, coreSize: number, plugins: string[], skipped: string[] }>}
 */
async function createBackupArchive(archivePath, { coreDbPath = CORE_DB_PATH, pluginsDir = PLUGINS_DIR } = {}) {
	if (!fs.existsSync(coreDbPath)) {
		throw new Error('Database file not found');
	}
	if (fs.statSync(coreDbPath).size === 0) {
		throw new Error('Database file is empty');
	}

	const coreCheck = checkIntegrity(coreDbPath);
	if (!coreCheck.ok) {
		throw new Error(`Database integrity check failed: ${coreCheck.detail}`);
	}

	const workDir = fs.mkdtempSync(path.join(ensureTempDir(), 'backup-stage-'));
	const zip = new AdmZip();

	try {
		// Core database
		const coreSnapshot = path.join(workDir, 'Database.db');
		await snapshotDatabase(coreDbPath, coreSnapshot);
		zip.addLocalFile(coreSnapshot, path.dirname(CORE_ARCHIVE_PATH), path.basename(CORE_ARCHIVE_PATH));

		// Plugin databases
		const includedPlugins = [];
		const skippedPlugins = [];
		const manifestPlugins = [];

		for (const pluginDb of discoverPluginDatabases(pluginsDir)) {
			const snapshotName = `${pluginDb.pluginName}__${pluginDb.fileName}`;
			const snapshotPath = path.join(workDir, snapshotName);
			try {
				await snapshotDatabase(pluginDb.absPath, snapshotPath);
				const check = checkIntegrity(snapshotPath);
				if (!check.ok) {
					skippedPlugins.push(`${pluginDb.pluginName}/${pluginDb.fileName} (${check.detail})`);
					continue;
				}
				zip.addLocalFile(snapshotPath, path.posix.dirname(pluginDb.archivePath), path.posix.basename(pluginDb.archivePath));
				includedPlugins.push(`${pluginDb.pluginName}/${pluginDb.fileName}`);
				manifestPlugins.push({
					plugin: pluginDb.pluginName,
					file: pluginDb.fileName,
					archivePath: pluginDb.archivePath
				});
			} catch (error) {
				skippedPlugins.push(`${pluginDb.pluginName}/${pluginDb.fileName} (${error.message})`);
			}
		}

		const manifest = {
			format: ARCHIVE_FORMAT,
			createdAt: new Date().toISOString(),
			coreDb: CORE_ARCHIVE_PATH,
			plugins: manifestPlugins
		};
		zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));

		zip.writeZip(archivePath);

		if (skippedPlugins.length) {
			console.warn(`[Backup] Skipped plugin databases: ${skippedPlugins.join(', ')}`);
		}

		return {
			archivePath,
			coreSize: fs.statSync(coreSnapshot).size,
			plugins: includedPlugins,
			skipped: skippedPlugins
		};
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}

/**
 * Extract a backup archive and describe its contents.
 * @param {string} zipPath
 * @param {string} outDir
 * @returns {{ coreDbPath: string, pluginDbs: Array<{ pluginName: string, fileName: string, extractedPath: string }>, manifest: object|null }}
 */
function extractBackupArchive(zipPath, outDir) {
	const zip = new AdmZip(zipPath);
	fs.mkdirSync(outDir, { recursive: true });
	zip.extractAllTo(outDir, true);

	let manifest = null;
	const manifestPath = path.join(outDir, 'manifest.json');
	if (fs.existsSync(manifestPath)) {
		try {
			manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		} catch {
			manifest = null;
		}
	}

	// Locate the core database
	let coreDbPath = null;
	if (manifest?.coreDb) {
		const candidate = path.join(outDir, manifest.coreDb);
		if (fs.existsSync(candidate)) coreDbPath = candidate;
	}
	if (!coreDbPath) {
		// Heuristic for manifest-less archives: prefer a file literally named
		// Database.db, else the largest .db in the tree.
		const dbFiles = [];
		const walk = dir => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.db$/i.test(entry.name)) dbFiles.push(full);
			}
		};
		walk(outDir);
		coreDbPath = dbFiles.find(f => path.basename(f).toLowerCase() === 'database.db')
			|| dbFiles.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
			|| null;
	}

	if (!coreDbPath) {
		throw new Error('No core database found inside backup archive');
	}

	// Plugin databases (only when we have a manifest describing them)
	const pluginDbs = [];
	if (manifest?.plugins?.length) {
		for (const entry of manifest.plugins) {
			const extractedPath = path.join(outDir, entry.archivePath || `plugins/${entry.plugin}/${entry.file}`);
			if (fs.existsSync(extractedPath)) {
				pluginDbs.push({ pluginName: entry.plugin, fileName: entry.file, extractedPath });
			}
		}
	}

	return { coreDbPath, pluginDbs, manifest };
}

/**
 * Restore plugin databases in place. Each file is validated, written to a temp
 * file next to the target and atomically renamed over it, then the WAL/SHM
 * sidecars are removed. Plugins that are not currently installed are skipped.
 * Assumes the bot restarts immediately afterwards (as the restore flow does).
 *
 * @param {Array<{ pluginName: string, fileName: string, extractedPath: string }>} pluginDbs
 * @returns {{ restored: string[], skipped: string[] }}
 */
function restorePluginDatabases(pluginDbs, pluginsDir = PLUGINS_DIR) {
	const restored = [];
	const skipped = [];

	for (const pluginDb of pluginDbs || []) {
		const pluginDir = path.join(pluginsDir, pluginDb.pluginName);
		if (!fs.existsSync(pluginDir)) {
			skipped.push(`${pluginDb.pluginName} (not installed)`);
			continue;
		}

		const check = checkIntegrity(pluginDb.extractedPath);
		if (!check.ok) {
			skipped.push(`${pluginDb.pluginName}/${pluginDb.fileName} (corrupt: ${check.detail})`);
			continue;
		}

		const targetPath = path.join(pluginDir, pluginDb.fileName);
		const tmpPath = `${targetPath}.restore-${Date.now()}`;
		try {
			fs.copyFileSync(pluginDb.extractedPath, tmpPath);
			fs.renameSync(tmpPath, targetPath); // atomic replace on the same filesystem
			for (const sidecar of ['-wal', '-shm', '-journal']) {
				try { fs.unlinkSync(`${targetPath}${sidecar}`); } catch { /* absent */ }
			}
			restored.push(`${pluginDb.pluginName}/${pluginDb.fileName}`);
		} catch (error) {
			try { fs.existsSync(tmpPath) && fs.unlinkSync(tmpPath); } catch { /* ignore */ }
			skipped.push(`${pluginDb.pluginName}/${pluginDb.fileName} (${error.message})`);
		}
	}

	if (skipped.length) {
		console.warn(`[Backup Restore] Plugin databases skipped: ${skipped.join(', ')}`);
	}

	return { restored, skipped };
}

module.exports = {
	CORE_DB_PATH,
	PLUGINS_DIR,
	TEMP_DIR,
	ARCHIVE_FORMAT,
	ensureTempDir,
	checkIntegrity,
	snapshotDatabase,
	discoverPluginDatabases,
	createBackupArchive,
	extractBackupArchive,
	restorePluginDatabases
};
