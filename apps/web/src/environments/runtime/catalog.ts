import { getKnownEnvironmentHttpBaseUrl } from "@t3tools/client-runtime";
import type {
  AuthSessionRole,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  PersistedSavedEnvironmentRecord,
  ServerConfig,
} from "@t3tools/contracts";
import { create } from "zustand";

import {
  migrateBrowserSavedEnvironmentRegistryToDesktopPersistence,
  readPersistedSavedEnvironmentRegistry,
  readPersistedSavedEnvironmentSecret,
  removePersistedSavedEnvironmentSecret,
  writePersistedSavedEnvironmentRegistry,
  writePersistedSavedEnvironmentSecret,
} from "../../clientPersistence";
import { getPrimaryKnownEnvironment } from "../primary";

export interface SavedEnvironmentRecord {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly createdAt: string;
  readonly lastConnectedAt: string | null;
}

interface SavedEnvironmentRegistryState {
  readonly byId: Record<EnvironmentId, SavedEnvironmentRecord>;
}

interface SavedEnvironmentRegistryStore extends SavedEnvironmentRegistryState {
  readonly upsert: (record: SavedEnvironmentRecord) => void;
  readonly remove: (environmentId: EnvironmentId) => void;
  readonly markConnected: (environmentId: EnvironmentId, connectedAt: string) => void;
  readonly reset: () => void;
}

let savedEnvironmentRegistryHydrated = false;
let savedEnvironmentRegistryHydrationPromise: Promise<void> | null = null;

function toPersistedSavedEnvironmentRecord(
  record: SavedEnvironmentRecord,
): PersistedSavedEnvironmentRecord {
  return {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
}

function persistSavedEnvironmentRegistryState(
  byId: Record<EnvironmentId, SavedEnvironmentRecord>,
): void {
  void writePersistedSavedEnvironmentRegistry(
    Object.values(byId).map((record) => toPersistedSavedEnvironmentRecord(record)),
  ).catch((error) => {
    console.error("[SAVED_ENVIRONMENTS] persist failed", error);
  });
}

function replaceSavedEnvironmentRegistryState(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): void {
  useSavedEnvironmentRegistryStore.setState({
    byId: Object.fromEntries(records.map((record) => [record.environmentId, record])),
  });
}

async function hydrateSavedEnvironmentRegistry(): Promise<void> {
  if (savedEnvironmentRegistryHydrated) {
    return;
  }
  if (savedEnvironmentRegistryHydrationPromise) {
    return savedEnvironmentRegistryHydrationPromise;
  }

  const nextHydration = (async () => {
    try {
      const migratedRecords = await migrateBrowserSavedEnvironmentRegistryToDesktopPersistence();
      const persistedRecords =
        migratedRecords.length > 0
          ? migratedRecords
          : await readPersistedSavedEnvironmentRegistry();
      replaceSavedEnvironmentRegistryState(persistedRecords);
    } catch (error) {
      console.error("[SAVED_ENVIRONMENTS] hydrate failed", error);
    } finally {
      savedEnvironmentRegistryHydrated = true;
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (savedEnvironmentRegistryHydrationPromise === hydrationPromise) {
      savedEnvironmentRegistryHydrationPromise = null;
    }
  });
  savedEnvironmentRegistryHydrationPromise = hydrationPromise;

  return savedEnvironmentRegistryHydrationPromise;
}

export const useSavedEnvironmentRegistryStore = create<SavedEnvironmentRegistryStore>()((set) => ({
  byId: {},
  upsert: (record) =>
    set((state) => {
      const byId = {
        ...state.byId,
        [record.environmentId]: record,
      };
      persistSavedEnvironmentRegistryState(byId);
      return { byId };
    }),
  remove: (environmentId) =>
    set((state) => {
      const { [environmentId]: _removed, ...remaining } = state.byId;
      persistSavedEnvironmentRegistryState(remaining);
      return {
        byId: remaining,
      };
    }),
  markConnected: (environmentId, connectedAt) =>
    set((state) => {
      const existing = state.byId[environmentId];
      if (!existing) {
        return state;
      }
      const byId = {
        ...state.byId,
        [environmentId]: {
          ...existing,
          lastConnectedAt: connectedAt,
        },
      };
      persistSavedEnvironmentRegistryState(byId);
      return { byId };
    }),
  reset: () => {
    persistSavedEnvironmentRegistryState({});
    set({
      byId: {},
    });
  },
}));

export function hasSavedEnvironmentRegistryHydrated(): boolean {
  return savedEnvironmentRegistryHydrated;
}

export function waitForSavedEnvironmentRegistryHydration(): Promise<void> {
  if (hasSavedEnvironmentRegistryHydrated()) {
    return Promise.resolve();
  }

  return hydrateSavedEnvironmentRegistry();
}

export function listSavedEnvironmentRecords(): ReadonlyArray<SavedEnvironmentRecord> {
  return Object.values(useSavedEnvironmentRegistryStore.getState().byId).toSorted((left, right) =>
    left.label.localeCompare(right.label),
  );
}

export function getSavedEnvironmentRecord(
  environmentId: EnvironmentId,
): SavedEnvironmentRecord | null {
  return useSavedEnvironmentRegistryStore.getState().byId[environmentId] ?? null;
}

export function getEnvironmentHttpBaseUrl(environmentId: EnvironmentId): string | null {
  const primaryEnvironment = getPrimaryKnownEnvironment();
  if (primaryEnvironment?.environmentId === environmentId) {
    return getKnownEnvironmentHttpBaseUrl(primaryEnvironment);
  }

  return getSavedEnvironmentRecord(environmentId)?.httpBaseUrl ?? null;
}

export function resolveEnvironmentHttpUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly searchParams?: Record<string, string>;
}): string {
  const httpBaseUrl = getEnvironmentHttpBaseUrl(input.environmentId);
  if (!httpBaseUrl) {
    throw new Error(`Unable to resolve HTTP base URL for environment ${input.environmentId}.`);
  }

  const url = new URL(httpBaseUrl);
  url.pathname = input.pathname;
  if (input.searchParams) {
    url.search = new URLSearchParams(input.searchParams).toString();
  }
  return url.toString();
}

