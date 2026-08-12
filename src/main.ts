import {Notice, Plugin, requestUrl, TFile, TFolder, Platform, TAbstractFile, Modal, App} from 'obsidian';
import {DEFAULT_SETTINGS, OmniDriveSettings, OmniDriveSettingTab} from "./settings";
interface OmniDriveOAuthServer {
	close(): void;
	on(event: 'error', listener: (err: any) => void): void;
	listen(port: number, callback: () => void): void;
}

class OmniDriveDebugLogModal extends Modal {
	logContent: string;
	constructor(app: App, logContent: string) {
		super(app);
		this.logContent = logContent;
	}
	onOpen() {
		const {contentEl} = this;
		contentEl.createEl('h3', {text: 'OmniDrive debug log'});
		const pre = contentEl.createEl('pre');
		pre.addClass('omnidrive-debug-log');
	}
	onClose() {
		this.contentEl.empty();
	}
}

export default class OmniDrive extends Plugin {
	declare settings: OmniDriveSettings;
	lastSyncTime: number = 0;
	autoSyncIntervalRef: number | null = null;
	isSyncing: boolean = false;

	syncQueue: (() => Promise<void>)[] = [];
	isProcessingQueue: boolean = false;
	driveFolderResolutionPromise: Promise<string | null> | null = null;

	cachedAccessToken: string | null = null;
	tokenExpiration: number = 0;

	oauthServer: OmniDriveOAuthServer | null = null;
	oauthState: string | null = null;
	settingTab: OmniDriveSettingTab | null = null;

