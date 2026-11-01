// End-to-end binding tests: run the built index.js as an MCP server over stdio,
// point it at a fake OPNsense HTTP server, and assert the exact HTTP verb, path
// and body each tool call produces. Covers the 26.7.x API delta and the verb
// fixes made alongside it. Run: node --test tests/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// BINDINGS_ROOT lets the suite run against another build (e.g. to confirm it fails on the old one).
const ROOT = process.env.BINDINGS_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Canned GET responses for the safe read-modify-write path.
const GET_FIXTURES = {
  '/api/interfaces/wireless_settings/get_item/u1': {
    wireless: {
      if: 'ath0',
      cloneif: 'ath0_wlan1',
      descr: 'old',
      mode: { hostap: { value: 'hostap', selected: 1 }, sta: { value: 'sta', selected: 0 } },
    },
  },
};

let server;
let requests = [];
let mcp;
let nextId = 1;
const pending = new Map();

function startFakeOpnsense() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(GET_FIXTURES[req.url] ?? { status: 'ok' }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function rpc(method, params) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  });
}

async function call(tool, method, params) {
  requests = [];
  const res = await rpc('tools/call', { name: tool, arguments: { method, ...(params ? { params } : {}) } });
  return { res: res.result, requests };
}

before(async () => {
  const port = await startFakeOpnsense();
  mcp = spawn(process.execPath, [path.join(ROOT, 'index.js'), '--url', `http://127.0.0.1:${port}`,
    '--api-key', 'k', '--api-secret', 's'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
});

after(() => {
  mcp?.kill();
  server?.close();
});

const one = (r) => {
  assert.equal(r.requests.length, 1, `expected 1 request, got ${JSON.stringify(r.requests)}`);
  return r.requests[0];
};

// ── 26.7.x additions ──

test('core menuSetFavorite POSTs body to set_favorite', async () => {
  const r = one(await call('core_manage', 'menuSetFavorite', { data: { menuUrl: '/ui/x', isFavorite: '1' } }));
  assert.deepEqual(r, { method: 'POST', path: '/api/core/menu/set_favorite', body: { menuUrl: '/ui/x', isFavorite: '1' } });
});

test('interfaces assignmentPending GETs pending', async () => {
  const r = one(await call('interfaces_manage', 'assignmentPending'));
  assert.equal(r.method, 'GET');
  assert.equal(r.path, '/api/interfaces/assignment/pending');
});

test('wireless settings: plain endpoints use the right verb and path', async () => {
  const cases = [
    ['wirelessSettingsSearchItem', 'GET', '/api/interfaces/wireless_settings/search_item'],
    ['wirelessSettingsGet', 'GET', '/api/interfaces/wireless_settings/get'],
    ['wirelessSettingsGetItem', 'GET', '/api/interfaces/wireless_settings/get_item'],
    ['wirelessSettingsReconfigure', 'POST', '/api/interfaces/wireless_settings/reconfigure'],
    ['wirelessSettingsAddItem', 'POST', '/api/interfaces/wireless_settings/add_item'],
    ['wirelessSettingsSet', 'POST', '/api/interfaces/wireless_settings/set'],
  ];
  for (const [m, verb, p] of cases) {
    const r = one(await call('interfaces_manage', m));
    assert.deepEqual([r.method, r.path], [verb, p], m);
  }
});

test('wirelessSettingsGetItem passes uuid as a path segment', async () => {
  const r = one(await call('interfaces_manage', 'wirelessSettingsGetItem', { uuid: 'u1' }));
  assert.equal(r.path, '/api/interfaces/wireless_settings/get_item/u1');
});

test('wirelessSettingsDelItem accepts comma-separated uuids', async () => {
  const r = one(await call('interfaces_manage', 'wirelessSettingsDelItem', { uuid: 'u1,u2' }));
  assert.deepEqual([r.method, r.path], ['POST', '/api/interfaces/wireless_settings/del_item/u1,u2']);
});

test('wirelessSettingsSetItem does safe read-modify-write', async () => {
  const { requests: rs } = await call('interfaces_manage', 'wirelessSettingsSetItem',
    { uuid: 'u1', data: { wireless: { descr: 'new' } } });
  assert.equal(rs.length, 2, JSON.stringify(rs));
  assert.deepEqual([rs[0].method, rs[0].path], ['GET', '/api/interfaces/wireless_settings/get_item/u1']);
  assert.deepEqual([rs[1].method, rs[1].path], ['POST', '/api/interfaces/wireless_settings/set_item/u1']);
  // untouched fields survive, dropdown flattened to selected key, caller's change applied
  assert.deepEqual(rs[1].body, { wireless: { if: 'ath0', cloneif: 'ath0_wlan1', descr: 'new', mode: 'hostap' } });
});

test('safe-merge wraps flat data under the model root key instead of a silent no-op', async () => {
  const { requests: rs } = await call('interfaces_manage', 'wirelessSettingsSetItem', { uuid: 'u1', data: { descr: 'flat' } });
  assert.equal(rs.length, 2, JSON.stringify(rs));
  assert.deepEqual(rs[1].body, { wireless: { if: 'ath0', cloneif: 'ath0_wlan1', descr: 'flat', mode: 'hostap' } });
});

test('wirelessSettingsSetItem without uuid is rejected before any request', async () => {
  const { res, requests: rs } = await call('interfaces_manage', 'wirelessSettingsSetItem', { data: {} });
  assert.equal(rs.length, 0);
  assert.match(JSON.stringify(res), /requires parameter\(s\): uuid/);
});

test('unbound host override CSV download/upload', async () => {
  const d = one(await call('unbound_manage', 'settingsDownloadHostOverrides'));
  assert.deepEqual([d.method, d.path], ['GET', '/api/unbound/settings/download_host_overrides']);
  const u = one(await call('unbound_manage', 'settingsUploadHostOverrides', { data: { payload: 'a,b' } }));
  assert.deepEqual(u, { method: 'POST', path: '/api/unbound/settings/upload_host_overrides', body: { payload: 'a,b' } });
});

// ── removals ──

test('removed endpoints are no longer offered', async () => {
  for (const m of ['serviceCheck', 'settingsDirty']) {
    const { res, requests: rs } = await call('monit_manage', m);
    assert.equal(rs.length, 0, m);
    assert.match(JSON.stringify(res), /Invalid method/, m);
  }
  const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-generated.json'), 'utf8')).tools;
  const params = Object.keys(tools[0].inputSchema.properties.params.properties);
  assert.ok(!params.includes('rollbackRevision') && !params.includes('revision'));
});

// ── verb / path fixes (OPNsense rejects GET on these, or the path was stale) ──

test('dNatMoveRuleBefore POSTs (endpoint rejects GET) and takes multiple uuids', async () => {
  const r = one(await call('firewall_manage', 'dNatMoveRuleBefore', { uuid: 'a,b', targetUuid: 'c' }));
  assert.deepEqual([r.method, r.path], ['POST', '/api/firewall/d_nat/move_rule_before/a,b/c']);
});

test('filterBaseApply / dNatApply POST to /apply with no stale rollback segment', async () => {
  for (const [m, p] of [['filterBaseApply', 'filter'], ['dNatApply', 'd_nat']]) {
    const bare = one(await call('firewall_manage', m));
    assert.deepEqual([bare.method, bare.path], ['POST', `/api/firewall/${p}/apply`], m);
    const withData = one(await call('firewall_manage', m, { data: {} }));
    assert.equal(withData.path, `/api/firewall/${p}/apply`, `${m} with data`);
  }
});

test('backup delete/revert stay confirm-gated, then POST', async () => {
  for (const [m, p] of [['backupDeleteBackup', 'delete_backup'], ['backupRevertBackup', 'revert_backup']]) {
    const gated = await call('core_manage', m, { backup: 'b1' });
    assert.equal(gated.requests.length, 0, `${m} must not fire without confirm`);
    const r = one(await call('core_manage', m, { backup: 'b1', confirm: true }));
    assert.deepEqual([r.method, r.path], ['POST', `/api/core/backup/${p}/b1`], m);
  }
});
