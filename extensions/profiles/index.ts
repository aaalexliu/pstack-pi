import { existsSync } from 'node:fs';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  exportProfile,
  launchProfile,
  loadProfileConfig,
  profileAuthPath,
  profileStatus,
  profileStatusKey,
  selectProfile,
  type Profile,
} from './config.ts';

type Options = { signal?: AbortSignal };
type Credential = { type: string; [key: string]: unknown };
type Modify = (current: Credential | undefined) => Promise<Credential | undefined>;

export interface CredentialStore {
  read(providerId: string, options?: Options): Promise<Credential | undefined>;
  list(options?: Options): Promise<readonly { providerId: string; type: string }[]>;
  modify(providerId: string, fn: Modify, options?: Options): Promise<Credential | undefined>;
  delete(providerId: string, options?: Options): Promise<void>;
}

export interface ProfileFile {
  existing(): CredentialStore | undefined;
  open(): CredentialStore;
}

const baseStoreKey = Symbol.for('pstack-pi.profiles.base-store');

type RoutedStore = CredentialStore & { [baseStoreKey]?: CredentialStore };

/**
 * Owned providers read the profile file first and fall back to the default file. A
 * refresh of a fallback credential finds nothing in the profile file, declines, and
 * retries against the default file, so the profile file only ever gains a login made
 * inside the profile.
 */
export function routeCredentials(base: CredentialStore, profile: ProfileFile, owned: ReadonlySet<string>): CredentialStore {
  const routed: RoutedStore = {
    async read(providerId, options) {
      if (!owned.has(providerId)) return base.read(providerId, options);
      return (await profile.existing()?.read(providerId, options)) ?? base.read(providerId, options);
    },
    async list(options) {
      const entries = new Map((await base.list(options)).map((entry) => [entry.providerId, entry]));
      for (const entry of (await profile.existing()?.list(options)) ?? []) {
        if (owned.has(entry.providerId)) entries.set(entry.providerId, entry);
      }
      return [...entries.values()];
    },
    async modify(providerId, fn, options) {
      if (!owned.has(providerId)) return base.modify(providerId, fn, options);
      let declined = false;
      const result = await profile.open().modify(providerId, async (current) => {
        if (current) return fn(current);
        const next = await fn(undefined);
        declined = next === undefined;
        return next;
      }, options);
      return declined ? base.modify(providerId, fn, options) : result;
    },
    async delete(providerId, options) {
      if (!owned.has(providerId)) return base.delete(providerId, options);
      await profile.existing()?.delete(providerId, options);
    },
  };
  routed[baseStoreKey] = base;
  return routed;
}

export function baseStore(store: CredentialStore): CredentialStore {
  return (store as RoutedStore)[baseStoreKey] ?? store;
}

type StoreFactory = { create(path: string): CredentialStore };

export function profileFile(path: string, factory: StoreFactory): ProfileFile {
  let store: CredentialStore | undefined;
  return {
    existing: () => store ?? (existsSync(path) ? (store = factory.create(path)) : undefined),
    open: () => (store ??= factory.create(path)),
  };
}

type RuntimeCredentials = { store: CredentialStore };

/** Pi 1.x keeps the auth.json store on a private field; this is the one internal the prototype touches. */
export function runtimeCredentials(ctx: ExtensionContext): RuntimeCredentials | undefined {
  const credentials = (ctx.modelRegistry as unknown as { runtime?: { credentials?: Partial<RuntimeCredentials> } }).runtime?.credentials;
  const store = credentials?.store;
  if (!store || typeof store.read !== 'function' || typeof store.modify !== 'function') return undefined;
  return credentials as RuntimeCredentials;
}

function storeFactory(store: CredentialStore): StoreFactory | undefined {
  const factory = (store as { constructor?: Partial<StoreFactory> }).constructor;
  return typeof factory?.create === 'function' ? (factory as StoreFactory) : undefined;
}


export default function profiles(pi: ExtensionAPI): void {
  const inherited = launchProfile();
  let installed: { credentials: RuntimeCredentials; base: CredentialStore; profile: Profile; file: ProfileFile } | undefined;

  const showStatus = async (ctx: ExtensionContext, provider = ctx.model?.provider) => {
    if (!installed || !ctx.hasUI) return;
    const { profile, file } = installed;
    const ownLogin = provider !== undefined && profile.providers.includes(provider) && (await file.existing()?.read(provider)) !== undefined;
    ctx.ui.setStatus(profileStatusKey, profileStatus(profile, provider, ownLogin));
  };

  pi.on('session_start', async (_event, ctx) => {
    const agentDir = getAgentDir();
    const config = loadProfileConfig(agentDir);
    const notify = (message: string) => { if (ctx.hasUI) ctx.ui.notify(`[profiles] ${message}`, 'warning'); };
    if (config.error) notify(`ignoring ${agentDir}/pstack-pi/profiles.json: ${config.error}`);
    if (config.profiles.length === 0) return;

    const selection = selectProfile(config, ctx.cwd, inherited);
    if (selection.warning) notify(selection.warning);
    exportProfile(selection);

    const credentials = runtimeCredentials(ctx);
    const base = credentials && baseStore(credentials.store);
    const factory = base && storeFactory(base);
    if (!credentials || !base || !factory) {
      notify('this Pi version does not expose its credential store; every session uses the default logins');
      return;
    }
    const { profile } = selection;
    if (!profile) {
      credentials.store = base;
      if (ctx.hasUI) ctx.ui.setStatus(profileStatusKey, undefined);
      return;
    }
    const file = profileFile(profileAuthPath(agentDir, profile.name), factory);
    credentials.store = routeCredentials(base, file, new Set(profile.providers));
    installed = { credentials, base, profile, file };
    await ctx.modelRegistry.refresh({ allowNetwork: false, providers: profile.providers } as Parameters<typeof ctx.modelRegistry.refresh>[0]);
    await showStatus(ctx);
  });

  pi.on('turn_start', (_event, ctx) => showStatus(ctx));
  pi.on('model_select', (event, ctx) => showStatus(ctx, event.model.provider));

  pi.on('session_shutdown', () => {
    if (installed) installed.credentials.store = installed.base;
    installed = undefined;
  });
}
