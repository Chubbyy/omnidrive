import type { SecretStorage } from 'obsidian';
import type { OmniDriveSettings } from './settings';

type CredentialSettings = OmniDriveSettings & { credentialStorageID: string };

type Storage = Pick<SecretStorage, 'getSecret' | 'setSecret'>;
export const credentialFields = ['clientSecret', 'refreshToken'] as const;
export type CredentialChanges = Partial<Pick<OmniDriveSettings, typeof credentialFields[number]>>;

export function sanitizeSettings(settings: OmniDriveSettings): Omit<OmniDriveSettings, 'clientSecret' | 'refreshToken'> {
	const { clientSecret, refreshToken, ...safe } = settings;
	return safe;
}

/** Migration only removes plaintext after SecretStorage accepts and returns the value. */
export function storeCredentials(settings: CredentialSettings, storage: Storage, fields: readonly (typeof credentialFields[number])[] = credentialFields): Omit<CredentialSettings, 'clientSecret' | 'refreshToken'> {
	if (!settings.credentialStorageID) settings.credentialStorageID = `omnidrive-${window.crypto.randomUUID()}`;
	for (const field of fields) {
		const key = `${settings.credentialStorageID}-${field === 'clientSecret' ? 'client-secret' : 'refresh-token'}`;
		const value = settings[field];
		if ((storage.getSecret(key) ?? '') !== value) storage.setSecret(key, value);
		if ((storage.getSecret(key) ?? '') !== value) throw new Error('OmniDrive could not verify credential storage. Existing settings were not overwritten.');
	}
	return sanitizeSettings(settings);
}

export function loadCredentials(settings: CredentialSettings, storage: Storage): void {
	if (!settings.credentialStorageID) return;
	for (const field of credentialFields) {
		const key = `${settings.credentialStorageID}-${field === 'clientSecret' ? 'client-secret' : 'refresh-token'}`;
		settings[field] = storage.getSecret(key) ?? settings[field];
	}
}