export function resetSavedEnvironmentRegistryStoreForTests() {
  savedEnvironmentRegistryHydrated = false;
  savedEnvironmentRegistryHydrationPromise = null;
  useSavedEnvironmentRegistryStore.getState().reset();
}

export async function readSavedEnvironmentBearerToken(
  environmentId: EnvironmentId,
): Promise<string | null> {
  return readPersistedSavedEnvironmentSecret(environmentId);
}

export async function writeSavedEnvironmentBearerToken(
  environmentId: EnvironmentId,
  bearerToken: string,
): Promise<boolean> {
  return writePersistedSavedEnvironmentSecret(environmentId, bearerToken);
}

export async function removeSavedEnvironmentBearerToken(
  environmentId: EnvironmentId,
): Promise<void> {
  await removePersistedSavedEnvironmentSecret(environmentId);
}

export type SavedEnvironmentConnectionState = "connecting" | "connected" | "disconnected" | "error";

export type SavedEnvironmentAuthState = "authenticated" | "requires-auth" | "unknown";

export interface SavedEnvironmentRuntimeState {
  readonly connectionState: SavedEnvironmentConnectionState;
  readonly authState: SavedEnvironmentAuthState;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  readonly role: AuthSessionRole | null;
  readonly descriptor: ExecutionEnvironmentDescriptor | null;
  readonly serverConfig: ServerConfig | null;
  readonly connectedAt: string | null;
  readonly disconnectedAt: string | null;
}

interface SavedEnvironmentRuntimeStoreState {
  readonly byId: Record<EnvironmentId, SavedEnvironmentRuntimeState>;
  readonly ensure: (environmentId: EnvironmentId) => void;
  readonly patch: (
    environmentId: EnvironmentId,
    patch: Partial<SavedEnvironmentRuntimeState>,
  ) => void;
  readonly clear: (environmentId: EnvironmentId) => void;
  readonly reset: () => void;
}

const DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE: SavedEnvironmentRuntimeState = Object.freeze({
  connectionState: "disconnected",
  authState: "unknown",
  lastError: null,
  lastErrorAt: null,
  role: null,
  descriptor: null,
  serverConfig: null,
  connectedAt: null,
  disconnectedAt: null,
});

function createDefaultSavedEnvironmentRuntimeState(): SavedEnvironmentRuntimeState {
  return {
    ...DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE,
  };
}

export const useSavedEnvironmentRuntimeStore = create<SavedEnvironmentRuntimeStoreState>()(
  (set) => ({
    byId: {},
    ensure: (environmentId) =>
      set((state) => {
        if (state.byId[environmentId]) {
          return state;
        }
        return {
          byId: {
            ...state.byId,
            [environmentId]: createDefaultSavedEnvironmentRuntimeState(),
          },
        };
      }),
    patch: (environmentId, patch) =>
      set((state) => ({
        byId: {
          ...state.byId,
          [environmentId]: {
            ...(state.byId[environmentId] ?? createDefaultSavedEnvironmentRuntimeState()),
            ...patch,
          },
        },
      })),
    clear: (environmentId) =>
      set((state) => {
        const { [environmentId]: _removed, ...remaining } = state.byId;
        return {
          byId: remaining,
        };
      }),
    reset: () =>
      set({
        byId: {},
      }),
  }),
);

export function getSavedEnvironmentRuntimeState(
  environmentId: EnvironmentId,
): SavedEnvironmentRuntimeState {
  return (
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId] ??
    DEFAULT_SAVED_ENVIRONMENT_RUNTIME_STATE
  );
}

export function resetSavedEnvironmentRuntimeStoreForTests() {
  useSavedEnvironmentRuntimeStore.getState().reset();
}
