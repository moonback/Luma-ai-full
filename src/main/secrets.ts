import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { SecretStore } from '../core/app/AppService';

/**
 * Secrets encrypted with the OS keychain via Electron safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Never written in clear text: if encryption is unavailable, storing is refused.
 */
export function createSecretStore(dir: string): SecretStore {
  const file = path.join(dir, 'secrets.json');
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  };
  return {
    get(name) {
      const enc = read()[name];
      if (!enc || !safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
      } catch {
        return null;
      }
    },
    set(name, value) {
      const all = read();
      if (value === null) delete all[name];
      else {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Chiffrement système indisponible : la clé n’a pas été enregistrée');
        all[name] = safeStorage.encryptString(value).toString('base64');
      }
      writeFileSync(`${file}.tmp`, JSON.stringify(all), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
  };
}
