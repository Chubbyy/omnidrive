import {App, Notice, PluginSettingTab, Setting, SuggestModal} from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
	hideIDProperty: boolean;
	clientID: string;
	clientSecret: string;
	refreshToken: string;
	driveFolderID: string;
	remoteVaultName: string;
	syncState: Record<string, string>;
	attachmentMap: Record<string, string>;
	mdFileMap: Record<string, string>;
	mdDriveMap: Record<string, string>;
	folderMap: Record<string, string>;
	tombstones: string[];
	autoSyncInterval: number;
	syncStrategy: string;
	debugLogging: boolean;
	ignoredPaths: string;
	hideAllProperties: boolean;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	hideIDProperty: true,
	clientID: '',
	clientSecret: '',
	refreshToken: '',
	driveFolderID: '',
	remoteVaultName: 'Main Vault',
	syncState: {},
	attachmentMap: {},
	mdFileMap: {},
	mdDriveMap: {},
	folderMap: {},
	tombstones: [],
	autoSyncInterval: 5,
	syncStrategy: 'two-way',
	debugLogging: false,
	ignoredPaths: '',
	hideAllProperties: false,
}

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Hide DriveSync ID')
			.setDesc('Hide the DriveSync ID from the Properties table at the top of your files (reopen file to take effect).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideIDProperty)
				.onChange(async (value) => {
					this.plugin.settings.hideIDProperty = value;
					await this.plugin.saveSettings();
					this.plugin.toggleIDVisibility();
				})
			)
		
		new Setting(containerEl)
			.setName('Hide Properties Table')
			.setDesc("Completely hide the properties table at the top of all files for a cleaner look (reopen file to take effect).")
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.hideAllProperties)
				.onChange(async (value) => {
					this.plugin.settings.hideAllProperties = value;
					await this.plugin.saveSettings();
					this.plugin.toggleIDVisibility();
				})
			)

		new Setting(containerEl)
			.setName('Sync Strategy')
			.setDesc('Two-Way: Mirrors all changes. One-Way Backup: Only pushes local files to Drive. Historic Archive: Only pushes local files, but never deletes files in Drive.')
			.addDropdown(dropdown => dropdown
				.addOption('two-way', 'Two-Way Mirror')
				.addOption('one-way', 'One-Way Backup')
				.addOption('historic', 'Historic Archive')
				.setValue(this.plugin.settings.syncStrategy)
				.onChange(async (value) => {
					this.plugin.settings.syncStrategy = value;
					await this.plugin.saveSettings();
				})
			)
		new Setting(containerEl)
			.setName('Ignored Folders')
			.setDesc('Comma-separated list of folders to completely ignore (e.g., Private, Templates/Work).')
			.addText(text => text
				.setPlaceholder('Assets, Private, ...')
				.setValue(this.plugin.settings.ignoredPaths)
				.onChange(async (value) => {
					this.plugin.settings.ignoredPaths = value;
					await this.plugin.saveSettings();
				})
			)
		
		new Setting(containerEl)
			.setName('Auto-Sync Interval (Minutes)')
			.setDesc('How often should DriveSync automatically sync in the background? Set to 0 to disable auto-sync.')
			.addText(text => text
				.setPlaceholder('5')
				.setValue(String(this.plugin.settings.autoSyncInterval))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 0) {
						this.plugin.settings.autoSyncInterval = parsed;
						await this.plugin.saveSettings();

						this.plugin.startAutoSync();
					}
				})
			)
		
		new Setting(containerEl)
			.setName('Remote Vault Connection')
			.setDesc(`Currently connected to: [ ${this.plugin.settings.remoteVaultName || "None"} ]. Click to scan Google Drive and link this device to an existing vault, or create a new one.`)
			.addButton(button => button
				.setButtonText('Select Remote Vault')
				.setCta()
				.onClick(async () => {
					button.setButtonText('Scanning...');
					const vaults = await this.plugin.scanForRemoteVaults();
					button.setButtonText('Select Remote Vault');
					
					if (vaults !== null) {
						new VaultSuggestModal(this.app, this.plugin, vaults).open();
					}
				})
			)
		
		new Setting(containerEl)
			.setName('Google Client ID')
			.setDesc('Paste the Client ID from your Google Cloud Console.')
			.addText(text => text
				.setPlaceholder('Enter Client ID...')
				.setValue(this.plugin.settings.clientID)
				.onChange(async (value) => {
					this.plugin.settings.clientID = value;
					await this.plugin.saveSettings();
				})
			)

		new Setting(containerEl)
			.setName('Google Client Secret')
			.setDesc('Paste the Client Secret from your Google Cloud Console.')
			.addText(text => text
				.setPlaceholder('Enter Client Secret...')
				.setValue(this.plugin.settings.clientSecret)
				.onChange(async (value) => {
					this.plugin.settings.clientSecret = value;
					await this.plugin.saveSettings();
				})
			)
		
		new Setting(containerEl)
			.setName('Connect to Google Drive')
			.setDesc('Log in to authorize DriveSync to read and write your files.')
			.addButton(button => button
				.setButtonText('Login with Google')
				.setCta()
				.onClick(() => {
					// We moved the logic to main.ts to keep things clean!
					this.plugin.authenticateGoogle();
				})
			) 
			
		new Setting(containerEl)
			.setName('Enable Debug Logging')
			.setDesc('Print verbose sync operation messages to Developer Console. Set to off to keep the console clean.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugLogging)
				.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				})
			)
	}
}

interface RemoteVaultOption {
	name: string;
	id: string;
	isCreateNew: boolean;
}

export class VaultSuggestModal extends SuggestModal<RemoteVaultOption> {
	plugin: MyPlugin;
	options: RemoteVaultOption[];

	constructor(app: App, plugin: MyPlugin, options: RemoteVaultOption[]) {
		super(app);
		this.plugin = plugin;
		this.options = options;
		this.setPlaceholder("Select a remote vault or type to create a new one...");
	}

	getSuggestions(query: string): RemoteVaultOption[] {
		const matches = this.options.filter(v => v.name.toLowerCase().includes(query.toLowerCase()));
		
		if (query.trim().length > 0) {
			matches.unshift({
				name: `[+ Create New Vault]: "${query}"`,
				id: query,
				isCreateNew: true,
			});
		}
		return matches;
	}

	renderSuggestion(option: RemoteVaultOption, el: HTMLElement): void {
		el.createEl("div", {text: option.name, cls: option.isCreateNew ? "drivesync-create-new" : ""});
	}

	async onChooseSuggestion(option: RemoteVaultOption, evt: MouseEvent | KeyboardEvent) {
		if (option.isCreateNew) {
			new Notice(`Creating new remote vault: ${option.id}...`);
			this.plugin.settings.remoteVaultName = option.id;
			this.plugin.settings.driveFolderID = "";
			await this.plugin.saveSettings();
			await this.plugin.getCreateDriveFolder();
		} else {
			new Notice(`Successfully linked to ${option.name}`);
			this.plugin.settings.remoteVaultName = option.name;
			this.plugin.settings.driveFolderID = option.id;
			await this.plugin.saveSettings();
		}

		await this.plugin.rebuildIndex();

		(this.plugin.app as any).setting.openTabById(this.plugin.manifest.id);
	}
}