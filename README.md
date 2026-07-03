# DriveSync BYOK for Google Drive
DriveSync is a privacy-first, efficient, and highly configurable Google Drive synchronization engine for Obsidian.

DriveSync uses a Bring-Your-Own-Key (BYOK) architecture which enhances privacy and eliminates rate throttling. This means that your data flows directly between your local hard drive to your personal Google Drive.

## Key Features
* **Configurable Sync Strategies:** DriveSync can work in three modes: Two-Way Mirror, One-Way Backup, and Historic Archive:
    * **Two-Way Mirror:** The default system that mirrors all changes between the cloud and the local vault. Adding, modifying, and deleting files and folders are actively synced.
    * **One-Way Backup:** This mode only pushes local changes to Drive and not the vice versa. Perfect for those syncing the vault with another cloud provider. Adding, modifying, and deleting files and folders *locally* will be mirrored in Google Drive, but not the other way around.
    * **Historic Archive:** This mode is similar to the 'One-Way Backup' mode, but deleting files locally *doesn't* delete them in Drive. Also compatible with other cloud sync providers.
    *Note: Do not enable 'Two-Way Mirror' if you are already using another cloud sync service (like iCloud, Dropbox, or OneDrive). Use 'One-Way Backup' or 'Historic Archive' to prevent race conditions, which can lead to file duplication or corruption.*
* **3-Way Hash Reconciliation:** DriveSync intelligently tracks files changes using SHA-256 hashing. It safely handles offline edits and resolves conflicts by duplicating files rather than overwriting existing data.
* **Resumable Chunk Uploads:** You can drop large files into your vault and still experience efficient syncing. DriveSync slices files above 5MB into smaller chunks to prevent network timeouts and significantly improves reliability by allowing the plugin to recover from interruptions without restarting the entire upload.
* **Background Auto-Sync and Catch-Up Sync:** DriveSync offers a configurable auto-sync interval, and a mobile-friendly 'Catch-Up' syncing system.
* **Queue-Based Syncing:** DriveSync can handle rapid file changes (like modifying or adding dozens of files at once) through a queue-based system.

## BYOK Setup
To use DriveSync, you have to generate your own Google Cloud credentials. This is a free, often one-time process that takes about 5 minutes to complete.

### Step 1: Create a Google Cloud Project
1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. Log in with the Google Account you want to use for your Obsidian Vault. It should ideally be the one whose Drive you wish to be syncing with.
3. In the top-left corner, there is a button that may have an existing project name or says, "Select a Project." Click it and click "New project". Name it "DriveSync" and then click Create.
4. Ensure that "DriveSync" is the project name shown on the top-left corner when you return to the dashboard.

### Step 2: Enable the Google Drive API
1. Open the left sidebar (if not already open) by clicking on the hamburger icon in the top-left corner. In the opened sidebar, click on APIs & Services.
2. In the new screen, click "Enable APIs and Services."
3. Find "Google Drive API" and click "Enable."

### Step 3: Configure the OAuth Consent Screen
1. From the APIs & Services screen, click on "OAuth consent screen" located on the left sidebar.
2. Select "Get started" and type in "DriveSync" for the App name field and your email address for the User support email.
3. On the next part, select "External" as your audience. This is helpful in the case where you'd want to use other email accounts with DriveSync other than the one that owns the DriveSync project you just created.
4. Add your desired email in the Contact Information part, then agree to the User Data Policy on the final part. Then, click Create.
5. You will be presented with a **Client ID** and a **Client Secret**. Keep this window open and/or copy to a secure location.

*Note: If you are the only person using this newly created project, do not click 'Publish' on your app. Keep the Publishing Status as 'Testing' to avoid having to deal with Google's lengthy third-party app verification process while keeping your personal access completely functional.*

### Step 4: Connect Obsidian
1. Open Obsidian and go to **Settings > DriveSync**. If DriveSync isn't showing, go to **Community Plugins** and enable DriveSync.
2. Paste the aforementioned **Client ID** and **Client Secret** into their respective fields.