	async onload() {
		await this.loadSettings();

		// Set the default remote vault name to match the local vault name
		if (this.settings.remoteVaultName === 'Main Vault' || this.settings.remoteVaultName === '') {
			this.settings.remoteVaultName = this.app.vault.getName();
			await this.saveSettings();
		}

		// Apply the CSS toggle based on saved settings when the app starts
		this.toggleIDVisibility();

		// This creates an icon in the left ribbon.
		this.addRibbonIcon('cloud', 'OmniDrive: manual sync', async (evt: MouseEvent) => {
			if (this.isProcessingQueue || this.isSyncing) {
				new Notice('OmniDrive: sync already in progress.');
				return;
			}
			await this.syncVault();
		});

		this.app.workspace.onLayoutReady(() => {
			// Trigger 'catch-up' sync 3 seconds after Obsidian opens
			window.setTimeout(() => {
				this.syncVault(true);
			}, 3000);

			this.registerDomEvent(document, 'visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					const now = Date.now();
					if (now - this.lastSyncTime > 60000) {
						this.log('OmniDrive: App brought to foreground. Triggering catch-up sync...');
						this.syncVault(true);
					}
				}
			});
		});

		this.registerEvent(
			this.app.vault.on('create', async (file) => {
				if (!this.settings.enableSync || !this.app.workspace.layoutReady) return;
				this.enqueueTask(async () => {
					if (this.isPathIgnored(file.path)) return;
					if (file instanceof TFolder) {
						if (file.path === '/') return;
						if (this.settings.folderMap[file.path]) return;

						this.log(`OmniDrive: Folder created locally. Uploading to Drive...`);
						const rootFolderID = this.settings.driveFolderID || await this.getCreateDriveFolder();
						const token = await this.getAccessToken();

						if (rootFolderID && token) {
							const dummyPath = `${file.path}/dummy.txt`;
							await this.getTargetFolderID(dummyPath, rootFolderID, token);
							this.log(`OmniDrive: Successfully uploaded folder ${file.name}`);
						}
					}
				});
			})
		);

		this.registerEvent(
			this.app.vault.on('rename', async (file, oldPath) => {
				if (!this.settings.enableSync) return;
				this.enqueueTask(async () => {
					if (this.isPathIgnored(file.path)) {
						const isHistoric = this.settings.syncStrategy === 'historic';
						const driveIDToKill = this.settings.attachmentMap[oldPath] || this.settings.folderMap[oldPath];
						const omnidriveIDToKill = this.settings.mdFileMap[oldPath];

						if (driveIDToKill || omnidriveIDToKill) {
							this.log(`OmniDrive: Item moved to ignored folder (${file.path}). Queuing for cloud deletion...`);
							if (!isHistoric && driveIDToKill) this.settings.tombstones.push(driveIDToKill);
							if (!isHistoric && omnidriveIDToKill) this.settings.tombstones.push(omnidriveIDToKill);
							delete this.settings.folderMap[oldPath];
							delete this.settings.attachmentMap[oldPath];
							delete this.settings.mdFileMap[oldPath];
							delete this.settings.mdDriveMap[oldPath];
							await this.saveSettings();
							return;
						}
					}

					this.log(`OmniDrive: Rename event detected. Old path: ${oldPath}, New name: ${file.name}`);

					if (file instanceof TFolder) {
						this.log(`OmniDrive: Folder rename detected. Cascading path updates for children...`);
						let mapsUpdated = false;

						const driveFolderID = this.settings.folderMap[oldPath];
						if (driveFolderID) {
							const token = await this.getAccessToken();
							if (token) {
								try {
									await this.moveOrRenameInDrive(driveFolderID, file, oldPath, token);
									this.log(`OmniDrive: Renamed/moved folder in Drive to ${file.name}`);
								} catch (error) {
									console.error("Failed to rename/move folder in Drive:", error);
								}
							}
						}

							const updatePaths = (map: Record<string, string>) => {
								for (const key of Object.keys(map)) {
									if (key === oldPath || key.startsWith(oldPath + '/')) {
										const newKey = file.path + key.substring(oldPath.length);
										map[newKey] = map[key] as string;
										delete map[key];
										mapsUpdated = true;
									}
								}
							};

							updatePaths(this.settings.attachmentMap);
							updatePaths(this.settings.mdFileMap);
							updatePaths(this.settings.mdDriveMap);
							updatePaths(this.settings.syncState);
							updatePaths(this.settings.folderMap);

							if (mapsUpdated) {
								await this.saveSettings();
								this.log(`OmniDrive: Cascade completed.`);
							}
						return;
					}

					const attachmentDriveID = this.settings.attachmentMap[oldPath];
					if (attachmentDriveID) {
						this.settings.attachmentMap[file.path] = attachmentDriveID;
						delete this.settings.attachmentMap[oldPath];
						
						if (this.settings.syncState[oldPath] !== undefined) {
							this.settings.syncState[file.path] = this.settings.syncState[oldPath];
							delete this.settings.syncState[oldPath];
						}
						await this.saveSettings();

						const token = await this.getAccessToken();
						if (token) {
							try {
								await this.moveOrRenameInDrive(attachmentDriveID, file, oldPath, token);
								this.log(`OmniDrive: Renamed/moved attachment in Drive to ${file.name}`);
							} catch (error) {
								console.error(error);
							}
						}
						return;
					}

					const trackedDriveFileID = this.settings.mdDriveMap[oldPath];
					if (trackedDriveFileID) {
						this.log(`OmniDrive: Processing tracked Markdown-identity rename...`);
						const omnidriveID = this.settings.mdFileMap[oldPath];

						this.settings.mdDriveMap[file.path] = trackedDriveFileID;
						delete this.settings.mdDriveMap[oldPath];

						if (omnidriveID) {
							this.settings.mdFileMap[file.path] = omnidriveID;
							delete this.settings.mdFileMap[oldPath];
						}
						await this.saveSettings();

						if (file instanceof TFile && file.extension !== 'md') {
							console.warn(`OmniDrive: ${file.name} lost its .md extension on rename. It will now be tracked as an attachment (mtime-based sync) instead of Markdown (hash-based sync).`);
						}

						const token = await this.getAccessToken();
						if (!token) return;

						try {
							await this.moveOrRenameInDrive(trackedDriveFileID, file, oldPath, token);
							this.log(`OmniDrive: Renamed/moved MD file in Drive to ${file.name}`);
						} catch (error) {
							console.error("Failed to rename/move MD file in Drive:", error);
						}
						return;
					}

					if (file instanceof TFile && file.extension === 'md') {
						this.log('OmniDrive: File not tracked in memory. Waiting for background sync to heal index.');
					}
				});
			})
		);

		this.registerEvent(
			this.app.vault.on('delete', async (file) => {
				if (!this.settings.enableSync) return;
				this.enqueueTask(async () => {
					if (this.isPathIgnored(file.path)) return;
					const isHistoric = this.settings.syncStrategy === 'historic';
					const token = await this.getAccessToken();

					if (file instanceof TFolder) {
						let mapsUpdated = false;
						let driveFolderID = this.settings.folderMap[file.path];

						// Fallback: not tracked locally doesn't mean it doesn't exist in Drive; handling accordingly
						if (!driveFolderID && token) {
							const parentPath = file.parent?.path === '/' ? '' : file.parent?.path;
							const parentID = (parentPath && this.settings.folderMap[parentPath]) || this.settings.driveFolderID;

							if (parentID) {
								try {
									const safeName = file.name.replace(/'/g, "\\'");
									const query = encodeURIComponent(`'${parentID}' in parents and name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
									const search = await requestUrl({
										url: `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`,
										method: 'GET',
										headers: {'Authorization': `Bearer ${token}`}
									});
									if (search.json.files?.length > 0) driveFolderID = search.json.files[0].id;
								} catch (e) { console.error("Fallback folder lookup failed:", e); }
							}
						}

						if (driveFolderID) {
							if (!isHistoric) {
								await this.deleteFromDriveOrTombstone(driveFolderID, token);
							}
							delete this.settings.folderMap[file.path];
							mapsUpdated = true;
						}

						const sweepMap = async (map: Record<string, string>, addToGraveyard: boolean) => {
							for (const key of Object.keys(map)) {
								if (key.startsWith(file.path + '/')) {
									if (!isHistoric && addToGraveyard) {
										await this.deleteFromDriveOrTombstone(map[key] as string, token);
									}
									delete map[key];
									mapsUpdated = true;
								}
							}
						};

						await sweepMap(this.settings.attachmentMap, true);
						await sweepMap(this.settings.mdFileMap, true);
						await sweepMap(this.settings.mdDriveMap, false); 
						await sweepMap(this.settings.syncState, false);
						await sweepMap(this.settings.folderMap, false);

						if (mapsUpdated) {
							await this.saveSettings();
						}
						return;
					}

					const driveIDToKill = this.settings.attachmentMap[file.path];
					const omnidriveIDToKill = this.settings.mdFileMap[file.path];

					if (driveIDToKill) {
						if (!isHistoric) {
							await this.deleteFromDriveOrTombstone(driveIDToKill, token);
						}
						delete this.settings.attachmentMap[file.path];
					}

					if (omnidriveIDToKill) {
						const actualDriveID = this.settings.mdDriveMap[file.path];
						if (!isHistoric) {
							if (actualDriveID) {
								await this.deleteFromDriveOrTombstone(actualDriveID, token);
							} else {
								// No known Drive ID for this file; still blacklist by omnidrive_id so it's recognized and cleaned up if it ever resurfaces in a future crawl
								this.settings.tombstones.push(omnidriveIDToKill);
							}
						}
						delete this.settings.mdFileMap[file.path];
						delete this.settings.mdDriveMap[file.path];
					}
				});
			})
		);

		this.addCommand({
			id: 'test-google-drive-ping',
			name: 'Test Google Drive connection',
			callback: () => {
				this.testDriveConnection();
			}
		});

		this.addCommand({
			id: 'sync-active-file',
			name: 'Sync active file',
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice('No active file to sync.');
					return;
				}
				if (this.isPathIgnored(activeFile.path)) {
					new Notice('OmniDrive: this file is in an ignored folder.');
					return;
				}
				
				this.enqueueTask(async () => {
					new Notice(`OmniDrive: Syncing ${activeFile.name}...`);
					if (activeFile.extension === 'md') {
						await this.syncFile(activeFile);
					} else if (!activeFile.path.startsWith('.')) {
						await this.syncAttachment(activeFile);
					}
					new Notice(`OmniDrive: Finished syncing ${activeFile.name}`);
				});
			}
		});

		this.addCommand({
			id: 'rebuild-index',
			name: 'Rebuild index',
			callback: async () => {
				await this.rebuildIndex();
			}
		});

		this.addCommand({
			id: 'setup-drive-folder',
			name: 'Setup Google Drive folder',
			callback: () => {
				this.getCreateDriveFolder();
			}
		});

		this.addCommand({
			id: 'test-file-hashing',
			name: 'Calculate hash of current file',
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice('No file is open.');
					return;
				}

				const content = await this.app.vault.read(activeFile);
				const hash = await this.calculateHash(content);

				// Show preview for hash in the notice message, and show full hash in the console.
				new Notice(`File hash: ${hash.substring(0, 10)}...`);
				this.log(`Full hash for ${activeFile.name}: ${hash}`);
			}
		});

		this.addCommand({
			id: 'show-debug-log',
			name: 'Show debug log',
			callback: async () => {
				const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/omnidrive-debug.log`;
				let content = '(no log yet — enable debug logging, reproduce the issue, then run this again)';
				try {
					if (await this.app.vault.adapter.exists(path)) content = await this.app.vault.adapter.read(path);
				} catch (e) {
					content = `Failed to read log: ${String(e)}`;
				}
				new OmniDriveDebugLogModal(this.app, content).open();
			}
		});

		this.startAutoSync();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.settingTab = new OmniDriveSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
	}

	log(message: string) {
		if (this.settings.debugLogging) {
			console.debug(message);
		}
	}

	isPathIgnored(path: string): boolean {
		if (!this.settings.ignoredPaths) return false;
		const ignoredList = this.settings.ignoredPaths.split(',').map(p => p.trim().replace(/\/+$/, '')).filter(p => p.length > 0);
		for (const ignored of ignoredList) {
			if (path === ignored || path.startsWith(ignored + '/')) return true;
		}
		return false;
	}

	enqueueTask(task: () => Promise<void>) {
		this.syncQueue.push(task);
		this.processQueue();
	}

	async logToFile(message: string) {
		if (!this.settings.debugLogging) return;
		try {
			const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/omnidrive-debug.log`;
			const line = `[${new Date().toISOString()}] ${message}\n`;
			if (await this.app.vault.adapter.exists(path)) {
				await this.app.vault.adapter.append(path, line);
			} else {
				await this.app.vault.adapter.write(path, line);
			}
		} catch {
			// Best-effort only; logging must never break sync itself0
		}
	}

	async processQueue(): Promise<void> {
		if (this.isProcessingQueue) {
			// A loop is already draining the queue: wait for it to finish rather than trusting a stored promise reference
			while (this.isProcessingQueue) {
				await new Promise(resolve => window.setTimeout(resolve, 50));
			}
			return;
		}

		this.isProcessingQueue = true;
		try {
			while (this.syncQueue.length > 0) {
				const task = this.syncQueue.shift();
				if (task) {
					try {
						await task();
						// Avoiding Google API 429 rate limiting
						await new Promise(resolve => window.setTimeout(resolve, 100));
					} catch (error: any) {
						console.error("OmniDrive: Queue task failed:", error);
						// Surface Drive quota errors to the user
						if (error.message?.includes('403') || error.status === 403 || error.toString().includes('Quota')) {
							new Notice('OmniDrive error: Google Drive storage full or permission denied. Check console for details.', 10000);
						}
						await new Promise(resolve => window.setTimeout(resolve, 500));
					}
				}
			}
		} finally {
			this.isProcessingQueue = false;
		}
	}

	async rebuildIndex() {
		if (this.isSyncing || this.isProcessingQueue) {
			new Notice('OmniDrive: cannot rebuild index while a sync is already in progress.');
			return;
		}
		this.isSyncing = true;

		new Notice('OmniDrive: rebuilding index and pushing local files...');

		this.settings.syncState = {};
		this.settings.mdFileMap = {};
		this.settings.attachmentMap = {};
		this.settings.mdDriveMap = {};
		this.settings.folderMap = {};
		this.settings.tombstones = [];

		try {
			const token = await this.getAccessToken();
			if (token) {
				this.settings.driveFolderID = "";
				await this.getCreateDriveFolder();
			}

			await this.saveSettings();

			const allFiles = this.app.vault.getFiles();
			for (const file of allFiles) {
				if (this.isPathIgnored(file.path)) continue;
				this.enqueueTask(async () => {
					if (file.extension == 'md') {
						await this.syncFile(file);
					} else if (!file.path.startsWith('.')) {
						await this.syncAttachment(file);
					}
				});
			}
			await this.processQueue();
			new Notice('OmniDrive: rebuild complete. Architecture restored.');
		} catch (error) {
			console.error(error);
		} finally {
			this.isSyncing = false;
		}
	}

	startAutoSync() {
		if (this.autoSyncIntervalRef) {
			window.clearInterval(this.autoSyncIntervalRef);
			this.autoSyncIntervalRef = null;
		}
		
		if (this.settings.autoSyncInterval <= 0) return;

		const intervalMs = this.settings.autoSyncInterval * 60 * 1000;

		this.autoSyncIntervalRef = window.setInterval(() => {
			this.log(`OmniDrive: Running scheduled auto-sync (${this.settings.autoSyncInterval} min)...`);

			this.syncVault(true);
		}, intervalMs);

		this.registerInterval(this.autoSyncIntervalRef);
	}

	onunload() {
		// Clean up the CSS class if the plugin is turned off
		document.body.classList.remove('omnidrive-hide-id');
		document.body.classList.remove('omnidrive-hide-all-properties')

		if (this.oauthServer) {
			this.oauthServer.close();
			this.oauthServer = null;
		}
	}

	toggleIDVisibility() {
		if (this.settings.hideIDProperty) {
			document.body.classList.add('omnidrive-hide-id');
		} else {
			document.body.classList.remove('omnidrive-hide-id');
		}

		if (this.settings.hideAllProperties) {
			document.body.classList.add('omnidrive-hide-all-properties');
		} else {
			document.body.classList.remove('omnidrive-hide-all-properties')
		}
	}

	authenticateGoogle() {
		if (!this.settings.clientID || !this.settings.clientSecret) {
			new Notice('Please enter both client ID and client secret first.');
			return;
		}

		// Generate a secure random state (prevents CSRF: Cross-Site Request Forgery)
		this.oauthState = window.crypto.randomUUID();

		const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${this.settings.clientID}&redirect_uri=http://127.0.0.1:8420/callback&response_type=code&access_type=offline&prompt=consent&state=${this.oauthState}&scope=https://www.googleapis.com/auth/drive`;

		if (Platform.isDesktopApp) {
			const http = require('http');

			if (this.oauthServer) {
				this.oauthServer.close();
				this.oauthServer = null;
			}

			const server = http.createServer(async (req: any, res: any) => {
				try {
					if (!req.url) return;
					const url = new URL(req.url, 'http://127.0.0.1:8420');

					if (url.pathname === '/callback') {
						const code = url.searchParams.get('code');
						const returnedState = url.searchParams.get('state');

						if (returnedState !== this.oauthState) {
							res.writeHead(400, {'Content-Type': 'text/html'});
							res.end('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px; color:red;">Authentication Failed</h1><p style="font-family:sans-serif; text-align:center;">Security verification failed (State mismatch).</p>');
							server.close();
							this.oauthServer = null;
							return;
						}

						if (code) {
							await this.exchangeCodeForTokens(code);
							res.writeHead(200, {'Content-Type': 'text/html' });
							res.end('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px;">Authentication Successful!</h1><p style="font-family:sans-serif; text-align:center;">OmniDrive is securely connected. You can close this tab and return to Obsidian.</p>')
						} else {
							res.writeHead(400, {'Content-Type': 'text/html'});
							res.end('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px; color:red;">Authentication Failed</h1><p style="font-family:sans-serif; text-align:center;">No authorization code found.</p>')
						}
						server.close();
						this.oauthServer = null;
					}
				}
				catch (e) {
					console.error(e);
					res.writeHead(500);
					res.end('Internal Server Error');
					server.close();
					this.oauthServer = null;
				}
			});

			this.oauthServer = server;

			server.on('error', (err: any) => {
				new Notice(`OmniDrive: couldn't start local login server. Port 8420 may be in use.`);
				this.oauthServer = null;
			});

			server.listen(8420, () => {
				window.open(authUrl);
			});
		} else {
			new Notice('Opening browser. After authorizing, copy the url of the error page and paste it into the manual login setting below.', 10000);
			window.open(authUrl);
		}
	}

	async processManualAuth(authInput: string) {
		try {
			let code = authInput.trim();

			if (code.startsWith('http') || code.includes('code=')) {
				let returnedState: string | null = null;
				let extractedCode = '';

				try {
					const url = new URL(code);
					extractedCode = url.searchParams.get('code') || '';
					returnedState = url.searchParams.get('state');
				} catch {
					const rawCode = code.match(/code=([^&]+)/)?.[1];
					extractedCode = rawCode ? decodeURIComponent(rawCode) : '';
					returnedState = code.match(/state=([^&]+)/)?.[1] || null;
				}

				if (returnedState !== this.oauthState) {
					new Notice('OmniDrive: security verification failed (state mismatch). Please log in again.');
					return;
				}
				code = extractedCode;
			}

			if (!code || code.includes('http')) {
				new Notice('Invalid authorization code format.');
				return;
			}

			await this.exchangeCodeForTokens(code);
		} catch (e) {
			console.error("Manual Auth Error:", e);
			new Notice('Failed to process manual auth code.');
		}
	}

	async exchangeCodeForTokens(code: string) {
		try {
			const response = await requestUrl({
				url: 'https://oauth2.googleapis.com/token',
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded'},
				body: `code=${encodeURIComponent(code)}&client_id=${encodeURIComponent(this.settings.clientID)}&client_secret=${encodeURIComponent(this.settings.clientSecret)}&redirect_uri=http://127.0.0.1:8420/callback&grant_type=authorization_code`
			});

			const data = response.json;

			this.settings.refreshToken = data.refresh_token;
			await this.saveSettings();

			new Notice('OmniDrive successfully connected to Google Drive.');

			await this.getCreateDriveFolder();
		} catch (error) {
			console.error('Token Exchange Error: ', error);
			new Notice('Failed to trade code for tokens. Check developer console.');
		}
	}

	async syncFile(file: TFile) {
		// Checking local DB first (fast)
		let omnidriveID = this.settings.mdFileMap[file.path];

		// Parse YAML only if we don't know the file (slow)
		if (!omnidriveID) {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				if (frontmatter['omnidrive_id']) {
					omnidriveID = frontmatter['omnidrive_id'];
				} else {
					const rememberedID = this.settings.mdFileMap[file.path];
					if (rememberedID) {
						this.log(`OmniDrive: Restoring accidentally deleted YAML ID for ${file.name}`);
						omnidriveID = rememberedID;
					} else {
						omnidriveID = window.crypto.randomUUID();
						frontmatter['omnidrive_id'] = omnidriveID;
					}
				}
			});
			// Save the newly discovered ID to the map
			if (omnidriveID) this.settings.mdFileMap[file.path] = omnidriveID;
		}

		const existingPath = Object.keys(this.settings.mdFileMap).find(
			key => this.settings.mdFileMap[key] === omnidriveID
		);

		if (existingPath && existingPath !== file.path) {
			const oldFileStillExists = this.app.vault.getAbstractFileByPath(existingPath) !== null;
			if (oldFileStillExists) {
				// Found clone: two real files share the same ID.
				this.log(`OmniDrive: Clone detected (${file.name}). Generating new unique ID...`);
				omnidriveID = window.crypto.randomUUID();
				await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					frontmatter['omnidrive_id'] = omnidriveID;
				});
				this.settings.mdFileMap[file.path] = omnidriveID;
			} else {
				// Old path no longer exists locally; this is a move, not a clone.
				this.log(`OmniDrive: Detected moved file (${file.name}). Migrating tracking from ${existingPath}.`);
				const oldDriveID = this.settings.mdDriveMap[existingPath];
				if (oldDriveID) {
					this.settings.mdDriveMap[file.path] = oldDriveID;
					delete this.settings.mdDriveMap[existingPath];
				}
				delete this.settings.mdFileMap[existingPath];
				this.settings.mdFileMap[file.path] = omnidriveID as string;
			}
		}

		const folderID = this.settings.driveFolderID || await this.getCreateDriveFolder();
		if (!folderID) return;

		const token = await this.getAccessToken();
		if (!token) return;

		try {
			const localContent = await this.app.vault.read(file);
			const localHash = await this.calculateHash(localContent);
			const lastSyncHash = this.settings.syncState[omnidriveID as string];

			let driveFileID = this.settings.mdDriveMap[file.path];

			// Fallback Search (for legacy files)
			if (!driveFileID) {
				// Fetch explicitlyTrashed instead and only treat a match as gone if it was trashed directly, not just orphaned by a trashed ancestor
				const appPropsQuery = encodeURIComponent(`appProperties has { key='omnidrive_id' and value='${omnidriveID}' }`);
				const searchResponse = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files?q=${appPropsQuery}&fields=files(id,parents,explicitlyTrashed)`, method: 'GET', headers: {'Authorization': `Bearer ${token}`}, throw: false });
				const recoverableMatch = (searchResponse.status === 200 && searchResponse.json.files)
					? searchResponse.json.files.find((f: any) => !f.explicitlyTrashed)
					: null;

				if (recoverableMatch) {
					driveFileID = recoverableMatch.id;

					// Ensure the file is restored to the correct active folder if its parent was trashed
					const targetFolderID = await this.getTargetFolderID(file.path, folderID, token);
					const currentParents = recoverableMatch.parents || [];
					if (!currentParents.includes(targetFolderID)) {
						this.log(`OmniDrive: Restoring orphaned file ${file.name} to active Drive folder...`);
						const parentsToRemove = currentParents.filter((p: string) => p !== targetFolderID).join(',');
						let patchUrl = `https://www.googleapis.com/drive/v3/files/${driveFileID}?addParents=${targetFolderID}`;
						if (parentsToRemove) patchUrl += `&removeParents=${parentsToRemove}`;
						const reattachResponse = await requestUrl({
							url: patchUrl,
							method: 'PATCH',
							headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
							body: JSON.stringify({ trashed: false }),
							throw: false
						});
						if (reattachResponse.status < 200 || reattachResponse.status >= 300) {
							console.error(`OmniDrive: Failed to reattach orphaned file ${file.name} to its active folder (status ${reattachResponse.status}):`, reattachResponse.json || reattachResponse.text);
						}
					}
				} else {
					// Guard against duplicating a legacy file that already exists in Drive by name
					const targetFolderID = await this.getTargetFolderID(file.path, folderID, token);
					const safeName = file.name.replace(/'/g, "\\'");
					const nameSearch = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${targetFolderID}' in parents and name='${safeName}' and mimeType!='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)`, method: 'GET', headers: {'Authorization': `Bearer ${token}`}, throw: false });
					
					if (nameSearch.status === 200 && nameSearch.json.files && nameSearch.json.files.length > 0) {
						driveFileID = nameSearch.json.files[0].id;
						this.log(`OmniDrive: Found existing MD file by name in Drive, re-linking: ${file.name}`);
						await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveFileID}`, method: 'PATCH', headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({ appProperties: { omnidrive_id: omnidriveID } }), throw: false });
					}
				}

				if (driveFileID) {
					this.settings.mdDriveMap[file.path] = driveFileID;
					await this.saveSettings();
				}

				// If it still doesn't have an ID, it is conclusively a new file--upload it
				if (!driveFileID) {
					const targetFolderID = await this.getTargetFolderID(file.path, folderID, token);
					const boundary = 'omnidrive_boundary_' + window.crypto.randomUUID().replace(/-/g, '');
					const createResponse = await requestUrl({
						url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
						method: 'POST',
						headers: {
							'Authorization': `Bearer ${token}`,
							'Content-Type': `multipart/related; boundary=${boundary}`
						},
						body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: file.name, parents: [targetFolderID], appProperties: {omnidrive_id: omnidriveID} })}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${localContent}\r\n--${boundary}--`
					});

					this.settings.mdDriveMap[file.path] = createResponse.json.id;
					this.settings.syncState[omnidriveID as string] = localHash;
					await this.saveSettings();
					return;
				}
			}

			const cloudResponse = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveFileID}?alt=media`, method: 'GET', headers: {'Authorization': `Bearer ${token}`}, throw: false });
			
			if (cloudResponse.status === 404) {
				this.log(`OmniDrive: Missing/404 on ${file.name}. Healing Markdown index...`);
				delete this.settings.mdDriveMap[file.path];
				await this.saveSettings();
				await this.syncFile(file); // Self-Heal: Re-run as a new file!
				return;
			} else if (cloudResponse.status >= 400) {
				console.error(`OmniDrive: Transient error (status ${cloudResponse.status}) fetching ${file.name} from Drive. Skipping this cycle; will retry on next sync.`);
				return;
			}

			const cloudContent = cloudResponse.text;
			const cloudHash = await this.calculateHash(cloudContent);

			if (localHash === cloudHash) {
				// Same current state between local and cloud
				this.settings.syncState[omnidriveID as string] = localHash;
				await this.saveSettings();
			} else if (localHash === lastSyncHash && cloudHash !== lastSyncHash) {
				await this.app.vault.process(file, (data) => {
					return cloudContent;
				});

				if (!cloudContent.includes('omnidrive_id')) {
					this.log(`OmniDrive: Cloud copy of ${file.name} was missing its omnidrive_id. Re-injecting and re-pushing...`);
					await this.app.fileManager.processFrontMatter(file, (fm) => {
						fm['omnidrive_id'] = omnidriveID;
					});
					const healedContent = await this.app.vault.read(file);
					await requestUrl({
						url: `https://www.googleapis.com/upload/drive/v3/files/${driveFileID}?uploadType=media`,
						method: 'PATCH',
						headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain' },
						body: healedContent,
					});
					this.settings.syncState[omnidriveID as string] = await this.calculateHash(healedContent);
				} else {
					this.settings.syncState[omnidriveID as string] = cloudHash;
				}
				await this.saveSettings();
			} else if (localHash !== lastSyncHash && cloudHash === lastSyncHash) {
				await requestUrl({
					url: `https://www.googleapis.com/upload/drive/v3/files/${driveFileID}?uploadType=media`,
					method: 'PATCH',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'text/plain',
					},
					body: localContent,
				});
				this.settings.syncState[omnidriveID as string] = localHash;
				await this.saveSettings();
			} else {
				new Notice(`Conflict detected in ${file.name}. Saving cloud version as backup...`);
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
				const baseName = file.basename;
				const extension = file.extension;
				const conflictFileName = `${baseName} (Cloud Backup ${timestamp}).${extension}`;
				const conflictFilePath = `${file.parent?.path === '/' ? '' : file.parent?.path + '/'}${conflictFileName}`;
				
				await this.app.vault.create(conflictFilePath, cloudContent);
				
				await requestUrl({
					url: `https://www.googleapis.com/upload/drive/v3/files/${driveFileID}?uploadType=media`,
					method: 'PATCH',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'text/plain',
					},
					body: localContent,
				});
				
				this.settings.syncState[omnidriveID as string] = localHash;
				await this.saveSettings();
				console.warn(`OmniDrive: Conflict handled: Kept local version, saved cloud version as ${conflictFileName}`);
			}
		} catch (error: any) {
			console.error(`Sync Error on ${file.name}:`, error);
			await this.logToFile(`Sync Error on ${file.name}: ${error?.message ?? error}${error?.stack ? '\n' + error.stack : ''}`);
		}
	}

	async resumableUpload(token: string, fileName: string, binaryContent: ArrayBuffer, driveFileID: string | null, parentFolderID: string | null): Promise<string> {
		const url = driveFileID
			? `https://www.googleapis.com/upload/drive/v3/files/${driveFileID}?uploadType=resumable`
			: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`;

		const method = driveFileID ? 'PATCH' : 'POST';
		const metadata: any = {};
		
		if (!driveFileID) {
			metadata.name = fileName;
			metadata.parents = [parentFolderID];
		}

		const initResponse = await requestUrl({
			url: url,
			method: method,
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
				'X-Upload-Content-Length': binaryContent.byteLength.toString(),
			},
			body: JSON.stringify(metadata)
		});

		const uploadUrl = initResponse.headers['location'] || initResponse.headers['Location'];
		if (!uploadUrl) throw new Error("Failed to get resumable upload URL");

		// Breaking large file into 5MB chunks
		const chunkSize = 5 * 1024 * 1024; 
		let uploadedBytes = 0;
		let finalId = driveFileID;

		while (uploadedBytes < binaryContent.byteLength) {
			const end = Math.min(uploadedBytes + chunkSize, binaryContent.byteLength);
			const chunk = binaryContent.slice(uploadedBytes, end);

			const chunkResponse = await requestUrl({
				url: uploadUrl,
				method: 'PUT',
				throw: false, 
				headers: {
					'Content-Length': chunk.byteLength.toString(),
					'Content-Range': `bytes ${uploadedBytes}-${end - 1}/${binaryContent.byteLength}`
				},
				body: chunk
			});

			if (chunkResponse.status !== 308 && chunkResponse.status >= 400) {
				if (chunkResponse.status === 403) throw new Error("403 Forbidden / Quota Exceeded");
				throw new Error(`Chunk upload failed with status ${chunkResponse.status}`);
			}

			uploadedBytes = end;

			if (uploadedBytes >= binaryContent.byteLength && chunkResponse.status < 300) {
				if (!driveFileID) finalId = chunkResponse.json.id;
			}
		}

		if (!finalId) throw new Error("Upload completed but failed to retrieve File ID.");
		return finalId;
	}

async syncAttachment(file: TFile) {
		const folderID = this.settings.driveFolderID || await this.getCreateDriveFolder();
		if (!folderID) return;

		const token = await this.getAccessToken();
		if (!token) return;

		try {
			const currentLocalMTime = file.stat.mtime.toString();
			const state = this.settings.syncState[file.path] || "";
			const [lastLocalMTime, lastCloudMTime] = state.includes('|') ? state.split('|') : [state, ""];

			let driveFileID = this.settings.attachmentMap[file.path];

			if (!driveFileID) {
				const targetFolderID = await this.getTargetFolderID(file.path, folderID, token);

				// Protect against duplicating a file that already exists in Drive
				const safeName = file.name.replace(/'/g, "\\'");
				const searchQuery = encodeURIComponent(`'${targetFolderID}' in parents and name='${safeName}' and trashed=false`);
				const searchResponse = await requestUrl({
					url: `https://www.googleapis.com/drive/v3/files?q=${searchQuery}&fields=files(id,modifiedTime,size)`,
					method: 'GET',
					headers: {'Authorization': `Bearer ${token}`}
				});
				const existing = searchResponse.json.files;
				const sizeMatchedExisting = existing?.find((f: any) => Number(f.size) === file.stat.size);
				let verifiedMatch = false;

				if (sizeMatchedExisting) {
					this.log(`OmniDrive: Found a same-sized attachment in Drive for ${file.name}. Verifying content before linking...`);
					const dl = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${sizeMatchedExisting.id}?alt=media`, headers: {'Authorization': `Bearer ${token}`}, throw: false });

					if (dl.status === 200) {
						const localBuffer = await this.app.vault.readBinary(file);
						const [cloudHash, localHash] = await Promise.all([
							this.calculateBufferHash(dl.arrayBuffer),
							this.calculateBufferHash(localBuffer)
						]);

						if (cloudHash === localHash) {
							verifiedMatch = true;
							driveFileID = sizeMatchedExisting.id;
							const cloudMTime = new Date(sizeMatchedExisting.modifiedTime).getTime().toString();
							this.settings.attachmentMap[file.path] = driveFileID as string;
							this.settings.syncState[file.path] = `${currentLocalMTime}|${cloudMTime}`;
							await this.saveSettings();
							this.log(`OmniDrive: Verified matching content. Re-linked existing attachment: ${file.name}`);
						}
					}
				}

				if (!verifiedMatch) {
					if (existing && existing.length > 0) {
						this.log(`OmniDrive: Found a same-named file in Drive, but its content didn't match. Uploading as new.`);
					}
					const binaryContent = await this.app.vault.readBinary(file);

					if (binaryContent.byteLength > 5 * 1024 * 1024) {
						this.log(`OmniDrive: Initiating massive file upload (${file.name})...`);
						driveFileID = await this.resumableUpload(token, file.name, binaryContent, null, targetFolderID);
					} else {
						const createResponse = await requestUrl({
							url: 'https://www.googleapis.com/drive/v3/files',
							method: 'POST',
							headers: {
								'Authorization': `Bearer ${token}`,
								'Content-Type': 'application/json',
							},
							body: JSON.stringify({
								name: file.name,
								parents: [targetFolderID],
							})
						});
						driveFileID = createResponse.json.id;

						await requestUrl({
							url: `https://www.googleapis.com/upload/drive/v3/files/${driveFileID}?uploadType=media`,
							method: 'PATCH',
							headers: {
								'Authorization': `Bearer ${token}`,
								'Content-Type': 'application/octet-stream'
							},
							body: binaryContent,
						});
					}

					const metaRes = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveFileID}?fields=modifiedTime`, headers: {'Authorization': `Bearer ${token}`} });
					const currentCloudMTime = new Date(metaRes.json.modifiedTime).getTime().toString();

					this.settings.attachmentMap[file.path] = driveFileID as string;
					this.settings.syncState[file.path] = `${currentLocalMTime}|${currentCloudMTime}`;
					await this.saveSettings();
					this.log(`OmniDrive: Uploaded new attachment: ${file.name}`);
				}
			} else {
					const metaRes = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveFileID}?fields=modifiedTime`, method: 'GET', headers: {'Authorization': `Bearer ${token}`}, throw: false });
					
					if (metaRes.status === 404) {
						this.log(`OmniDrive: Missing/404 on attachment ${file.name}. Healing index...`);
						delete this.settings.attachmentMap[file.path];
						await this.saveSettings();
						await this.syncAttachment(file);
						return;
					} else if (metaRes.status >= 400) {
						console.error(`OmniDrive: Transient error (status ${metaRes.status}) fetching metadata for ${file.name} from Drive. Skipping this cycle; will retry on next sync.`);
						return;
					}
					
					const currentCloudMTime = new Date(metaRes.json.modifiedTime).getTime().toString();

				// Migrate legacy (pre-3-way) state
				if (lastCloudMTime === "") {
					this.settings.syncState[file.path] = `${currentLocalMTime}|${currentCloudMTime}`;
					await this.saveSettings();
					this.log(`OmniDrive: Migrated ${file.name} to 3-way attachment tracking.`);
					return;
				}

				const localChanged = currentLocalMTime !== lastLocalMTime;
				const cloudChanged = currentCloudMTime !== lastCloudMTime;

				if (!localChanged && !cloudChanged) {
					return; // In sync
				} else if (!localChanged && cloudChanged) {
					this.log(`OmniDrive: Cloud attachment changed. Downloading ${file.name}...`);
					const dl = await requestUrl({
						url: `https://www.googleapis.com/drive/v3/files/${driveFileID}?alt=media`,
						method: 'GET',
						headers: {'Authorization': `Bearer ${token}`}
					});
					await this.app.vault.modifyBinary(file, dl.arrayBuffer);
					const updatedFile = this.app.vault.getAbstractFileByPath(file.path);
					if (updatedFile instanceof TFile) {
						this.settings.syncState[file.path] = `${updatedFile.stat.mtime.toString()}|${currentCloudMTime}`;
						await this.saveSettings();
					}
				} else if (localChanged && !cloudChanged) {
					const binaryContent = await this.app.vault.readBinary(file);
					if (binaryContent.byteLength > 5 * 1024 * 1024) {
						this.log(`OmniDrive: Initiating large file update (${file.name})...`);
						await this.resumableUpload(token, file.name, binaryContent, driveFileID, null);
					} else {
						await requestUrl({
							url: `https://www.googleapis.com/upload/drive/v3/files/${driveFileID}?uploadType=media`,
							method: 'PATCH',
							headers: {
								'Authorization': `Bearer ${token}`,
								'Content-Type': 'application/octet-stream',
							},
							body: binaryContent,
						});
					}
					const metaRes = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveFileID}?fields=modifiedTime`, headers: {'Authorization': `Bearer ${token}`} });
					const newCloudMTime = new Date(metaRes.json.modifiedTime).getTime().toString();
					this.settings.syncState[file.path] = `${currentLocalMTime}|${newCloudMTime}`;
					await this.saveSettings();
					this.log(`OmniDrive: Updated attachment: ${file.name}`);
				} else {
					new Notice(`Conflict detected in ${file.name}. Saving cloud version as backup...`);
					const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
					const conflictFileName = `${file.basename} (Cloud Backup ${timestamp}).${file.extension}`;
					const conflictFilePath = `${file.parent?.path === '/' ? '' : file.parent?.path + '/'}${conflictFileName}`;

					const dl = await requestUrl({
						url: `https://www.googleapis.com/drive/v3/files/${driveFileID}?alt=media`,
						method: 'GET',
						headers: {'Authorization': `Bearer ${token}`}
					});
					await this.app.vault.createBinary(conflictFilePath, dl.arrayBuffer);

					const binaryContent = await this.app.vault.readBinary(file);
					if (binaryContent.byteLength > 5 * 1024 * 1024) {
						await this.resumableUpload(token, file.name, binaryContent, driveFileID, null);
					} else {
						await requestUrl({
							url: `https://www.googleapis.com/upload/drive/v3/files/${driveFileID}?uploadType=media`,
							method: 'PATCH',
							headers: {
								'Authorization': `Bearer ${token}`,
								'Content-Type': 'application/octet-stream',
							},
							body: binaryContent,
						});
					}
					const metaRes = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveFileID}?fields=modifiedTime`, headers: {'Authorization': `Bearer ${token}`} });
					const newCloudMTime = new Date(metaRes.json.modifiedTime).getTime().toString();
					this.settings.syncState[file.path] = `${currentLocalMTime}|${newCloudMTime}`;
					await this.saveSettings();
					console.warn(`OmniDrive: Conflict handled: Kept local version, saved cloud version as ${conflictFileName}`);
				}
			}
		} catch (error) {
			console.error(`Attachment Sync Error on ${file.name}:`, error);
		}
	}

	async pullCloudChanges(): Promise<boolean> {
		const rootFolderID = this.settings.driveFolderID;
		const token = await this.getAccessToken();
		if (!rootFolderID || !token) return false;

		try {
			const foldersToSearch: {id: string, path: string}[] = [{id: rootFolderID, path: ""}];
			const cloudFiles: {data: any, parentPath: string}[] = [];
			const foundFolderIDs = new Set<string>();

			while (foldersToSearch.length > 0) {
				const current = foldersToSearch.shift();
				if (!current) continue;
				let pageToken: string | undefined = undefined;

				do {
					const query = encodeURIComponent(`'${current.id}' in parents and trashed=false`);
					let url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=nextPageToken,files(id, name, mimeType, appProperties, parents, modifiedTime)`;
					if (pageToken) url += `&pageToken=${pageToken}`;

					const search = await requestUrl({ url: url, method: 'GET', headers: {'Authorization': `Bearer ${token}`}, throw: false });

					if (search.status < 200 || search.status >= 300) {
						console.error(`OmniDrive: Folder listing failed for ${current.id} (status ${search.status}).`);
						await this.logToFile(`Folder listing failed for ${current.id} (status ${search.status})`);
						return false;
					}

					const filesInFolder = search.json.files || [];
					pageToken = search.json.nextPageToken;

					for (const file of filesInFolder) {
						if (file.mimeType === 'application/vnd.google-apps.folder') {
							const folderLocalPath = current.path === "" ? file.name : `${current.path}/${file.name}`;
							if (this.isPathIgnored(folderLocalPath)) continue;
							foldersToSearch.push({id: file.id, path: folderLocalPath});
							
							const knownFolderPath = Object.keys(this.settings.folderMap).find(p => this.settings.folderMap[p] === file.id);
							if (knownFolderPath && knownFolderPath !== folderLocalPath) {
								if (this.settings.syncStrategy === 'two-way') {
									this.log(`OmniDrive: Remote folder rename detected. Renaming locally...`);
									const abstractFolder = this.app.vault.getAbstractFileByPath(knownFolderPath);
									if (abstractFolder) {
										const parentDir = folderLocalPath.includes('/') ? folderLocalPath.substring(0, folderLocalPath.lastIndexOf('/')) : "";
										if (parentDir) await this.ensureLocalDirectoryExists(parentDir);
										try {
											await this.app.fileManager.renameFile(abstractFolder, folderLocalPath);
											delete this.settings.folderMap[knownFolderPath];
											this.settings.folderMap[folderLocalPath] = file.id;
										} catch(e) {
											console.warn(`OmniDrive: Failed to locally rename folder to ${folderLocalPath}`, e);
										}
									}
								} else {
									this.log(`OmniDrive: Drive-side folder rename ignored (${this.settings.syncStrategy} mode): ${knownFolderPath}`);
								}
							} else if (!knownFolderPath) {
								this.settings.folderMap[folderLocalPath] = file.id;
							}
							foundFolderIDs.add(file.id);
						} else {
							cloudFiles.push({data: file, parentPath: current.path});
						}
					}
				} while (pageToken);
			}

			// A folder that no longer shows up in the crawl is dead; clear its cached ID so future uploads re-search/recreate instead of targeting a parent that's gone
			const lostFolderPaths: string[] = [];
			for (const [localPath, driveID] of Object.entries(this.settings.folderMap)) {
				if (!foundFolderIDs.has(driveID)) {
					lostFolderPaths.push(localPath);
					delete this.settings.folderMap[localPath];
				}
			}

			await this.saveSettings();
			this.log(`OmniDrive RADAR: Crawl complete. Found ${cloudFiles.length} files.`);

			const foundCloudIDs = cloudFiles.map(c => c.data.id);

			if (this.settings.syncStrategy === 'two-way') {
				const isOrphanedByLostFolder = (path: string) => lostFolderPaths.some(folderPath => path.startsWith(folderPath + '/'));

				const sweepReverseGraveyard = async (map: Record<string, string>, isMarkdown: boolean) => {
					const pathsToKill: string[] = [];
					for (const [localPath, driveID] of Object.entries(map)) {
						if (!foundCloudIDs.includes(driveID) && !this.settings.tombstones.includes(driveID)) {
							if (isOrphanedByLostFolder(localPath)) {
								this.log(`OmniDrive: ${localPath}'s parent folder vanished from Drive; unlinking (not deleting) so the next pass can re-verify.`);
								if (isMarkdown) delete this.settings.mdDriveMap[localPath];
								else delete this.settings.attachmentMap[localPath];
								continue;
							}
							pathsToKill.push(localPath);
						}
					}
					if (pathsToKill.length > 0 && Object.keys(map).length > 0 && pathsToKill.length >= Math.max(3, Object.keys(map).length * 0.8)) {
						this.log("OmniDrive: Remote deletion detected. Aborting local wipe and forcing re-upload.");
						for (const path of pathsToKill) {
							if (isMarkdown) delete this.settings.mdDriveMap[path];
							else delete this.settings.attachmentMap[path];
						}
						return;
					}
					for (const path of pathsToKill) {
						const abstractFile = this.app.vault.getAbstractFileByPath(path);
						if (abstractFile) {
							this.log(`OmniDrive: Remote deletion detected. Moving local file counterparts to system trash: ${path}`);
							await this.app.fileManager.trashFile(abstractFile);
						}
						if (isMarkdown) {
							const vsID = this.settings.mdFileMap[path];
							if (vsID) delete this.settings.syncState[vsID];
							delete this.settings.mdFileMap[path];
							delete this.settings.mdDriveMap[path];
						} else {
							delete this.settings.syncState[path];
							delete this.settings.attachmentMap[path];
						}
					}
				};

				await sweepReverseGraveyard(this.settings.mdDriveMap, true);
				await sweepReverseGraveyard(this.settings.attachmentMap, false);
			} else {
				// Local is the source of truth, so if a tracked file vanished from Drive (deleted or trashed), clear its mapping so it gets pushed again in this sync.
				const reuploadStale = (map: Record<string, string>) => {
					const stale = Object.entries(map).filter(([, driveID]) =>
						!foundCloudIDs.includes(driveID) && !this.settings.tombstones.includes(driveID)
					);
					if (stale.length > 0 && Object.keys(map).length > 0 && stale.length >= Math.max(3, Object.keys(map).length * 0.8)) {
						this.log("OmniDrive: Large portion of tracked files missing from Drive — likely a crawl issue, not real deletions. Skipping mass re-push this cycle.");
						return;
					}
					for (const [localPath] of stale) {
						delete map[localPath];
						this.log(`OmniDrive: ${localPath} missing from Drive. Will re-push this sync.`);
					}
				};
				reuploadStale(this.settings.mdDriveMap);
				reuploadStale(this.settings.attachmentMap);
			}

			for (const cloudItem of cloudFiles) {
				try {
					const cloudFile = cloudItem.data;
					const driveID = cloudFile.id;
					const vsID = cloudFile.appProperties?.omnidrive_id;

					// Drive doesn't require file extensions. 
					// If a rename dropped the extension entirely, assume it was accidental and keep whatever extension this file was already tracked with, 
					// rather than treating it as an intentional type change.
					let effectiveCloudName = cloudFile.name;
					let healedMissingExtension = false;
					if (!cloudFile.name.includes('.')) {
						const previousPath = Object.keys(this.settings.mdDriveMap).find(p => this.settings.mdDriveMap[p] === driveID)
							|| Object.keys(this.settings.attachmentMap).find(p => this.settings.attachmentMap[p] === driveID);
						if (previousPath) {
							const previousName = previousPath.substring(previousPath.lastIndexOf('/') + 1);
							const dotIndex = previousName.lastIndexOf('.');
							if (dotIndex > 0) {
								effectiveCloudName = cloudFile.name + previousName.substring(dotIndex);
								healedMissingExtension = true;
								this.log(`OmniDrive: Drive name "${cloudFile.name}" has no extension. Treating it as "${effectiveCloudName}" (its last known extension).`);
							}
						}
					}

					const fullLocalPath = cloudItem.parentPath === "" ? effectiveCloudName : `${cloudItem.parentPath}/${effectiveCloudName}`;

					if (this.settings.tombstones.includes(driveID) || (vsID && this.settings.tombstones.includes(vsID))) {
						this.log(`OmniDrive: Ghost file detected. Removing ${cloudFile.name} from Drive...`);
						const delResponse = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveID}`, method: 'DELETE', headers: {'Authorization': `Bearer ${token}`}, throw: false });
						
						if (delResponse.status >= 400) {
							console.error(`Failed to delete ghost file ${cloudFile.name} (status ${delResponse.status}):`, delResponse.json || delResponse.text);
						} else {
							this.settings.tombstones = this.settings.tombstones.filter(id => id !== driveID && id !== vsID);
						}
						
						await this.saveSettings();
						continue;
					}

					const isMarkdown = effectiveCloudName.endsWith('.md');
					let knownPath = null;
					let wasMarkdown = isMarkdown;

					if (isMarkdown) {
						knownPath = Object.keys(this.settings.mdDriveMap).find(p => this.settings.mdDriveMap[p] === driveID);
						if (!knownPath) {
							knownPath = Object.keys(this.settings.attachmentMap).find(p => this.settings.attachmentMap[p] === driveID);
							wasMarkdown = false;
						}
					} else {
						knownPath = Object.keys(this.settings.attachmentMap).find(p => this.settings.attachmentMap[p] === driveID);
						if (!knownPath) {
							knownPath = Object.keys(this.settings.mdDriveMap).find(p => this.settings.mdDriveMap[p] === driveID);
							wasMarkdown = true;
						}
					}

					if (knownPath && knownPath !== fullLocalPath && !this.isPathIgnored(fullLocalPath)) {
						if (this.settings.syncStrategy === 'two-way') {
							if (wasMarkdown !== isMarkdown) {
								console.warn(`OmniDrive: Drive rename of "${knownPath}" to "${fullLocalPath}" would change its type (Markdown ↔ attachment). Skipping automatic mirror to avoid corrupting the file — rename it back to a matching extension in Drive, or rename the local file directly, to resolve.`);
								continue;
							}
							this.log(`OmniDrive: Remote file rename detected. Renaming locally from ${knownPath} to ${fullLocalPath}...`);
							const abstractFile = this.app.vault.getAbstractFileByPath(knownPath);
							if (abstractFile) {
								if (cloudItem.parentPath) await this.ensureLocalDirectoryExists(cloudItem.parentPath);
								try {
									await this.app.fileManager.renameFile(abstractFile, fullLocalPath);

									if (wasMarkdown) {
										delete this.settings.mdDriveMap[knownPath];
										delete this.settings.mdFileMap[knownPath];
									} else {
										delete this.settings.attachmentMap[knownPath];
									}

									if (isMarkdown) {
										this.settings.mdDriveMap[fullLocalPath] = driveID;
										if (vsID) this.settings.mdFileMap[fullLocalPath] = vsID;
									} else {
										this.settings.attachmentMap[fullLocalPath] = driveID;
									}

									if (this.settings.syncState[knownPath]) {
										this.settings.syncState[fullLocalPath] = this.settings.syncState[knownPath] as string;
										delete this.settings.syncState[knownPath];
									}
									await this.saveSettings();

									if (healedMissingExtension) {
										try {
											await this.moveOrRenameInDrive(driveID, abstractFile, knownPath, token);
										} catch (e) {
											console.warn(`OmniDrive: Renamed locally, but failed to push the corrected extension back to Drive for ${fullLocalPath}.`, e);
										}
									}
								} catch(e) {
									console.warn(`OmniDrive: Failed to locally rename file to ${fullLocalPath}`, e);
								}
							}
						} else {
							this.log(`OmniDrive: Drive-side rename ignored (${this.settings.syncStrategy} mode): ${knownPath}`);
						}
					}

					if (this.settings.syncStrategy === 'two-way') {
						if (isMarkdown) {
							const alreadyTracked = Object.values(this.settings.mdDriveMap).includes(driveID);
							const alreadyLocal = this.app.vault.getAbstractFileByPath(fullLocalPath) !== null;

							if (!alreadyTracked && !alreadyLocal) {
								this.log(`OmniDrive: New .md file detected in Drive. Downloading ${cloudFile.name}...`);
								if (this.isPathIgnored(fullLocalPath)) continue;
								const dl = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveID}?alt=media`, headers: {'Authorization': `Bearer ${token}`}, throw: false });
								if (dl.status === 200) {
									if (cloudItem.parentPath) await this.ensureLocalDirectoryExists(cloudItem.parentPath);
									const newFile = await this.app.vault.create(fullLocalPath, dl.text);
									
									if (vsID) {
										// Drive object already carries our ID (e.g., a retried patch); rare occurrence. Link immediately
										this.settings.mdFileMap[fullLocalPath] = vsID;
										this.settings.mdDriveMap[fullLocalPath] = driveID;
										this.settings.syncState[vsID] = await this.calculateHash(dl.text);
										await this.saveSettings();
									} else {
										// User manually uploaded this file to Drive, so it lacks an ID. Give it one, push it to Drive (metadata + body), and only record a
										// syncState baseline if BOTH pushes actually succeeded. If either fails, leave syncState unset; next sync will then see a real
										// mismatch and route through normal conflict handling (backs up the cloud copy) instead of silently losing the ID
										const newID = window.crypto.randomUUID();
										await this.app.fileManager.processFrontMatter(newFile, (fm) => {
											fm['omnidrive_id'] = newID;
										});

										const updatedContent = await this.app.vault.read(newFile);

										const metaPatch = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveID}`, method: 'PATCH', headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({ appProperties: { omnidrive_id: newID } }), throw: false });
										const contentPatch = await requestUrl({ url: `https://www.googleapis.com/upload/drive/v3/files/${driveID}?uploadType=media`, method: 'PATCH', headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'text/plain'}, body: updatedContent, throw: false });

										this.settings.mdFileMap[fullLocalPath] = newID;
										this.settings.mdDriveMap[fullLocalPath] = driveID;

										if (metaPatch.status >= 200 && metaPatch.status < 300 && contentPatch.status >= 200 && contentPatch.status < 300) {
											this.settings.syncState[newID] = await this.calculateHash(updatedContent);
										} else {
											console.error(`OmniDrive: Failed to push omnidrive_id back to Drive for ${newFile.name} (meta: ${metaPatch.status}, content: ${contentPatch.status}).`);
										}
										await this.saveSettings();
									}
								}
							}
						} else if (!isMarkdown) {
							const alreadyTrackedAttachment = Object.values(this.settings.attachmentMap).includes(driveID);
							const alreadyLocalAttachment = this.app.vault.getAbstractFileByPath(fullLocalPath) !== null;
							
							if (!alreadyTrackedAttachment) {
								if (alreadyLocalAttachment) {
									this.log(`OmniDrive: Untracked local file already exists at ${fullLocalPath}. Skipping download; will be linked during outbound sync.`);
								} else {
									this.log(`OmniDrive: New cloud attachment detected. Downloading ${cloudFile.name}...`);
									if (this.isPathIgnored(fullLocalPath)) continue;
									try {
										const dl = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveID}?alt=media`, headers: {'Authorization': `Bearer ${token}`}, throw: false });
										if (dl.status === 200) {
											if (cloudItem.parentPath) await this.ensureLocalDirectoryExists(cloudItem.parentPath);
											const newFile = await this.app.vault.createBinary(fullLocalPath, dl.arrayBuffer);
											const currentCloudMTime = cloudFile.modifiedTime ? new Date(cloudFile.modifiedTime).getTime().toString() : "";
											this.settings.attachmentMap[fullLocalPath] = driveID;
											this.settings.syncState[fullLocalPath] = `${newFile.stat.mtime.toString()}|${currentCloudMTime}`;
											await this.saveSettings();
										}
									} catch (e) {
										console.error(`OmniDrive: Failed to download new attachment ${cloudFile.name}:`, e);
									}
								}
							}
						}
					}
				} catch (itemError) {
					console.error(`OmniDrive: Failed processing cloud item ${cloudItem.data.name}:`, itemError);
					await this.logToFile(`Failed processing cloud item ${cloudItem.data.name}: ${String(itemError)}`);
					continue;
				}
			}
		return true;
		} catch (error) {
			console.error("Cloud Pull Error:", error);
			await this.logToFile(`Cloud Pull Error: ${(error as any)?.message ?? error}${(error as any)?.stack ? '\n' + (error as any).stack : ''}`);
			return false;
		}
	}

	async syncVault(silent: boolean = false) {
		if (!this.settings.enableSync) {
			if (!silent) new Notice('OmniDrive: attempt to sync canceled; sync is currently paused in settings.');
			return;
		}

		if (this.isSyncing) {
			this.log('OmniDrive: Sync already in progress. Skipping duplicate request.');
			return;
		}

		this.isSyncing = true;

		try {
			if (!silent) new Notice('OmniDrive: starting background sync...');

			const token = await this.getAccessToken();
			if (!token) {
				this.isSyncing = false;
				return;
			}

			const folderState = await this.verifyRemoteFolder(token);

			if (folderState === 'error') {
				this.log('OmniDrive: Could not verify remote folder (network/API error). Aborting this cycle to protect local index.');
				if (!silent) new Notice('OmniDrive: sync failed. Could not reach Google Drive.');
				this.isSyncing = false;
				return;
			}

			if (folderState === 'missing') {
				this.log('OmniDrive: Remote folder missing. Rebuilding cloud architecture...');
				this.settings.driveFolderID = "";
				this.settings.syncState = {};
				this.settings.mdFileMap = {};
				this.settings.attachmentMap = {};
				this.settings.mdDriveMap = {};
				this.settings.folderMap = {};
				await this.saveSettings();
				await this.getCreateDriveFolder();
			}

			// Run the radar scan and let it FULLY finish before snapshotting local files; otherwise, anything it just pulled from Drive won't get pushed back/reconciled
			// until the next sync cycle.
			let pullSucceeded = true;
			this.enqueueTask(async () => {
				pullSucceeded = await this.pullCloudChanges();
			});
			await this.processQueue();

			if (!pullSucceeded) {
				this.log('OmniDrive: Cloud pull failed (likely a connectivity issue). Skipping file sync this cycle.');
				if (!silent) new Notice('OmniDrive: sync incomplete; could not reach Google Drive. Will retry next cycle.', 6000);
				return;
			}

			const allFiles = this.app.vault.getFiles();

			for (const file of allFiles) {
				if (this.isPathIgnored(file.path)) continue;
				this.enqueueTask(async () => {
					if (file.extension == 'md') {
						await this.syncFile(file);
					} else if (!file.path.startsWith('.')) {
						await this.syncAttachment(file);
					}
				});
			}
			await this.processQueue();

			if (!silent) new Notice('OmniDrive: vault syncing successfully completed.');

		} catch (error) {
			console.error("OmniDrive: Sync error", error);
		} finally {
			this.isSyncing = false;
			this.lastSyncTime = Date.now();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<OmniDriveSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async getAccessToken(): Promise<string | null> {
		if (this.cachedAccessToken && Date.now() < this.tokenExpiration) {
			return this.cachedAccessToken;
		}

		if (!this.settings.refreshToken) {
			new Notice('No refresh token found. Please log in again.');
			return null;
		}

		try {
				const response = await requestUrl({
					url: 'https://oauth2.googleapis.com/token',
					method: 'POST',
					headers: {'Content-Type': 'application/x-www-form-urlencoded'},
					body: `client_id=${encodeURIComponent(this.settings.clientID)}&client_secret=${encodeURIComponent(this.settings.clientSecret)}&refresh_token=${encodeURIComponent(this.settings.refreshToken)}&grant_type=refresh_token`,
					throw: false
				});

				if (response.status !== 200) {
					if (response.json?.error === 'invalid_grant') {
						this.log("OmniDrive: Refresh token invalid or expired. Clearing token.");
						this.settings.refreshToken = '';
						await this.saveSettings();
						new Notice('OmniDrive: your google login has expired or was revoked. Reconnect via settings → OmniDrive → login with google.', 10000);
					} else {
						console.error("Token Refresh Error: ", response.json || response);
						new Notice('Failed to generate access token. Check console.');
					}
					return null;
				}

				this.cachedAccessToken = response.json.access_token;
				// Set expiration to 55 minutes because Google token expires after 60 minutes
				this.tokenExpiration = Date.now() + (55 * 60 * 1000);
				return this.cachedAccessToken;
			} catch (error) {
				console.error("Token Refresh Error: ", error);
				new Notice('Failed to generate access token. Check console.');
				return null;
			}
	}

	async scanForRemoteVaults(): Promise<{name: string, id: string, isCreateNew: boolean}[] | null> {
		const token = await this.getAccessToken();
		if (!token) return null;

		const masterFolderName = "OmniDrive";

		try {
			const masterQuery = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${masterFolderName}' and trashed=false`);
			
			const masterSearch = await requestUrl({
				url: `https://www.googleapis.com/drive/v3/files?q=${masterQuery}&fields=files(id)`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`
				},
			});

			if (!masterSearch.json.files || masterSearch.json.files.length == 0) {
				return [];
			}

			const masterFolderID = masterSearch.json.files[0].id;
			const vaultQuery = encodeURIComponent(`'${masterFolderID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
			
			const vaultSearch = await requestUrl({
				url: `https://www.googleapis.com/drive/v3/files?q=${vaultQuery}&fields=files(id,name)`,
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`,
				},
			});

			const vaults = vaultSearch.json.files || [];
			return vaults.map((v: any) => ({name: v.name, id: v.id, isCreateNew: false}));
		} catch (error) {
			console.error("Vault Scan Error:", error);
			new Notice("Failed to scan drive for vaults.");
			return null;
		}
	}

	async getCreateDriveFolder(): Promise<string | null> {
		if (this.driveFolderResolutionPromise) return this.driveFolderResolutionPromise;
		this.driveFolderResolutionPromise = this._getCreateDriveFolder();
		try {
			return await this.driveFolderResolutionPromise;
		} finally {
			this.driveFolderResolutionPromise = null;
		}
	}

	private async _getCreateDriveFolder(): Promise<string | null> {
		const token = await this.getAccessToken();
		if (!token) return null;

		const masterFolderName = "OmniDrive";
		const vaultFolderName = this.settings.remoteVaultName || "Main Vault";
		let masterFolderID = "";

		try {
			const masterQuery = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${masterFolderName}' and trashed=false`);
			const masterSearch = await requestUrl({
				url: `https://www.googleapis.com/drive/v3/files?q=${masterQuery}&fields=files(id)`,
				method: 'GET',
				headers: {'Authorization': `Bearer ${token}`}
			});

			if (masterSearch.json.files && masterSearch.json.files.length > 0) {
				masterFolderID = masterSearch.json.files[0].id;
			} else {
				this.log('OmniDrive: Creating main OmniDrive directory...');
				const masterCreate = await requestUrl({
					url: 'https://www.googleapis.com/drive/v3/files',
					method: 'POST',
					headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: masterFolderName, mimeType: 'application/vnd.google-apps.folder' })
				});
				masterFolderID = masterCreate.json.id;
			}

			const safeVaultName = vaultFolderName.replace(/'/g, "\\'");
			const vaultQuery = encodeURIComponent(`'${masterFolderID}' in parents and mimeType='application/vnd.google-apps.folder' and name='${safeVaultName}' and trashed=false`);			const vaultSearch = await requestUrl({
				url: `https://www.googleapis.com/drive/v3/files?q=${vaultQuery}&fields=files(id)`,
				method: 'GET',
				headers: {'Authorization': `Bearer ${token}`}
			});

			let vaultFolderID = "";
			if (vaultSearch.json.files && vaultSearch.json.files.length > 0) {
				vaultFolderID = vaultSearch.json.files[0].id;
			} else {
				this.log(`OmniDrive: Creating sub-folder for vault: ${vaultFolderName}...`);
				const vaultCreate = await requestUrl({
					url: 'https://www.googleapis.com/drive/v3/files',
					method: 'POST',
					headers: { 
						'Authorization': `Bearer ${token}`, 
						'Content-Type': 'application/json' 
					},
					body: JSON.stringify({ 
						name: vaultFolderName, 
						parents: [masterFolderID], 
						mimeType: 'application/vnd.google-apps.folder' 
					})
				});
				vaultFolderID = vaultCreate.json.id;
			}

			this.settings.driveFolderID = vaultFolderID;
			await this.saveSettings();

			return vaultFolderID;

		} catch (error) {
			console.error('Folder Creation Error:', error);
			new Notice('Failed to locate or create Google Drive folders. Check console.');
			return null;
		}
	}

	async getTargetFolderID(filePath: string, rootFolderID: string, token: string): Promise<string> {
		const parts = filePath.split('/');
		if (parts.length === 1) return rootFolderID;

		const folderNames = parts.slice(0, -1);
		let currentParentID = rootFolderID;
		let currentLocalPath = "";

		for (const folderName of folderNames) {
			currentLocalPath += (currentLocalPath === "" ? "" : "/") + folderName;
			if (this.settings.folderMap[currentLocalPath]) {
				currentParentID = this.settings.folderMap[currentLocalPath] as string;
				continue;
			}
			const safeFolderName = folderName.replace(/'/g, "\\'");
			const query = encodeURIComponent(`'${currentParentID}' in parents and name='${safeFolderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);			
			try {
				const searchResponse = await requestUrl({
					url: `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`,
					method: 'GET',
					headers: {'Authorization': `Bearer ${token}`},
				});

				const files = searchResponse.json.files;

				if (files && files.length > 0) {
					currentParentID = files[0].id;
					this.settings.folderMap[currentLocalPath] = currentParentID;
					await this.saveSettings();
				} else {
					this.log(`OmniDrive: Creating missing Drive folder (${folderName})`);
					const createResponse = await requestUrl({
						url: 'https://www.googleapis.com/drive/v3/files',
						method: 'POST',
						headers: {
							'Authorization': `Bearer ${token}`,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({
							name: folderName,
							parents: [currentParentID],
							mimeType: 'application/vnd.google-apps.folder',
						}),
					});

					currentParentID = createResponse.json.id;
					this.settings.folderMap[currentLocalPath] = currentParentID;
					await this.saveSettings();

					}
				} catch (error) {
					console.error(`Error Mapping Folder ${folderName}:`, error);
					return rootFolderID;
			}
		}
		return currentParentID;
	}

	async getLocalPathFromDrive(parentID: string, rootFolderID: string, token: string): Promise<string> {
		let currentID = parentID;
		const pathParts: {name: string, id: string}[] = [];
		let depth = 0;

		while (currentID && currentID !== rootFolderID && depth < 20) {
			try {
				const response = await requestUrl({
					url: `https://www.googleapis.com/drive/v3/files/${currentID}?fields=id,name,parents`,
					method: 'GET',
					headers: {'Authorization': `Bearer ${token}`},
				});

				const folderData = response.json;
				pathParts.unshift({name: folderData.name, id: currentID});

				if (folderData.parents && folderData.parents.length > 0) {
					currentID = folderData.parents[0];
				} else {
					break;
				}
			} catch (error) {
				console.error(`OmniDrive: Error crawling Drive path for ${currentID}`, error);
			}
			depth++;
		}
		if (pathParts.length === 0) return "";

		let currentLocalPath = "";

		for (const part of pathParts) {
			currentLocalPath += (currentLocalPath === "" ? "" : "/") + part.name;

			this.settings.folderMap[currentLocalPath] = part.id;

			const abstractFile = this.app.vault.getAbstractFileByPath(currentLocalPath);
			if (!abstractFile) {
				try {
					await this.app.vault.createFolder(currentLocalPath);
					this.log(`OmniDrive: Built missing local directory (${currentLocalPath})`);
				} catch {
					continue;
				}
			}
		}
		return currentLocalPath + "/";
	}

	async testDriveConnection() {
		new Notice('Pinging Google Drive...');

		const token = await this.getAccessToken();
		if (!token) return;

		try {
			const response = await requestUrl({
				url: 'https://www.googleapis.com/drive/v3/about?fields=user',
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${token}`
				}
			});

			const userName = response.json.user.displayName;
			const userEmail = response.json.user.emailAddress;

			new Notice(`Successfully connected to Drive as:\n${userName} (${userEmail})`);
		} catch (error) {
			console.error("Drive API Error:", error);
			new Notice('Failed to ping drive API. Check console.');
		}
	}

	async verifyRemoteFolder(token: string): Promise<'valid' | 'missing' | 'error'> {
		if (!this.settings.driveFolderID) return 'missing';
		try {
			const response = await requestUrl({
				url: `https://www.googleapis.com/drive/v3/files/${this.settings.driveFolderID}?fields=id,trashed`,
				method: 'GET',
				headers: {'Authorization': `Bearer ${token}`},
				throw: false
			});
			if (response.status === 404) return 'missing';
			if (response.status < 200 || response.status >= 300) return 'error'; // 401/403/429/5xx
			if (response.json.trashed) return 'missing';
			return 'valid';
		} catch (error) {
			return 'error';
		}
	}

	async ensureLocalDirectoryExists(dir: string) {
		if (!dir) return;
		const parts = dir.split('/');
		let current = "";
		for (const part of parts) {
			current += (current === "" ? "" : "/") + part;
			const folder = this.app.vault.getAbstractFileByPath(current);
			if (!folder) {
				try { await this.app.vault.createFolder(current); } catch (e) { /* Ignore: Folder already exists */ }
			}
		}
	}

	async deleteFromDriveOrTombstone(driveID: string, token: string | null) {
		if (!token) { this.settings.tombstones.push(driveID); return; }
		try {
			const response = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveID}`, method: 'DELETE', headers: {'Authorization': `Bearer ${token}`}, throw: false });
			// 404 means it's already gone; success, not failure
			if (response.status >= 400 && response.status !== 404) {
				this.settings.tombstones.push(driveID);
			}
		} catch (e) {
			this.settings.tombstones.push(driveID);
		}
	}

	async moveOrRenameInDrive(driveID: string, file: TAbstractFile, oldPath: string, token: string) {
		const oldParentPath = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : "";
		const newParentPath = file.parent?.path === '/' ? "" : (file.parent?.path ?? "");
		let patchUrl = `https://www.googleapis.com/drive/v3/files/${driveID}`;
		const queryParams = [];

		if (oldParentPath !== newParentPath) {
			const rootFolderID = this.settings.driveFolderID || await this.getCreateDriveFolder();
			if (rootFolderID) {
				const newParentID = await this.getTargetFolderID(file.path, rootFolderID, token);
				const meta = await requestUrl({ url: `https://www.googleapis.com/drive/v3/files/${driveID}?fields=parents`, method: 'GET', headers: {'Authorization': `Bearer ${token}`}, throw: false });
				
				if (meta.status === 200) {
					const parentsArray = meta.json.parents || [];
					const parentsToRemove = parentsArray.filter((p: string) => p !== newParentID).join(',');
					if (parentsToRemove) queryParams.push(`removeParents=${parentsToRemove}`);
					if (!parentsArray.includes(newParentID)) queryParams.push(`addParents=${newParentID}`);
				}
			}
		}

		if (queryParams.length > 0) patchUrl += `?${queryParams.join('&')}`;

		const renameResponse = await requestUrl({ url: patchUrl, method: 'PATCH', headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({ name: file.name }), throw: false });
    	if (renameResponse.status < 200 || renameResponse.status >= 300) {
    		throw new Error(`Drive rename/move failed with status ${renameResponse.status}`);
    	}
	}

	async calculateHash(text: string): Promise<string> {
		const msgBuffer = new TextEncoder().encode(text);

		const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);

		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

		return hashHex;
	}

	async calculateBufferHash(buffer: ArrayBuffer): Promise<string> {
		const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}
}