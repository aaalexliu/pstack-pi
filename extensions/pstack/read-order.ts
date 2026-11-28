import { createReadToolDefinition, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

interface RunningCall {
  name: string;
  ended: Promise<void>;
  end: () => void;
}

// Pi runs the calls of one assistant message in parallel, so a read listed after a bash call
// that writes its file used to run before the file existed, or while it still held the old bytes.
// This read first waits for every earlier call in its message that is not a read. Reads still run
// side by side, and the wait costs no time overall, since Pi returns a message's results only when
// all its calls end. Nested calls, such as a codemode script's, are left alone: the script orders them.
export function registerReadOrder(pi: ExtensionAPI): void {
  // Calls of the current message, in the order Pi starts them, which is the message's order.
  const running = new Map<string, RunningCall>();

  pi.on('tool_execution_start', (event) => {
    if (event.parentToolCallId) return;
    let end = (): void => undefined;
    const ended = new Promise<void>((resolve) => { end = resolve; });
    running.set(event.toolCallId, { name: event.toolName, ended, end });
  });
  pi.on('tool_execution_end', (event) => {
    running.get(event.toolCallId)?.end();
    running.delete(event.toolCallId);
  });

  const earlierWrites = (toolCallId: string): Promise<void>[] => {
    if (!running.has(toolCallId)) return [];
    const waits: Promise<void>[] = [];
    for (const [id, call] of running) {
      if (id === toolCallId) break;
      if (call.name !== 'read') waits.push(call.ended);
    }
    return waits;
  };

  const read = (cwd: string) => createReadToolDefinition(cwd, { autoResizeImages: pi.getSettings().images?.autoResize ?? true });

  pi.registerTool({
    ...createReadToolDefinition(process.cwd()),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await Promise.all(earlierWrites(toolCallId));
      return read(ctx.cwd).execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
