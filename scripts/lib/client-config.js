/**
 * Client config loader — per-client playbook parameters.
 * clients/default.json holds the generic playbook; clients/<name>.json
 * deep-merges over it. Objects merge recursively; arrays and scalars replace.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CLIENTS_DIR = path.join(__dirname, '..', '..', 'clients');

function deepMerge(base, override) {
    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value && typeof value === 'object' && !Array.isArray(value) &&
            base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            out[key] = deepMerge(base[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

export function loadClientConfig(name = 'default') {
    const defaults = JSON.parse(fs.readFileSync(path.join(CLIENTS_DIR, 'default.json'), 'utf8'));
    if (name === 'default') return defaults;
    const clientPath = path.join(CLIENTS_DIR, `${name}.json`);
    if (!fs.existsSync(clientPath)) {
        throw new Error(`Unknown client "${name}" — expected config at ${clientPath}`);
    }
    return deepMerge(defaults, JSON.parse(fs.readFileSync(clientPath, 'utf8')));
}
