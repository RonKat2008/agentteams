// usage: node mcp.mjs <person> <tool> <mcpTool> '<json>'
import { spawn } from 'node:child_process';
const [person, tool, name, args = '{}'] = process.argv.slice(2);
const env = { ...process.env, AGENTTEAMS_HOME: `${process.env.R}/people/${person}` };
const p = spawn('agentteams', ['mcp', '--tool', tool, '--repo', `${process.env.R}/shop-api`], { env, stdio: ['pipe', 'pipe', 'inherit'] });
const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
let buf = '';
p.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id === 1) { send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/call', params: { name, arguments: JSON.parse(args) } }); }
    if (msg.id === 2) { console.log(msg.result?.content?.[0]?.text ?? JSON.stringify(msg)); p.kill(); }
  }
});
send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo', version: '1' } } });
