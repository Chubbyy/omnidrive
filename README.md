# OmniDrive for Google Drive
OmniDrive is a privacy-first, efficient, and highly configurable Google Drive synchronization engine for Obsidian.

OmniDrive uses a Bring-Your-Own-Key (BYOK) architecture which enhances privacy and avoids a shared API quota between users. This means that your data flows directly between your local hard drive to your Google Drive with no server or proxy that could track them.

## Key Features
* **Configurable Sync Strategies:** OmniDrive can work in three modes: Two-Way Mirror, One-Way Backup, and Historic Archive:
    * **Two-Way Mirror:** The default system that mirrors all changes between the Google Drive and the local vault. Adding, modifying, and deleting files, and locally-initiated folder changes are actively synced both ways (see [Known Quirks](#known-quirks) for exceptions).
    * **One-Way Backup:** This mode only pushes local changes to Drive and not the vice versa. Perfect for those syncing the vault with another cloud provider. Adding, modifying, and deleting files and folders *locally* will be mirrored in Google Drive, but not the other way around.
    * **Historic Archive:** This mode is similar to the 'One-Way Backup' mode, but deleting files locally *doesn't* delete them in Drive. Also compatible with other cloud sync providers.
    *Note: Do not enable 'Two-Way Mirror' if you are already using another cloud sync service (like iCloud, Dropbox, or OneDrive). Use 'One-Way Backup' or 'Historic Archive' to prevent race conditions, which can lead to file duplication or corruption.*
* **3-Way Hash Reconciliation (Markdown):** OmniDrive intelligently tracks Markdown file changes using SHA-256 hashing across local, cloud, and last-synced states. This safely handles offline edits and resolves conflicts by duplicating files rather than overwriting existing data. Attachments use a separate, lighter-weight tracking method (see [Known Quirks](#known-quirks)).
* **Resumable Chunk Uploads:** You can drop large files into your vault and still experience efficient syncing. OmniDrive slices files above 5MB into smaller chunks to reduce impacts of network timeouts and significantly improves reliability by allowing the plugin to recover from upload interruptions; the system possesses chunked resumable uploads (not crash-resumable uploads).
* **Background Auto-Sync and Catch-Up Sync:** OmniDrive offers a configurable auto-sync interval, and a mobile-friendly 'Catch-Up' syncing system.
* **Queue-Based Syncing:** OmniDrive can handle rapid file changes (like modifying or adding dozens of files at once) through a queue-based system.

## BYOK Setup
To use OmniDrive, you have to generate your own Google Cloud credentials. This is a free, often one-time process that takes about 5 minutes to complete.

### Step 1: Create a Google Cloud Project
1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. Log in with the Google Account you want to use for your Obsidian Vault. It should ideally be the one whose Drive you wish to be syncing with.
3. In the top-left corner, there is a button that may have an existing project name or says, "Select a Project." Click it and click "New project". Name it "OmniDrive" and then click Create.
4. Ensure that "OmniDrive" is the project name shown on the top-left corner when you return to the dashboard.

### Step 2: Enable the Google Drive API
1. Open the left sidebar (if not already open) by clicking on the hamburger icon in the top-left corner. In the opened sidebar, click on APIs & Services.
2. In the new screen, click "Enable APIs and Services."
3. Find "Google Drive API" and click "Enable."

### Step 3: Configure the OAuth Consent Screen
1. From the APIs & Services screen, click on "OAuth consent screen" located on the left sidebar.
2. Select "Get started" and type in "OmniDrive" for the App name field and your email address for the User support email.
3. On the next part, select "External" as your audience.
4. Add your desired email in the Contact Information part, then agree to the User Data Policy on the final part. Click Create.
5. **Important:** You must now actually create the credential keys. Go to **Credentials** in the left sidebar (or "Clients"). Click **+ Create Client** at the top.
6. For **Application type**, select **Desktop app**. Give it a name and click Create. 
7. You will be presented with a **Client ID** and a **Client Secret**. Keep them stored securely.

*Note: Keeping the Publishing Status as "Testing" avoids Google's lengthy third-party app verification process, but Google will automatically expire your login after 7 days while in this state. You will need to click "Login with Google" in the plugin settings again roughly once a week. If you prefer permanent access without weekly logins, you can submit your Google Cloud app for formal verification and switch it to "Production".*

### Step 4: Connect Obsidian
1. Open Obsidian and go to **Settings > OmniDrive**. If OmniDrive isn't showing, go to **Community Plugins** and enable OmniDrive.
2. Paste the aforementioned **Client ID** and **Client Secret** into their respective fields.

*Note: Ensure you keep the "Enable Syncing" setting disabled until you are completely ready to begin syncing. You should make all configurations before enabling, including your desired Sync Strategy, any folders to ignore, Remote Vault Connection (what folder in the OmniDrive folder located in Google Drive the vault content should sync into; see below), etc.*

**NOTE:** Your Google Client ID, Secret, and Refresh Tokens are stored locally in plain text within your vault's `.obsidian/plugins/omnidrive/data.json` file. Ensure you don't upload these critical information to a public space, such as a GitHub repository, to prevent compromising your Google Cloud's credentials.

3. Click **Login with Google**.
4. Your browser will open. Select the same Google account that you made the Google Cloud key with. Grant OmniDrive permission to access your Google Drive. If you are greeted with a message saying something along the lines of "Google hasn't verified this app", you can press "Continue" or "Advanced" and then "Go to OmniDrive (unsafe)" or "Continue" to bypass.
5. Once authenticated, you may close the browser tab. OmniDrive will create a root OmniDrive folder in your Google Drive if one does not already exist. Synchronization begins after you enable syncing.

**Mobile users:** you will likely see an error when attempting to redirect back to the app. To circumvent this issue, copy the address (127.0.0.1...) and paste it in the "Mobile authentication / manual login" setting field, then hit "Verify."

## Usage & Commands
Once Enable syncing is turned on, OmniDrive runs automatically in the background based on your Auto-Sync Interval setting (unless you set it to 0), but you may also control it manually using the Command Palette `(Ctrl/Cmd + P)`:

* **OmniDrive: Sync active file:** Performs a sync of the currently open file with Google Drive.
* **OmniDrive: Rebuild index:** Rebuilds OmniDrive's local tracking index and re-establishes synchronization links with the configured Google Drive vault.
* **OmniDrive: Test Google Drive connection:** Pings the Google Drive API to verify that your access token is valid and returns the connected Google Account email.
* **OmniDrive: Setup Google Drive folder:** A diagnostic command that forces the plugin to verify or generate the master OmniDrive folder structure in your Drive.
* **OmniDrive: Calculate hash of current file:** A developer diagnostic tool that calculates and displays the current SHA-256 state hash of the active file.
* **OmniDrive: Show debug log:** Opens a window inside Obsidian showing the debug log contents. Useful on mobile which has no native developer console to refer to.
* **OmniDrive: Clear debug log:** Empties the debug log file.

You can additionally perform a manual sync of your entire vault using the cloud icon found in the left ribbon.

### Ignored Folders
You can type in multiple folders as a comma-separated list in the Ignored Folders field inside OmniDrive settings. Adding a folder to the Ignore list stops future syncs for those files. Existing files previously synced to Google Drive will remain there; you may delete them manually at your discretion.

To ignore sub-folders, add '/' as if you are specifying a directory. For example, if you have a folder named "Main" and a folder within named "Private" and you sync everything in "Main" without anything in "Private", you can add "Main/Private" to the list.

### Hide OmniDrive ID, Properties table
These settings are useful for keeping each file clean. The former only hides the unique OmniDrive ID from each file. The latter hides the Properties table completely. Note that this is only hidden in your Obsidian client but still shows in Google Drive.

### Remote Vault Connection
By default, the first time you authenticate with Google and trigger a sync, OmniDrive will automatically create a master `OmniDrive` directory in your Google Drive, containing a subfolder named the same as your current vault name. All of your files will be synced there. OmniDrive is built to handle multiple Obsidian vaults across multiple devices. You can control exactly where your files go by using the **Remote Vault Connection** setting.

To manually change where in Google Drive (inside the OmniDrive folder) your vault contents are stored:
1. Ensure you have completed the Google Login process first.
2. Go to the plugin settings and click **Select Remote Vault** next to the Remote Vault Connection setting.
3. OmniDrive will scan your Google Drive and present a dropdown menu:
    * Folders found immediately within the main OmniDrive folder will be shown. To link with any of those, simply click on that name.
    * To create a new folder in Drive to link with, type in the desired name and click the newly appeared `[+ Create New Vault]` option.

When the Remote Vault location is changed, the files in the previous location are therefore ignored and abandoned. The new location will have the files present locally on your device synced to it. You can delete the files in the previous location as desired or keep it as a form of archive/backup.

## Troubleshooting
**Plugin not showing in settings?** If you do not see OmniDrive in your settings after installing, ensure you have disabled "Restricted mode" in Obsidian's Community Plugins settings.

**Getting errors like "Authentication Failed" or "Token Refresh Error?"** Ensure your Google Cloud app's *Publishing Status* is set to Testing and has not expired. Try clicking "Login with Google" in the settings again to refresh your connection.

**"(Cloud Backup)" files showing in vault?** In cases like editing the same file on two different devices while offline, OmniDrive does not attempt to guess which version is "correct." It safely keeps your active local file intact, but downloads the conflicting Google Drive version as a backup file (e.g., `Note (Cloud Backup YYYY-MM-DD...).md`). You can open them side-by-side, manually copy over any missing information, and safely delete the backup file when finished.

**Sync seems stuck or is throwing errors in the console?** Press `Ctrl/Cmd + P` (swipe down near the top of the screen on mobile) and run the "OmniDrive: Rebuild index" command. It will attempt to reset the plugin's memory without deleting anything.

**Errors/Issues after moving or deleting the remote folder in Google Drive?** You may restore the folder back in its original location or press `Ctrl/Cmd + P` (swipe down near the top of the screen on mobile) and run the "OmniDrive: Rebuild index" command. You may also attempt to resync if you haven't done so. Both attempt to recreate the remote folder.

**Need more detail than the on-screen notices give you?** Turn on Enable debug logging in OmniDrive settings, reproduce the issue, then run OmniDrive: Show debug log to view a detailed activity log directly inside Obsidian (compatible with mobile, too). Run OmniDrive: Clear debug log to empty it as needed. Debug logs can include file/folder names and Google Drive IDs, so review the contents before sharing them (e.g., in a bug report).

## Known Quirks
*These are documented "issues" that are deemed as closer to edge cases rather than substantial, system-breaking problems. Some may be due to a system limitation, how Google Drive's API works, or other reasons not easily circumventable. The ones listed below may or may not be resolved completely in future patches.*
1. Performing a substantial/complete wipe in Drive will rebuild the entire vault in Drive again (intentional design) with the exception of previously empty folders, which will not appear in Drive until there is content inside. This is more of a Google Drive quirk rather than a system flaw/limitation.

2. If a folder is completely deleted locally, the folder (with no content inside) will remain in Drive regardless of the Sync Strategy.

3. In the One-Way Backup and Historic Archive Sync Strategies, renaming or moving a file/folder directly inside Google Drive is not synced back in either direction. Local is the source of truth for names/locations in these modes, and content will continue to sync correctly (since everything is tracked by Drive's internal file ID, not by name), but Drive's display name may differ from your local name. To avoid this "quirk" altogether, consider not renaming or moving files in Drive but rather locally. To fix/match the names again, either rename the item locally or manually match the name in Drive.

4. Deleting a folder in Google Drive does not delete the local folder or its contents, including in the Two-Way Mirror Sync Strategy. The plugin will instead recreate the folder in Drive and re-push everything inside it. This applies to the folder itself, unlike individual file deletions in Drive which do mirror correctly locally. Therefore, if you want a folder gone from both sides, delete it locally as that is the direction folder deletions always propagate. This and quirk 2 are two sides of the same coin.

5. When a folder deletion in Drive gets automatically reversed (see quirk 4), Markdown files inside it are recovered exactly via their internal tracking ID (omnidrive_id). Attachments don't possess such an ID, so instead of being recovered they get freshly re-uploaded as new copies. The original is left behind in Google Drive's trash and is permanently deleted after 30 days. Your local files are never affected either way.

6. If a rename/move fails to reach Google Drive (e.g., a dropped connection or equivalent failure), local tracking still updates to the new name immediately, but Drive keeps the old name until you rename/move that item locally again. Enable debug logging if you wish to confirm.

7. If using a VPN, you may encounter issues with `Token Refresh Error`. Disconnecting has reliably resolved this.

## Privacy and Data Access
OmniDrive does not use any developer-hosted servers, analytics, or telemetry.
All communication happens directly between your device and Google's servers using OAuth credentials you generate yourself (see BYOK Setup above).

OmniDrive does not transmit vault contents, credentials, or usage data to the plugin author. Files you choose to sync are sent only to your own Google Drive account via the Google Drive API.

As mentioned above, your Google Client ID, Client Secret, and refresh token are stored locally in your vault's `.obsidian/plugins/omnidrive/data.json`, in plain text. Do not share this file.

OmniDrive contains no ads and requires no payment.

## License
This project is licensed under the MIT license. See `LICENSE` for details.