import { constants } from 'node:fs';
import { access, lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { requireRoot, type DelegationDepth } from './domain.ts';

const piPackageSchema = Type.Object({
  name: Type.Literal('@earendil-works/pi-coding-agent'),
  version: Type.Literal('0.85.1'),
  bin: Type.Object({ pi: Type.Enum(['dist/cli.js', 'dist/bundle/cli.js']) }),
});

export class PiInvocation {
  readonly node: string;
  readonly cli: string;
  private constructor(node: string, cli: string) { this.node = node; this.cli = cli; Object.freeze(this); }
  static async resolve({ execPath = process.execPath, entrypoint = process.argv[1] }: {
    execPath?: string; entrypoint?: string;
  } = {}): Promise<PiInvocation> {
    try {
      if (!entrypoint || !path.isAbsolute(execPath) || !path.isAbsolute(entrypoint)) throw new Error();
      const node = await realpath(execPath);
      const cli = await realpath(entrypoint);
      if (!(await lstat(node)).isFile() || !(await lstat(cli)).isFile()) throw new Error();
      await access(node, constants.X_OK);
      const root = path.basename(path.dirname(cli)) === 'bundle' ? path.dirname(path.dirname(path.dirname(cli))) : path.dirname(path.dirname(cli));
      const manifestPath = path.join(root, 'package.json');
      if ((await lstat(manifestPath)).size > 64 * 1024) throw new Error();
      const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!Check(piPackageSchema, manifest)) throw new Error();
      const bin = await realpath(path.join(root, manifest.bin.pi));
      if (bin !== path.join(root, manifest.bin.pi) || !(await lstat(bin)).isFile()) throw new Error();
      if (cli !== bin && cli !== path.join(root, 'dist/cli.js')) throw new Error();
      return new PiInvocation(node, cli);
    } catch {
      throw new Error('Cannot validate the running Pi 0.85.1 invocation; delegation disabled');
    }
  }
}

export function childEnvironment(depth: DelegationDepth, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  requireRoot(depth);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!key.startsWith('PSTACK_')) env[key] = value;
  }
  env.PSTACK_SUBAGENT_DEPTH = String(depth + 1);
  return env;
}
