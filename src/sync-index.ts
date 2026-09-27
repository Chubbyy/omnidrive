/** Preserve first-match behavior of the former Object.keys(...).find lookups. */
export function reversePaths(paths: Record<string, string>): Map<string, string> {
	const reverse = new Map<string, string>();
	for (const [path, id] of Object.entries(paths)) if (!reverse.has(id)) reverse.set(id, path);
	return reverse;
}

export function cascadePaths(maps: Record<string, string>[], oldPath: string, newPath: string): boolean {
	let changed = false;
	for (const map of maps) {
		for (const key of Object.keys(map)) {
			if (key === oldPath || key.startsWith(oldPath + '/')) {
				map[newPath + key.substring(oldPath.length)] = map[key] as string;
				delete map[key];
				changed = true;
			}
		}
	}
	return changed;
}
