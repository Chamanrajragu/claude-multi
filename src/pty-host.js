// PTY host — a plain Node.js process (NOT Electron) that owns the real
// pseudo-terminal running Claude Code. Running it outside Electron lets us use
// the prebuilt @lydell/node-pty binary directly (matches the system Node ABI),
// sidestepping native-module rebuild pain.
//
// Protocol: newline-delimited JSON over stdio.
//   main -> host: {t:'spawn', file, args, cwd, env, cols, rows}
//                 {t:'input', d:<base64 utf8>}
//                 {t:'resize', cols, rows}
//                 {t:'kill'}
//   host -> main: {t:'ready', pid}
//                 {t:'data', d:<base64 utf8>}
//                 {t:'exit', code}
//                 {t:'error', message}
const pty = require('@lydell/node-pty');

let term = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function killTerm() {
  if (term) {
    try { term.kill(); } catch { /* already gone */ }
    term = null;
  }
}

function handle(msg) {
  switch (msg.t) {
    case 'spawn': {
      killTerm();
      const env = Object.assign({}, process.env, msg.env || {});
      try {
        term = pty.spawn(msg.file, msg.args || [], {
          name: 'xterm-256color',
          cols: msg.cols || 80,
          rows: msg.rows || 24,
          cwd: msg.cwd || process.cwd(),
          env,
        });
      } catch (e) {
        send({ t: 'error', message: String(e && e.message ? e.message : e) });
        send({ t: 'exit', code: -1 });
        return;
      }
      term.onData((d) => send({ t: 'data', d: Buffer.from(d, 'utf8').toString('base64') }));
      term.onExit(({ exitCode }) => { send({ t: 'exit', code: exitCode }); term = null; });
      send({ t: 'ready', pid: term.pid });
      break;
    }
    case 'input':
      if (term) term.write(Buffer.from(msg.d || '', 'base64').toString('utf8'));
      break;
    case 'resize':
      if (term) { try { term.resize(msg.cols, msg.rows); } catch { /* noop */ } }
      break;
    case 'kill':
      killTerm();
      break;
    default:
      break;
  }
}

process.on('SIGTERM', () => { killTerm(); process.exit(0); });
process.on('disconnect', () => { killTerm(); process.exit(0); });
