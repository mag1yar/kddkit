import { fork } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [role, scope, artifact] = process.argv.slice(2);
if (role === 'writer') {
  process.send?.({ ready: true, scope, pid: process.pid });
  setInterval(() => appendFileSync(artifact, `${scope}\n`), 25);
} else {
  const child = fork(fileURLToPath(import.meta.url), ['writer', scope, artifact],
    { execPath: process.execPath, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.once('message', message => process.send?.({ ...message, parentPid: process.pid, childPid: child.pid }));
  process.on('message', message => { if (message === 'exit-parent') process.exit(0); });
}
