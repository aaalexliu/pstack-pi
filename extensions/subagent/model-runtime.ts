import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ModelRuntime, resolveCliModel, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { parseModelChoice, parseStrictJson, readConfigFile, type ModelSelection } from './model-config.ts';

export type CatalogModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;
export type ThinkingLevel = NonNullable<ExtensionContext['thinkingLevel']>;
export type ModelIdentity = { provider: string; id: string };
export type ChildModel = ModelIdentity & { thinkingLevel: ThinkingLevel };
export type ParentSnapshot = { model: CatalogModel | undefined; thinkingLevel: ThinkingLevel | undefined; extensionProvider: boolean };

export function captureParent(ctx: ExtensionContext): ParentSnapshot {
  const active: CatalogModel | undefined = ctx.model;
  const model = active === undefined ? undefined : structuredClone(active);
  const thinkingLevel = ctx.thinkingLevel;
  return { model, thinkingLevel, extensionProvider: model !== undefined && ctx.modelRegistry.getRegisteredProviderIds().includes(model.provider) };
}

function rejectCommands(value: unknown): void {
  if (typeof value === 'string') {
    if (value.startsWith('!')) throw new Error('Command-backed Pi config is not supported for delegation');
    if (/\$\{?PSTACK_/u.test(value)) throw new Error('Pi config refers to child-filtered PSTACK environment');
  }
  if (value !== null && typeof value === 'object') for (const child of Object.values(value)) rejectCommands(child);
}

export async function qualifyModel({ selection, parent, agentDir, signal }: {
  selection: ModelSelection; parent: ParentSnapshot; agentDir: string; signal: AbortSignal;
}): Promise<ChildModel> {
  signal.throwIfAborted();
  const inherited = selection.choice.kind === 'inheritParent';
  const identity = selection.choice.kind === 'inheritParent' ? parent.model : selection.choice;
  if (!identity) throw new Error('Delegation requires an active parent model');
  const parsed = parseModelChoice(`${identity.provider}/${identity.id}`);
  if (parsed.kind !== 'pinned' || parsed.provider !== identity.provider || parsed.id !== identity.id) throw new Error('Invalid exact model identity');
  if (inherited && parent.extensionProvider) throw new Error('Parent provider depends on an extension');
  for (const name of ['auth.json', 'models.json', 'models-store.json']) {
    const bytes = await readConfigFile(path.join(agentDir, name), 1024 * 1024);
    if (name === 'auth.json' && bytes === undefined) throw new Error('Standalone Pi auth file is missing; start Pi first');
    if (bytes) {
      let value: unknown;
      try { value = parseStrictJson(bytes, 1024 * 1024); }
      catch { throw new Error('Invalid standalone Pi config JSON'); }
      rejectCommands(value);
    }
    signal.throwIfAborted();
  }
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'),
    modelsStorePath: path.join(agentDir, 'models-store.json'), allowModelNetwork: false, signal,
  }).catch(() => { throw new Error('Cannot load standalone Pi model registry'); });
  if (runtime.getError()) throw new Error('Invalid standalone Pi model registry');
  const model = runtime.getModel(identity.provider, identity.id);
  if (!model || model.provider !== identity.provider || model.id !== identity.id) throw new Error('Exact model is unavailable to a leaf child');
  const cli = resolveCliModel({ cliProvider: model.provider, cliModel: model.id, modelRuntime: runtime });
  if (cli.error || cli.warning || cli.thinkingLevel !== undefined || cli.model?.provider !== model.provider || cli.model.id !== model.id) {
    throw new Error('Pi CLI cannot select this exact model identity');
  }
  if (!['openai-completions', 'openai-responses', 'openai-codex-responses', 'azure-openai-responses', 'anthropic-messages', 'google-generative-ai', 'mistral-conversations', 'pi-messages'].includes(model.api)) {
    throw new Error('Leaf model API or external credential chain is not supported');
  }
  if (inherited && !isDeepStrictEqual(parent.model, model)) throw new Error('Parent model metadata differs from standalone child');
  const available = await runtime.getAvailable(model.provider, { signal }).catch(() => { throw new Error('Cannot check standalone model authentication'); });
  if (!available.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
    throw new Error('Model lacks standalone stored, config, or environment authentication');
  }
  const thinkingLevel = inherited ? parent.thinkingLevel : 'off';
  if (thinkingLevel === undefined || (!model.reasoning && thinkingLevel !== 'off')
    || (model.reasoning && (model.thinkingLevelMap?.[thinkingLevel] === null
      || ((thinkingLevel === 'xhigh' || thinkingLevel === 'max') && model.thinkingLevelMap?.[thinkingLevel] === undefined)))) {
    throw new Error('Requested thinking level is not supported by the leaf model');
  }
  signal.throwIfAborted();
  return { provider: model.provider, id: model.id, thinkingLevel };
}