*Note: It is recommended to set up your desired configurations before performing the next steps as it will automatically begin running afterward. This includes setting your Sync Strategy, folders to ignore, and other configurations.*

3. Click **Login with Google**.
4. Your browser will open. Grant DriveSync permission to access your Google Drive. DriveSync will only access respective files being synced.
5. Once authenticated, you may close the browser tab. DriveSync will automatically create a root `DriveSync` folder in your Google Drive and begin syncing.

## Usage & Commands
DriveSync runs automatically in the background based on your Auto-Sync Interval setting (unless you set that to 0), but you may also control it manually using the Command Palette (`Ctrl/Cmd + P`):

* **DriveSync: Manual Sync:** Performs a sync (accordingly to your set Sync Strategy) of your vault with Google Drive. This is also accessible with the cloud icon in the left ribbon.
* **DriveSync: Sync Active File:** Performs a sync of the currently open file with Google Drive.
* **DriveSync: Rebuild Index:** Safely wipes your local tracking maps and rebuilds a fresh index by scanning your local files and your Google Drive.
* **DriveSync: Test Google Drive Connection:** Pings the Google Drive API your access token is valid and returns the connected Google Account email.
* **DriveSync: Setup Google Drive Folder:** A diagnostic command that forces the plugin to verify or generate the master DriveSync folder structure in your Drive.
* **DriveSync: Calculate Hash of Current File:** A developer diagnostic tool that calculates and displays the current SHA-256 state hash of the active file.

### Ignored Folders
You can type in multiple folders as a comma-separated list in the Ignored Folders field inside DriveSync settings. Adding a folder to the Ignore list stops future syncs for those files. Existing files previously synced to Google Drive will remain there; you may delete them manually at your discretion.

To ignore subfolders, add '/' as if you are specifying a directory. For example, if you have a folder named "Main" and a folder within named "Private" and you sync everything in "Main" without anything in "Private", you can add "Main/Private" to the list.

### Hide DriveSync ID, Properties table
These settings are useful for keeping each file clean. The former only hides the unique DriveSync ID from each file. The latter hides the Properties table completely. Note that this is only hidden in your Obsidian client but still shows in Google Drive.

### Remote Vault Connection
By default, the first time you authenticate with Google and trigger a sync, DriveSync will automatically create a master `DriveSync` directory in your Google Drive, containing a subfolder named `Main Vault`. All of your files will be synced there. However, DriveSync is built to handle multiple Obsidian vaults across multiple devices. You can control exactly where your files go by using the **Remote Vault Connection** setting.

If you are setting up DriveSync on a new device, or if you want to sync a completely different Obsidian vault to Drive:
1. Ensure you have completed the Google Login process first.
2. Go to Settings and click **Select Remote Vault** next to the Remote Vault Connection setting.
3. DriveSync will scan your Google Drive and present a dropdown menu:
    * Folders found immediately within the main DriveSync folder will be shown. To link with any of those, simply click on that name.
    * To create a new folder in Drive to link with, type in the desired name and click the new `[+ Create New Vault]` button.

When the Remote Vault location is changed, the files in the previous location are therefore ignored and abandoned. The new location will have the files present locally on your device synced to it. You may have to delete the files in the previous location at your discretion.

## Troubleshooting
**Plugin not showing in settings?"** If you do not see DriveSync in your settings after installing, ensure you have disabled "Restricted mode" in Obsidian's Community Plugins settings.

**Getting errors like "Authentication Failed" or "Token Refresh Error?"** Ensure your Google Cloud app's *Publishing Status* is set to Testing and has not expired. Try clicking "Login with Google" in the settings again to refresh your connection.

**"(Conflict)" files showing in vault?** In cases like editing the same file on two different devices while offline, DriveSync does not attempt to guess which version is "correct." It instead flags one as a *Conflict* so you can manually merge them as needed.

**Sync seems stuck or is throwing errors in the console?** Press `Ctrl/Cmd + P` and run the "DriveSync: Rebuild Index" command. It will attempt to reset the plugin's memory without deleting anything.

## License
This project is licensed under the MIT license. See `LICENSE` for details.