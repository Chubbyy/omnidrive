import {App, Notice, Plugin, request, requestUrl, TFile, TFolder} from 'obsidian';
import {DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab} from "./settings";

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	lastSyncTime: number = 0;
	autoSyncInteralRef: number | null = null;
	isSyncing: boolean = false;

	syncQueue: (() => Promise<void>)[] = [];
	isProcessingQueue: boolean = false;

	cachedAccessToken: string | null = null;
	tokenExpiration: number = 0;

	async onload() {
		await this.loadSettings();

		// Apply the CSS toggle based on saved settings when the app starts
		this.toggleIDVisibility();

		// This creates an icon in the left ribbon.
		this.addRibbonIcon('cloud', 'DriveSync: Manual Sync', async (evt: MouseEvent) => {
			if (this.isProcessingQueue || this.isSyncing) {
				new Notice('DriveSync: Sync already in progress.');
				return;
			}
			await this.syncVault();
		});

		this.app.workspace.onLayoutReady(() => {
			// Trigger 'catch-up' sync 3 seconds after Obsidian opens
			setTimeout(() => {
				this.syncVault();
			}, 3000);
		});

		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				const now = Date.now();

				if (now - this.lastSyncTime > 60000) {
					this.log('DriveSync: App brought to foreground. Triggerinng catch-up sync...');
					this.syncVault();
				}
			}
		})

		this.registerEvent(
			this.app.vault.on('create', async (file) => {
				this.enqueueTask(async () => {
					if (this.isPathIgnored(file.path)) return;
					if (file instanceof TFolder) {
						if (file.path === '/') return;

						if (this.settings.folderMap[file.path]) return;

						this.log(`DriveSync: Folder created locally. Uploading to Drive...`);
						
						const rootFolderID = this.settings.driveFolderID || await this.getCreateDriveFolder();
						const token = await this.getAccessToken();

						if (rootFolderID && token) {
							const dummyPath = `${file.path}/dummy.txt`;
							await this.getTargetFolderID(dummyPath, rootFolderID, token);
							this.log(`DriveSync: Successfully uploaded folder ${file.name}`);
						}
					}
				});
			})
		);

		this.registerEvent(
			this.app.vault.on('rename', async (file, oldPath) => {
				this.enqueueTask(async () => {
					if (this.isPathIgnored(file.path)) {
						const isHistoric = this.settings.syncStrategy === 'historic';
						let driveIDToKill = this.settings.attachmentMap[oldPath] || this.settings.folderMap[oldPath];
						let drivesyncIDToKill = this.settings.mdFileMap[oldPath];

						if (driveIDToKill || drivesyncIDToKill) {
							this.log(`DriveSync: Item moved to ignored folder (${file.path}). Queuing for cloud deletion...`);

							if (!isHistoric && driveIDToKill) this.settings.tombstones.push(driveIDToKill);
							if (!isHistoric && drivesyncIDToKill) this.settings.tombstones.push(drivesyncIDToKill);

							delete this.settings.folderMap[oldPath];
							delete this.settings.attachmentMap[oldPath];
							delete this.settings.mdFileMap[oldPath];
							delete this.settings.mdDriveMap[oldPath];
							await this.saveSettings();
						}
						return;
					}

					this.log(`DriveSync: Rename event detected. Old path: ${oldPath}, New name: ${file.name}`);

					if (file instanceof TFolder) {
						this.log(`DriveSync: Folder rename detected. Cascading path updates for children...`);
						let mapsUpdated = false;

						const driveFolderID = this.settings.folderMap[oldPath];
						if (driveFolderID) {
							const token = await this.getAccessToken();
							if (token) {
								try {
									await requestUrl({
										url: `https://www.googleapis.com/drive/v3/files/${driveFolderID}`,
										method: 'PATCH',
										headers: {
											'Authorization': `Bearer ${token}`,
											'Content-Type': 'application/json',
										},
										body: JSON.stringify({ name: file.name }),
									});
									this.log(`DriveSync: Renamed folder in Drive to ${file.name}`);
								} catch (error) {
									console.error("Failed to rename folder in folder in Drive:", error);
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
							this.log(`DriveSync: Cascade completed.`)
						}
						return;
					}

					const attachmentDriveID = this.settings.attachmentMap[oldPath];
					if (attachmentDriveID) {
						this.log(`DriveSync: Found attachment ID in directory.`);
						this.settings.attachmentMap[file.path] = attachmentDriveID;
						delete this.settings.attachmentMap[oldPath];
						await this.saveSettings();

						const token = await this.getAccessToken();
						if (token) {
							try {
								await requestUrl({
									url: `https://www.googleapis.com/drive/v3/files/${attachmentDriveID}`,
									method: 'PATCH',
									headers: { 
										'Authorization': `Bearer ${token}`, 
										'Content-Type': 'application/json' 
									},
									body: JSON.stringify({ name: file.name })
								});
								this.log(`DriveSync: Renamed attachment in Drive to ${file.name}`);
							} catch (error) { console.error(error); }
						}
						return;
					}

					if (file instanceof TFile && file.extension === 'md') {
						this.log(`DriveSync: Processing Markdown rename...`);
						
						let driveFileID = this.settings.mdDriveMap[oldPath];
						let drivesyncID = this.settings.mdFileMap[oldPath];

						if (driveFileID) {
							this.settings.mdDriveMap[file.path] = driveFileID;
							delete this.settings.mdDriveMap[oldPath];
						}
						if (drivesyncID) {
							this.settings.mdFileMap[file.path] = drivesyncID;
							delete this.settings.mdFileMap[oldPath];
						}
						await this.saveSettings();

						if (!driveFileID) {
							this.log('DriveSync: File not tracked in memory. Waiting for background sync to heal index.');
							return;
						}

						const token = await this.getAccessToken();
						if (!token) return; 

						try {
							await requestUrl ({
								url: `https://www.googleapis.com/drive/v3/files/${driveFileID}`,
								method: 'PATCH',
								headers: {
									'Authorization': `Bearer ${token}`,
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({name: file.name}),
							});
							this.log(`DriveSync: Renamed MD file in Drive to ${file.name}`);
						} catch (error) {
							console.error("Failed to remove MD file in Drive:", error);
						}
					}
				});
			})
		);

		this.registerEvent(
			this.app.vault.on('delete', async (file) => {
				this.enqueueTask(async () => {
					if (this.isPathIgnored(file.path)) return;
					const isHistoric = this.settings.syncStrategy === 'historic';

					if (file instanceof TFolder) {
						let mapsUpdated = false;

						const driveFolderID = this.settings.folderMap[file.path];
						if (driveFolderID) {
							if (!isHistoric) this.settings.tombstones.push(driveFolderID);
							delete this.settings.folderMap[file.path];
							mapsUpdated = true;
						}

						const sweepMap = (map: Record<string, string>, addToGraveyard: boolean) => {
							for (const key of Object.keys(map)) {
								if (key.startsWith(file.path + '/')) {
									if (!isHistoric && addToGraveyard) {
										this.settings.tombstones.push(map[key] as string);
									}
									delete map[key];
									mapsUpdated = true;
								}
							}
						};

						sweepMap(this.settings.attachmentMap, true);
						sweepMap(this.settings.mdFileMap, true);
						sweepMap(this.settings.mdDriveMap, false); 
						sweepMap(this.settings.syncState, false);
						sweepMap(this.settings.folderMap, false);

						if (mapsUpdated) {
							await this.saveSettings();
							if (!isHistoric) {
								this.log(`DriveSync: Cascaded folder deletion to graveyard -> ${file.path}`);
							}
						}
						return;
					}

					let driveIDToKill = this.settings.attachmentMap[file.path];
					let drivesyncIDToKill = this.settings.mdFileMap[file.path];

					if (driveIDToKill) {
						if (!isHistoric) this.settings.tombstones.push(driveIDToKill);
						delete this.settings.attachmentMap[file.path];
					}

					if (drivesyncIDToKill) {
						if (!isHistoric) this.settings.tombstones.push(drivesyncIDToKill);
						delete this.settings.mdFileMap[file.path];
					}

					if (driveIDToKill || drivesyncIDToKill) {
						await this.saveSettings();
						if (!isHistoric) {
						this.log(`DriveSync: Added [${file.path}] to graveyard.`);
						}
					}
				});
			})
		)

		this.addCommand({
			id: 'test-google-drive-ping',
			name: 'Test Google Drive Connection',
			callback: () => {
				this.testDriveConnection();
			}
		});

		this.addCommand({
			id: 'sync-active-file',
			name: 'Sync Active File',
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice('No active file to sync.');
					return;
				}
				if (this.isPathIgnored(activeFile.path)) {
					new Notice('DriveSync: This file is in an ignored folder.');
					return;
				}
				
				this.enqueueTask(async () => {
					new Notice(`DriveSync: Syncing ${activeFile.name}...`);
					if (activeFile.extension === 'md') {
						await this.syncFile(activeFile);
					} else if (!activeFile.path.startsWith('.')) {
						await this.syncAttachment(activeFile);
					}
					new Notice(`DriveSync: Finished syncing ${activeFile.name}`);
				});
			}
		});

		this.addCommand({
			id: 'rebuild-index',
			name: 'Rebuild Index',
			callback: async () => {
				await this.rebuildIndex();
			}
		});

		this.addCommand({
			id: 'setup-drive-folder',
			name: 'Setup Google Drive Folder',
			callback: () => {
				this.getCreateDriveFolder();
			}
		});

		this.addCommand({
			id: 'test-file-hashing',
			name: 'Calculate Hash of Current File',
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

		this.startAutoSync();

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	log(message: string) {
		if (this.settings.debugLogging) {
			console.log(message);
		}
	}

	isPathIgnored(path: string): boolean {
		if (!this.settings.ignoredPaths) return false;
		
		// Split the string by commas, remove whitespace, and check if the file path starts with any of them
		const ignoredList = this.settings.ignoredPaths.split(',').map(p => p.trim()).filter(p => p.length > 0);
		for (const ignored of ignoredList) {
			if (path.startsWith(ignored)) return true;
		}
		return false;
	}

	enqueueTask(task: () => Promise<void>) {
		this.syncQueue.push(task);
		this.processQueue();
	}

	async processQueue() {
		if (this.isProcessingQueue) return;
		this.isProcessingQueue = true;

		while (this.syncQueue.length > 0) {
			const task = this.syncQueue.shift();
			if (task) {
				try {
					await task();
					// Avoiding Google API 429 rate limiting
					await new Promise(resolve => setTimeout(resolve, 100));
				} catch (error: any) {
					console.error("DriveSync: Queue task failed:", error);
					
					// Surface Drive quota errors to the user
					if (error.message?.includes('403') || error.status === 403 || error.toString().includes('Quota')) {
						new Notice('DriveSync ERROR: Your Google Drive storage is full!', 10000);
					}
					
					await new Promise(resolve => setTimeout(resolve, 500));
				}
			}
		}
		this.isProcessingQueue = false;
	}

	async rebuildIndex() {
		new Notice('DriveSync: Wiping tracking database and rebuilding index...');
		this.settings.mdFileMap = {};
		this.settings.mdDriveMap = {};
		this.settings.attachmentMap = {};
		this.settings.folderMap = {};
		this.settings.syncState = {};
		this.settings.tombstones = [];
		await this.saveSettings();
		await this.syncVault();
	}

	startAutoSync() {
		if (this.autoSyncInteralRef) {
			window.clearInterval(this.autoSyncInteralRef);
			this.autoSyncInteralRef = null;
		}
		
		if (this.settings.autoSyncInterval <= 0) return;

		const intervalMs = this.settings.autoSyncInterval * 60 * 1000;

		this.autoSyncInteralRef = window.setInterval(() => {
			this.log(`DriveSync: Running scheduled auto-sync (${this.settings.autoSyncInterval} min)...`);

			this.syncVault(true);
		}, intervalMs);

		this.registerInterval(this.autoSyncInteralRef);
	}

	onunload() {
		// Clean up the CSS class if the plugin is turned off
		document.body.classList.remove('drivesync-hide-id');
		document.body.classList.remove('drivesync-hide-all-properties')
	}

	toggleIDVisibility() {
		if (this.settings.hideIDProperty) {
			document.body.classList.add('drivesync-hide-id');
		} else {
			document.body.classList.remove('drivesync-hide-id');
		}

		if (this.settings.hideAllProperties) {
			document.body.classList.add('drivesync-hide-all-properties');
		} else {
			document.body.classList.remove('drivesync-hide-all-properties')
		}
	}

	authenticateGoogle() {
		if (!this.settings.clientID || !this.settings.clientSecret) {
			new Notice('Please enter both Client ID and Client Secret first.')
			return;
		}

		const http = require('http');
		const server = http.createServer(async (req: any, res: any) => {
			try {
				if (!req.url) return;

				const url = new URL(req.url, 'http://127.0.0.1:8420');

				if (url.pathname === '/callback') {
					const code = url.searchParams.get('code');

					if (code) {
						await this.exchangeCodeForTokens(code);

						res.writeHead(200, {'Content-Type': 'text/html' });
						res.end('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px;">Authentication Successful!</h1><p style="font-family:sans-serif; text-align:center;">DriveSync is securely connected. You can close this tab and return to Obsidian.</p>')
					} else {
						res.writeHead(400, {'Content-Type': 'text/html'});
						res.end('<h1 style="font-family:sans-serif; text-align:center; margin-top:50px; color:red;">Authentication Failed</h1><p style="font-family:sans-serif; text-align:center;">No authorization code found.</p>')
					}

					server.close();
				}
			}
			catch (e) {
				console.error(e);
				res.writeHead(500);
				res.end('Internal Server Error');
				server.close()
			}
		});

		server.listen(8420, () => {
			const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${this.settings.clientID}&redirect_uri=http://127.0.0.1:8420/callback&response_type=code&access_type=offline&prompt=consent&scope=https://www.googleapis.com/auth/drive`;
			window.open(authUrl);
		});
	}

	async exchangeCodeForTokens(code: string) {
		try {
			const response = await requestUrl({
				url: 'https://oauth2.googleapis.com/token',
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded'},
				body: `code=${code}&client_id=${this.settings.clientID}&client_secret=${this.settings.clientSecret}&redirect_uri=http://127.0.0.1:8420/callback&grant_type=authorization_code`
			});

			const data = response.json;

			this.settings.refreshToken = data.refresh_token;
			await this.saveSettings();

			new Notice('DriveSync successfully connected to Google Drive.');

			await this.getCreateDriveFolder();
		} catch (error) {
			console.error('Token Exchange Error: ', error);
			new Notice('Failed to trade code for tokens. Check Developer Console.');
		}
	}

	async syncFile(file: TFile) {
		// Checking local DB first (fast)
		let drivesyncID = this.settings.mdFileMap[file.path];

		// Parse YAML only if we don't know the file (slow)
		if (!drivesyncID) {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				if (frontmatter['drivesync_id']) {
					drivesyncID = frontmatter['drivesync_id'];

					const existingPath = Object.keys(this.settings.mdFileMap).find(
						key => this.settings.mdFileMap[key] === drivesyncID
					);
					
					if (existingPath && existingPath !== file.path) {
						this.log(`DriveSync: Clone detected (${file.name}). Generating new unique ID...`);
						drivesyncID = window.crypto.randomUUID();
						frontmatter['drivesync_id'] = drivesyncID;
					}
				} else {
					const rememberedID = this.settings.mdFileMap[file.path];
					if (rememberedID) {
						this.log(`DriveSync: Restoring accidentally deleted YAML ID for ${file.name}`);
						drivesyncID = rememberedID;
					} else {
						drivesyncID = window.crypto.randomUUID();
					}
					frontmatter['drivesync_id'] = drivesyncID;
				}
			});
			// Save the newly discovered ID to the map
			this.settings.mdFileMap[file.path] = drivesyncID as string;
		}

		const folderID = this.settings.driveFolderID || await this.getCreateDriveFolder();
		if (!folderID) return;

		const token = await this.getAccessToken();
		if (!token) return;

		try {
			const localContent = await this.app.vault.read(file);
			const localHash = await this.calculateHash(localContent);
			const lastSyncHash = this.settings.syncState[drivesyncID as string];

			let driveFileID = this.settings.mdDriveMap[file.path];

			// Fallback Search (for legacy files)
			if (!driveFileID) {
				const searchResponse = await requestUrl({
					url: `https://www.googleapis.com/drive/v3/files?q=appProperties has { key='drivesync_id' and value='${drivesyncID}' } and trashed=false&fields=files(id)`,
					method: 'GET',
					headers: {'Authorization': `Bearer ${token}`},
				});
				const files = searchResponse.json.files;
				if (files && files.length > 0) {
					driveFileID = files[0].id;
					this.settings.mdDriveMap[file.path] = driveFileID as string;
					await this.saveSettings();
				}
			}

			// If it still doesn't have an ID, it is conclusively a new file--upload it
			if (!driveFileID) {
				const targetFolderID = await this.getTargetFolderID(file.path, folderID, token);
				const createResponse = await requestUrl({
					url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'multipart/related; boundary=foo_bar_baz',
					},
					body: `--foo_bar_baz\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({
						name: file.name,
						parents: [targetFolderID],
						appProperties: {drivesync_id: drivesyncID}
					})}\r\n--foo_bar_baz\r\nContent-Type: text/plain\r\n\r\n${localContent}\r\n--foo_bar_baz--`
				});

				this.settings.mdDriveMap[file.path] = createResponse.json.id;
				this.settings.syncState[drivesyncID as string] = localHash;
				await this.saveSettings();
				return;
			}

			const cloudResponse = await requestUrl({
				url: `https://www.googleapis.com/drive/v3/files/${driveFileID}?alt=media`,
				method: 'GET',
				headers: {'Authorization': `Bearer ${token}`},
			});

			const cloudContent = cloudResponse.text;
			const cloudHash = await this.calculateHash(cloudContent);

			if (localHash === cloudHash) {
				// same current state between local and cloud
			} else if (localHash === lastSyncHash && cloudHash !== lastSyncHash) {
				await this.app.vault.modify(file, cloudContent);
				this.settings.syncState[drivesyncID as string] = cloudHash;
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
				this.settings.syncState[drivesyncID as string] = localHash;
				await this.saveSettings();
			} else {
				new Notice(`Conflict detected in ${file.name}. Creating safe copy...`);

				const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
				const baseName = file.basename;
				const extension = file.extension;
				const conflictFileName = `${baseName} (Conflict ${timestamp}).${extension}`;
				const conflictFilePath = `${file.parent?.path === '/' ? '': file.parent?.path + '/'}${conflictFileName}`;

				// Rename the local file
				await this.app.fileManager.renameFile(file, conflictFilePath);

				// Download the cloud file
				const originalFilepath = `${file.parent?.path === '/' ? '' : file.parent?.path + '/'}${file.name}`;
				await this.app.vault.create(originalFilepath, cloudContent);

				// The downloaded file keeps the original identity
				this.settings.mdFileMap[originalFilepath] = drivesyncID as string;
				this.settings.mdDriveMap[originalFilepath] = driveFileID;
				this.settings.syncState[drivesyncID as string] = cloudHash;

				// The renamed conflict file loses its tracked identity (uploads as a brand new backup next time)
				delete this.settings.mdFileMap[conflictFilePath];
				delete this.settings.mdDriveMap[conflictFilePath];

				await this.saveSettings();
				console.warn(`DriveSync: Conflict resolved by duplicating ${file.name}`);
			}
		} catch (error) {
			console.error(`Sync Error on ${file.name}:`, error);
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
				if (chunkResponse.status === 403) throw new Error("403 Quota Exceeded");
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
			const currentMTime = file.stat.mtime.toString();
			const lastMTime = this.settings.syncState[file.path]; 

			let driveFileID = this.settings.attachmentMap[file.path];

			if (!driveFileID) {
				const binaryContent = await this.app.vault.readBinary(file);
				const targetFolderID = await this.getTargetFolderID(file.path, folderID, token);

				// If < 5MB, then do the quicker process through the standard API; otherwise, use the 'Resumable Upload' process
				if (binaryContent.byteLength > 5 * 1024 * 1024) {
					this.log(`DriveSync: Initiating massive file upload (${file.name})...`);
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

				this.settings.attachmentMap[file.path] = driveFileID as string;
				this.settings.syncState[file.path] = currentMTime;
				await this.saveSettings();
				this.log(`DriveSync: Uploaded new attachment: ${file.name}`);

			} else if (currentMTime !== lastMTime) {
				const binaryContent = await this.app.vault.readBinary(file);
				
				// Handle large files
				if (binaryContent.byteLength > 5 * 1024 * 1024) {
					this.log(`DriveSync: Initiating large file update (${file.name})...`);
					await this.resumableUpload(token, file.name, binaryContent, driveFileID, null);
				} else {
					// Standard API
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
				
				this.settings.syncState[file.path] = currentMTime;
				await this.saveSettings();
				this.log(`DriveSync: Updated attachment: ${file.name}`);
			}
		} catch (error) {
			console.error(`Attachment Sync Error on ${file.name}:`, error);
		}
	}

	async pullCloudChanges() {
		const rootFolderID = this.settings.driveFolderID;
		const token = await this.getAccessToken();
		if (!rootFolderID || !token) return;

		try {
			const foldersToSearch: {id: string, path: string}[] = [{id: rootFolderID, path: ""}];
			const cloudFiles: any[] = [];

			while (foldersToSearch.length > 0) {
				const current = foldersToSearch.shift();
				if (!current) continue;

				const currentFolderID = current.id;
				const currentPath = current.path;
				
				let pageToken: string | undefined = undefined;

				do {
					const query = encodeURIComponent(`'${currentFolderID}' in parents and trashed=false`);
					
					let url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=nextPageToken,files(id, name, mimeType, appProperties, parents)`;
					
					if (pageToken) {
						url += `&pageToken=${pageToken}`;
					}

					const search = await requestUrl({
						url: url,
						method: 'GET',
						headers: {'Authorization': `Bearer ${token}`},
					});

					const filesInFolder = search.json.files || [];
					
					pageToken = search.json.nextPageToken; 

					for (const file of filesInFolder) {
						if (file.mimeType === 'application/vnd.google-apps.folder') {
							const folderLocalPath = currentPath === "" ? file.name : `${currentPath}/${file.name}`;
							
							if (this.isPathIgnored(folderLocalPath)) continue;

							foldersToSearch.push({id: file.id, path: folderLocalPath});
							this.settings.folderMap[folderLocalPath] = file.id;
						} else {
							cloudFiles.push(file);
						}
					}
				} while (pageToken);
			}
			await this.saveSettings();

			this.log(`DriveSync RADAR: Crawl complete. Found ${cloudFiles.length} files.`);

			if (this.settings.syncStrategy === 'two-way') {
				const foundCloudIDs = cloudFiles.map(file => file.id);

				const sweepReverseGraveyard = async (map: Record<string, string>, isMarkdown: boolean) => {
					const pathsToKill: string[] = [];

					for (const [localPath, driveID] of Object.entries(map)) {
						if (!foundCloudIDs.includes(driveID) && !this.settings.tombstones.includes(driveID)) {
							pathsToKill.push(localPath);
						}
					}
					
					for (const path of pathsToKill) {
						const abstractFile = this.app.vault.getAbstractFileByPath(path);
						if (abstractFile) {
							this.log(`DriveSync: Remote deletion detected. Moving local file counterparts to system trash: ${path}`);
							await this.app.vault.trash(abstractFile, true);
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
				await sweepReverseGraveyard(this.settings.attachmentMap, true);
			}

			for (const cloudFile of cloudFiles) {
				const driveID = cloudFile.id;
				const vsID = cloudFile.appProperties?.drivesync_id;

				if (this.settings.tombstones.includes(driveID) || (vsID && this.settings.tombstones.includes(vsID))) {
					this.log(`DriveSync: Ghost file detected. Removing ${cloudFile.name} from Drive...`);

					try {
						await requestUrl({
							url: `https://www.googleapis.com/drive/v3/files/${driveID}`,
							method: 'DELETE',
							headers: {'Authorization': `Bearer ${token}`},
						});
					} catch (error) {
						console.error("Failed to delete ghost file:", error);
					}

					this.settings.tombstones = this.settings.tombstones.filter(id => id !== driveID && id !== vsID);
					await this.saveSettings();
					continue;
				}
				if (this.settings.syncStrategy === 'two-way') {
					if (vsID) {
						if (!Object.values(this.settings.mdFileMap).includes(vsID)) {
							this.log(`DriveSync: New .md file detected in Drive. Downloading ${cloudFile.name}...`);
							try {
								const dl = await requestUrl({
									url: `https://www.googleapis.com/drive/v3/files/${driveID}?alt=media`,
									headers: {'Authorization': `Bearer ${token}`},
								});

								let localPathPrefix = "";
								if (cloudFile.parents && cloudFile.parents.length > 0) {
									localPathPrefix = await this.getLocalPathFromDrive(cloudFile.parents[0], rootFolderID, token);
								}
								const fullLocalPath = localPathPrefix + cloudFile.name;

								if (this.isPathIgnored(fullLocalPath)) continue;

								await this.app.vault.create(fullLocalPath, dl.text);
								this.settings.mdFileMap[fullLocalPath] = vsID;

								this.settings.mdDriveMap[fullLocalPath] = driveID;
								
								this.settings.syncState[vsID] = await this.calculateHash(dl.text); 
								await this.saveSettings();
							} catch (e) { console.error(`Failed to download MD file ${cloudFile.name}:`, e); }
						}
					} else {
						if (!Object.values(this.settings.attachmentMap).includes(driveID)) {
							this.log(`DriveSync: New cloud attachment detected. Downloading ${cloudFile.name}...`);
							try {
								const dl = await requestUrl({
									url: `https://www.googleapis.com/drive/v3/files/${driveID}?alt=media`,
									headers: {'Authorization': `Bearer ${token}`},
								});

								let localPathPrefix = "";
								if (cloudFile.parents && cloudFile.parents.length > 0) {
									localPathPrefix = await this.getLocalPathFromDrive(cloudFile.parents[0], rootFolderID, token);
								}
								const fullLocalPath = localPathPrefix + cloudFile.name;

								if (this.isPathIgnored(fullLocalPath)) continue;

								const newFile = await this.app.vault.createBinary(fullLocalPath, dl.arrayBuffer);
								this.settings.attachmentMap[fullLocalPath] = driveID;
								
								this.settings.syncState[fullLocalPath] = newFile.stat.mtime.toString();
								await this.saveSettings();
							} catch (error) { 
								console.error(`Failed to download attachment ${cloudFile.name}:`, error); 
							}
						}
					}
				}
			}
			} catch (error) {
			console.error("Cloud Pull Error:", error);
			}
		}

	async syncVault(silent: boolean = false) {
		if (this.isSyncing) {
			this.log('DriveSync: Sync already in progress. Skipping duplicate request.');
			return;
		}

		this.isSyncing = true;
		this.lastSyncTime = Date.now();

		try {
			if (!silent) new Notice ('DriveSync: Starting background sync...');

			await this.pullCloudChanges();

			const allFiles = this.app.vault.getFiles();

			for (const file of allFiles) {
				if (this.isPathIgnored(file.path)) continue; 

				if (file.extension == 'md') {
					await this.syncFile(file);
				} else {
					if (!file.path.startsWith('.')) {
						this.syncAttachment(file);
					}
				}
			}
			if (!silent) new Notice('DriveSync: Vault syncing successfully completed.');
		} finally {
			this.isSyncing = false;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<MyPluginSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async getAccessToken(): Promise<string | null> {
		if (this.cachedAccessToken && Date.now() < this.tokenExpiration) {
			return this.cachedAccessToken;
		}

		if (!this.settings.refreshToken) {
			new Notice('No Refresh Token found. Please log in again.');
			return null;
		}

		try {
			const response = await requestUrl({
				url: 'https://oauth2.googleapis.com/token',
				method: 'POST',
				headers: {'Content-Type': 'application/x-www-form-urlencoded'},
				body: `client_id=${this.settings.clientID}&client_secret=${this.settings.clientSecret}&refresh_token=${this.settings.refreshToken}&grant_type=refresh_token`
			});

			this.cachedAccessToken = response.json.access_token;

			// Set expiration to 55 minutes since Google token expires after 60 minutes
			this.tokenExpiration = Date.now() + (55 * 60 * 1000);

			return this.cachedAccessToken;
		} catch (error) {
			console.error("Token Refresh Error: ", error);
			new Notice('Failed to generate Access Token. Check console.');
			return null;
		}
	}

	async scanForRemoteVaults(): Promise<{name: string, id: string, isCreateNew: boolean}[] | null> {
		const token = await this.getAccessToken();
		if (!token) return null;

		const masterFolderName = "DriveSync";

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
			new Notice("Failed to scan Drive for vaults.");
			return null;
		}
	}

	async getCreateDriveFolder(): Promise<string | null> {
		const token = await this.getAccessToken();
		if (!token) return null;

		const masterFolderName = "DriveSync";
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
				this.log('DriveSync: Creating main DriveSync directory...');
				const masterCreate = await requestUrl({
					url: 'https://www.googleapis.com/drive/v3/files',
					method: 'POST',
					headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: masterFolderName, mimeType: 'application/vnd.google-apps.folder' })
				});
				masterFolderID = masterCreate.json.id;
			}

			const vaultQuery = encodeURIComponent(`'${masterFolderID}' in parents and mimeType='application/vnd.google-apps.folder' and name='${vaultFolderName}' and trashed=false`);
			const vaultSearch = await requestUrl({
				url: `https://www.googleapis.com/drive/v3/files?q=${vaultQuery}&fields=files(id)`,
				method: 'GET',
				headers: {'Authorization': `Bearer ${token}`}
			});

			let vaultFolderID = "";
			if (vaultSearch.json.files && vaultSearch.json.files.length > 0) {
				vaultFolderID = vaultSearch.json.files[0].id;
			} else {
				this.log(`DriveSync: Creating subfolder for vault: ${vaultFolderName}...`);
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
			const query = encodeURIComponent(`'${currentParentID}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
			
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
					this.log(`DriveSync: Creating missing Drive folder (${folderName})`);
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
				console.error(`DriveSync: Error crawling Drive path for ${currentID}`, error);
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
					this.log(`DriveSync: Built missing local directory (${currentLocalPath})`);
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
			new Notice('Failed to ping Drive API. Check console.');
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