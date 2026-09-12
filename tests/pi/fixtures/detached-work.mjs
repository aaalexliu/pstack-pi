import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' });
if (child.pid === undefined) throw new Error('Detached work failed to start');
writeFileSync('detached-pid.json', JSON.stringify({ pid: child.pid }));
child.unref();
setTimeout(() => {}, 300);
