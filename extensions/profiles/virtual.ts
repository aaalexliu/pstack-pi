import { getSupportedThinkingLevels, type Api, type Model, type Provider } from '@earendil-works/pi-ai';
import { getModels } from '@earendil-works/pi-ai/compat';
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  aliasProviderId,
  exportProfile,
  launchProfile,
  loadProfileConfig,
  profileStatusKey,
  selectProfile,
  type Profile,
  type ProfileConfig,
} from './config.ts';

export const virtualProvider = 'virtual';

type ThinkingLevel = ReturnType<typeof getSupportedThinkingLevels>[number];

interface RouteRequest {
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
}

interface VirtualModel {
  provider: string;
  id: string;
  name: string;
  thinkingLevels?: readonly ThinkingLevel[];
  contextWindow?: number;
  maxTokens?: number;
  input?: ('text' | 'image')[];
  route(request: RouteRequest, ctx: ExtensionContext): { model: Model<Api>; thinkingLevel: ThinkingLevel };
}

/** Virtual models arrived in Pi 0.99; the package's pinned 0.85.1 types predate them. */
interface VirtualModelApi {
  registerVirtualModel(model: VirtualModel): void;
  unregisterVirtualModel(provider: string, id: string): void;
}

type Registry = Pick<ExtensionContext['modelRegistry'], 'find' | 'hasConfiguredAuth'>;

export function routeModel(registry: Registry, base: string, id: string, profile: Profile | undefined): Model<Api> {
  if (profile?.providers.includes(base)) {
    const alias = registry.find(aliasProviderId(base, profile.name), id);
    if (alias && registry.hasConfiguredAuth(alias)) return alias;
  }
  const fallback = registry.find(base, id);
  if (!fallback) throw new Error(`virtual/${id}: ${base}/${id} is not in the model catalog`);
  return fallback;
}

type ApiKeyAuth = NonNullable<Provider['auth']['apiKey']>;

/** An alias logs in with only its own stored key; the base provider's environment variables never sign it in. */
function storedKeyOnly(apiKey: ApiKeyAuth | undefined, name: string): ApiKeyAuth {
  return {
    name: apiKey?.name ?? name,
    ...(apiKey?.login ? { login: apiKey.login } : {}),
    check: async ({ credential }) => (credential?.key ? { type: 'api_key', source: 'stored credential' } : undefined),
    resolve: async (input) => {
      if (!input.credential?.key) return undefined;
      return apiKey ? apiKey.resolve(input) : { auth: { apiKey: input.credential.key }, source: 'stored credential' };
    },
  };
}

/**
 * A second login for a provider Pi already knows. It copies the composed provider, so
 * transport wrappers other extensions registered on the base, such as
 * pi-anthropic-auth's request shaping, carry over.
 */
export function aliasProvider(source: Provider, id: string, name: string): Provider {
  const rename = <T extends { provider: string }>(models: readonly T[]): T[] => models.map((model) => ({ ...model, provider: id }));
  const { refreshModels: _refreshModels, getAllModels, ...rest } = source as Provider & { getAllModels?: () => readonly Model<Api>[] };
  return {
    ...rest,
    id,
    name,
    auth: {
      ...(source.auth.oauth ? { oauth: source.auth.oauth } : {}),
      apiKey: storedKeyOnly(source.auth.apiKey, name),
    },
    getModels: () => rename(source.getModels()),
    ...(getAllModels ? { getAllModels: () => rename(getAllModels.call(source)) } : {}),
  } as Provider;
}

export function virtualModels(config: ProfileConfig): Map<string, { base: string; model: Model<Api> }> {
  const byId = new Map<string, { base: string; model: Model<Api> }>();
  const bases = [...new Set(config.profiles.flatMap((profile) => profile.providers))];
  for (const base of bases) {
    let models: Model<Api>[];
    try {
      models = getModels(base as Parameters<typeof getModels>[0]) as Model<Api>[];
    } catch {
      continue;
    }
    for (const model of models) if (!byId.has(model.id)) byId.set(model.id, { base, model });
  }
  return byId;
}

export default function virtualProfiles(pi: ExtensionAPI): void {
  const inherited = launchProfile();
  const agentDir = getAgentDir();
  const config = loadProfileConfig(agentDir);
  const api = pi as unknown as ExtensionAPI & Partial<VirtualModelApi>;
  let profile: Profile | undefined;
  const aliases: string[] = [];
  const routed = virtualModels(config);

  const showStatus = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || config.profiles.length === 0) return;
    const borrowed = profile?.providers.filter((base) => !ctx.modelRegistry.getProviderAuthStatus(aliasProviderId(base, profile!.name)).configured) ?? [];
    const text = profile && (borrowed.length ? `profile: ${profile.name} (default login: ${borrowed.join(', ')})` : `profile: ${profile.name}`);
    ctx.ui.setStatus(profileStatusKey, text);
  };

  if (typeof api.registerVirtualModel === 'function') {
    for (const [id, { base, model }] of routed) {
      api.registerVirtualModel({
        provider: virtualProvider,
        id,
        name: `${model.name} (profile)`,
        thinkingLevels: getSupportedThinkingLevels(model),
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        input: model.input,
        route: (request, ctx) => ({ model: routeModel(ctx.modelRegistry, base, id, profile), thinkingLevel: request.thinkingLevel }),
      });
    }
  }

  pi.on('session_start', (_event, ctx) => {
    const notify = (message: string) => { if (ctx.hasUI) ctx.ui.notify(`[profiles] ${message}`, 'warning'); };
    if (config.error) notify(`ignoring ${agentDir}/pstack-pi/profiles.json: ${config.error}`);
    if (config.profiles.length === 0) return;
    if (typeof api.registerVirtualModel !== 'function') notify('this Pi version has no virtual models; virtual/* is unavailable');

    const selection = selectProfile(config, ctx.cwd, inherited);
    if (selection.warning) notify(selection.warning);
    exportProfile(selection);
    profile = selection.profile;

    for (const candidate of config.profiles) {
      for (const base of candidate.providers) {
        const source = ctx.modelRegistry.getProvider(base);
        if (!source) continue;
        const id = aliasProviderId(base, candidate.name);
        pi.registerProvider(aliasProvider(source, id, `${source.name} (${candidate.name})`));
        aliases.push(id);
      }
    }

    showStatus(ctx);
  });

  pi.on('turn_start', (_event, ctx) => showStatus(ctx));

  pi.on('session_shutdown', () => {
    for (const id of aliases.splice(0)) pi.unregisterProvider(id);
    if (typeof api.unregisterVirtualModel === 'function') for (const id of routed.keys()) api.unregisterVirtualModel(virtualProvider, id);
  });
}
