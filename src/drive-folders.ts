import { driveRequest } from './drive-api';

export interface DriveFolder { id: string; name: string; appProperties?: Record<string, string> }
export const folderProperties = (role: string) => ({ omnidrive_folder: role });

export function selectFolder(files: DriveFolder[], role: string, label: string): DriveFolder | undefined {
	const marked = files.filter(file => file.appProperties?.omnidrive_folder === role);
	const candidates = marked.length ? marked : files;
	if (candidates.length > 1) throw new Error(`Multiple Google Drive folders match "${label}". Rename the duplicates or select the intended remote vault before syncing.`);
	return candidates[0];
}

export async function listFolders(query: string, token: string): Promise<DriveFolder[]> {
	const files: DriveFolder[] = [];
	let pageToken: string | undefined;
	const seenPages = new Set<string>();
	do {
		const response = await driveRequest({
			url: `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=nextPageToken,files(id,name,appProperties)&pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
			headers: { Authorization: `Bearer ${token}` },
		});
		const data: unknown = response.json;
		if (!data || typeof data !== 'object' || !('files' in data) || !Array.isArray(data.files)) throw new Error('Invalid Drive folder listing.');
		for (const file of data.files as unknown[]) {
			if (!file || typeof file !== 'object' || !('id' in file) || typeof file.id !== 'string' || !('name' in file) || typeof file.name !== 'string') throw new Error('Invalid Drive folder metadata.');
			files.push(file as DriveFolder);
		}
		pageToken = 'nextPageToken' in data && typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined;
		if (pageToken && seenPages.has(pageToken)) throw new Error('Repeated Drive folder page token.');
		if (pageToken) seenPages.add(pageToken);
	} while (pageToken);
	return files;
}

export async function findFolder(name: string, parent: string | null, role: string, token: string): Promise<DriveFolder | undefined> {
	const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	const query = `${parent ? `'${escape(parent)}' in parents and ` : ''}name='${escape(name)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
	return selectFolder(await listFolders(query, token), role, name);
}
