import * as FS from "node:fs";
import * as Path from "node:path";

import type { ClientSettings, PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { Predicate } from "effect";

interface ClientSettingsDocument {
  readonly settings: ClientSettings;
}

interface SavedEnvironmentRegistryDocument {
  readonly records: readonly PersistedSavedEnvironmentRecord[];
}

interface SavedEnvironmentSecretsDocument {
  readonly byId: Readonly<Record<string, string>>;
}

export interface DesktopSecretStorage {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!FS.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(FS.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  const directory = Path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(directory, { recursive: true });
  FS.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  FS.renameSync(tempPath, filePath);
}

function readSecretsDocument(filePath: string): SavedEnvironmentSecretsDocument {
  const parsed = readJsonFile<SavedEnvironmentSecretsDocument>(filePath);
  return Predicate.isObject(parsed) && Predicate.isObject(parsed.byId) ? parsed : { byId: {} };
}

export function readClientSettings(settingsPath: string): ClientSettings | null {
  return readJsonFile<ClientSettingsDocument>(settingsPath)?.settings ?? null;
}

export function writeClientSettings(settingsPath: string, settings: ClientSettings): void {
  writeJsonFile(settingsPath, { settings } satisfies ClientSettingsDocument);
}

export function readSavedEnvironmentRegistry(
  registryPath: string,
): readonly PersistedSavedEnvironmentRecord[] {
  return readJsonFile<SavedEnvironmentRegistryDocument>(registryPath)?.records ?? [];
}

export function writeSavedEnvironmentRegistry(
  registryPath: string,
  records: readonly PersistedSavedEnvironmentRecord[],
): void {
  writeJsonFile(registryPath, { records } satisfies SavedEnvironmentRegistryDocument);
}

export function readSavedEnvironmentSecret(input: {
  readonly secretsPath: string;
  readonly environmentId: string;
  readonly secretStorage: DesktopSecretStorage;
}): string | null {
  const encoded = readSecretsDocument(input.secretsPath).byId[input.environmentId];
  if (!encoded) {
    return null;
  }

  if (!input.secretStorage.isEncryptionAvailable()) {
    return null;
  }

  try {
    return input.secretStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

export function writeSavedEnvironmentSecret(input: {
  readonly secretsPath: string;
  readonly environmentId: string;
  readonly secret: string;
  readonly secretStorage: DesktopSecretStorage;
}): boolean {
  const document = readSecretsDocument(input.secretsPath);
  const { [input.environmentId]: _previous, ...remaining } = document.byId;

  if (!input.secretStorage.isEncryptionAvailable()) {
    return false;
  }

  writeJsonFile(input.secretsPath, {
    byId: {
      ...remaining,
      [input.environmentId]: input.secretStorage.encryptString(input.secret).toString("base64"),
    },
  } satisfies SavedEnvironmentSecretsDocument);
  return true;
}

export function removeSavedEnvironmentSecret(input: {
  readonly secretsPath: string;
  readonly environmentId: string;
}): void {
  const document = readSecretsDocument(input.secretsPath);
  if (!(Predicate.isObject(document.byId) && input.environmentId in document.byId)) {
    return;
  }

  const { [input.environmentId]: _removed, ...remaining } = document.byId;
  writeJsonFile(input.secretsPath, { byId: remaining } satisfies SavedEnvironmentSecretsDocument);
}
