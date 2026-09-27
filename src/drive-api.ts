import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';

export class DriveRequestError extends Error {
	constructor(public status: number) { super(`Google Drive request failed (status ${status}).`); }
}

function retryDelay(response: RequestUrlResponse | undefined, attempt: number): number {
	const header = Object.entries(response?.headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
	const serverDelay = header === undefined ? 0 : /^\d+(\.\d+)?$/.test(header.trim())
		? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now());
	return Math.max(500 * 2 ** attempt + Math.random() * 250, Number.isFinite(serverDelay) ? serverDelay : 0);
}

function isRateLimitResponse(response: RequestUrlResponse): boolean {
	if (response.status !== 403) return false;
	try {
		const data: unknown = response.json;
		if (!data || typeof data !== 'object' || !('error' in data)) return false;
		const error = data.error;
		if (!error || typeof error !== 'object' || !('errors' in error) || !Array.isArray(error.errors)) return false;
		return error.errors.length > 0 && error.errors.every((entry: unknown) =>
			!!entry && typeof entry === 'object' && 'reason' in entry
			&& (entry.reason === 'rateLimitExceeded' || entry.reason === 'userRateLimitExceeded'));
	} catch { return false; }
}

/** Only Drive GETs retry. Writes and OAuth requests retain their original semantics. */
export async function driveRequest(options: RequestUrlParam): Promise<RequestUrlResponse> {
	if ((options.method ?? 'GET').toUpperCase() !== 'GET' || !options.url.startsWith('https://www.googleapis.com/drive/v3/')) {
		return requestUrl(options);
	}
	for (let attempt = 0; ; attempt++) {
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({ ...options, throw: false });
		} catch (error) {
			if (attempt >= 2 || !/ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/.test(String(error))) throw error;
			await new Promise(resolve => window.setTimeout(resolve, retryDelay(undefined, attempt)));
			continue;
		}
		const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status) || isRateLimitResponse(response);
		const delay = retryDelay(response, attempt);
		// A long Retry-After defers to the next sync rather than retrying too early.
		if (retryable && attempt < 2 && delay <= 30000) {
			await new Promise(resolve => window.setTimeout(resolve, delay));
			continue;
		}
		if (response.status >= 400 && options.throw !== false) throw new DriveRequestError(response.status);
		return response;
	}
}
