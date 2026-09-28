import { isAbsolute } from 'node:path';
import { startRunServer } from './run_server.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1])) {
  console.error('run broker startup denied'); process.exit(1);
}
startRunServer(args[1]).catch(() => { console.error('run broker startup denied'); process.exit(1); });
