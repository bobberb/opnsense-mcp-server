// End-to-end binding tests: run the built index.js as an MCP server over stdio,
// point it at a fake OPNsense HTTP server, and assert the exact HTTP verb, path
// and body each tool call produces. Covers the 26.7.x API delta and the verb
// fixes made alongside it, and signature-driven path-param mapping for every tool method
// (sweep test at the end). Run: yarn test
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
  '/api/interfaces/tap_settings/get_item/t1': {
    tap: { descr: 'old', tun: '0' },
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
    '--api-key', 'k', '--api-secret', 's', '--plugins'], { stdio: ['pipe', 'pipe', 'pipe'] });
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

// ── 26.7.9 additions ──

test('core dashboardGetDefaults GETs get_defaults', async () => {
  const r = one(await call('core_manage', 'dashboardGetDefaults'));
  assert.deepEqual([r.method, r.path], ['GET', '/api/core/dashboard/get_defaults']);
});

test('tap settings: endpoints use the right verb and path', async () => {
  const cases = [
    ['tapSettingsSearchItem', 'GET', '/api/interfaces/tap_settings/search_item'],
    ['tapSettingsGetItem', 'GET', '/api/interfaces/tap_settings/get_item'],
    ['tapSettingsReconfigure', 'POST', '/api/interfaces/tap_settings/reconfigure'],
    ['tapSettingsAddItem', 'POST', '/api/interfaces/tap_settings/add_item'],
  ];
  for (const [m, verb, p] of cases) {
    const r = one(await call('interfaces_manage', m));
    assert.deepEqual([r.method, r.path], [verb, p], m);
  }
  const g = one(await call('interfaces_manage', 'tapSettingsGetItem', { uuid: 't1' }));
  assert.equal(g.path, '/api/interfaces/tap_settings/get_item/t1');
  const d = one(await call('interfaces_manage', 'tapSettingsDelItem', { uuid: 't1' }));
  assert.deepEqual([d.method, d.path], ['POST', '/api/interfaces/tap_settings/del_item/t1']);
});

test('tapSettingsSetItem does safe read-modify-write and needs a uuid', async () => {
  const { requests: rs } = await call('interfaces_manage', 'tapSettingsSetItem', { uuid: 't1', data: { descr: 'new' } });
  assert.equal(rs.length, 2, JSON.stringify(rs));
  assert.deepEqual([rs[0].method, rs[0].path], ['GET', '/api/interfaces/tap_settings/get_item/t1']);
  assert.deepEqual([rs[1].method, rs[1].path], ['POST', '/api/interfaces/tap_settings/set_item/t1']);
  assert.deepEqual(rs[1].body, { tap: { descr: 'new', tun: '0' } });
  const { res, requests: none } = await call('interfaces_manage', 'tapSettingsSetItem', { data: {} });
  assert.equal(none.length, 0);
  assert.match(JSON.stringify(res), /requires parameter\(s\): uuid/);
});

// ── packaging: the committed yarn patch must reproduce the committed bindings ──

test('every generated tool method exists in the client built from the committed patch', () => {
  // A stale .yarn/patches file means a fresh clone's `yarn build:all` silently drops methods.
  const client = fs.readFileSync(path.join(ROOT, 'node_modules/@richard-stovall/opnsense-typescript-client/dist/index.js'), 'utf8');
  const defined = new Set([...client.matchAll(/^\s+async (\w+)\(/gm)].map((m) => m[1]));
  const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-generated.json'), 'utf8')).tools;
  const missing = tools.flatMap((t) => t.inputSchema.properties.method.enum.filter((m) => !defined.has(m)).map((m) => `${t.name}.${m}`));
  assert.deepEqual(missing, []);
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

// ── positional path params are mapped from each method's own signature ──
// Before: only ~100 hand-mapped methods got positional args; every other method with a path
// param (cron jobs, gateways, unbound/dnsmasq/wireguard items, ...) received the params object
// as its first argument and called e.g. /api/cron/settings/get_job/[object Object].

test('cron job methods put uuid (and enabled) in the path', async () => {
  const g = one(await call('cron_manage', 'settingsGetJob', { uuid: 'j1' }));
  assert.deepEqual([g.method, g.path], ['GET', '/api/cron/settings/get_job/j1']);
  const t = one(await call('cron_manage', 'settingsToggleJob', { uuid: 'j1', enabled: '1' }));
  assert.deepEqual([t.method, t.path], ['POST', '/api/cron/settings/toggle_job/j1/1']);
  const s = one(await call('cron_manage', 'settingsSetJob', { uuid: 'j1', data: { job: { enabled: '1' } } }));
  assert.deepEqual(s, { method: 'POST', path: '/api/cron/settings/set_job/j1', body: { job: { enabled: '1' } } });
});

test('toggle without enabled flips: no literal "undefined" segment reaches OPNsense', async () => {
  for (const [tool, m, p] of [['cron_manage', 'settingsToggleJob', '/api/cron/settings/toggle_job/j1'],
                              ['firewall_manage', 'filterToggleRule', '/api/firewall/filter/toggle_rule/r1']]) {
    const r = one(await call(tool, m, { uuid: m === 'filterToggleRule' ? 'r1' : 'j1' }));
    assert.equal(r.path, p, m);
  }
});

test('write endpoints still reject a missing required path param before any request', async () => {
  for (const [tool, m] of [['cron_manage', 'settingsSetJob'], ['routing_manage', 'settingsSetGateway'],
                           ['unbound_manage', 'settingsDelForward']]) {
    const { res, requests: rs } = await call(tool, m, { data: {} });
    assert.equal(rs.length, 0, m);
    assert.match(JSON.stringify(res), /requires parameter\(s\): uuid/, m);
  }
});

test('gateway and plugin-free item methods map uuid', async () => {
  const gw = one(await call('routing_manage', 'settingsSetGateway', { uuid: 'WAN_DHCP', data: { gateway_item: { monitor: '1.1.1.1' } } }));
  assert.deepEqual([gw.method, gw.path], ['POST', '/api/routing/settings/set_gateway/WAN_DHCP']);
  const wg = one(await call('wireguard_manage', 'clientGetClient', { uuid: 'c1' }));
  assert.deepEqual([wg.method, wg.path], ['GET', '/api/wireguard/client/get_client/c1']);
  const ub = one(await call('unbound_manage', 'settingsGetForward', { uuid: 'f1' }));
  assert.equal(ub.path, '/api/unbound/settings/get_forward/f1');
});

test('read endpoints may omit their trailing param (returns the blank template)', async () => {
  const r = one(await call('cron_manage', 'settingsGetJob'));
  assert.deepEqual([r.method, r.path], ['GET', '/api/cron/settings/get_job']);
});

test('aliasGetAliasUUID takes name, or alias as a synonym', async () => {
  for (const params of [{ name: 'iot_allowed_ports' }, { alias: 'iot_allowed_ports' }]) {
    const r = one(await call('firewall_manage', 'aliasGetAliasUUID', params));
    assert.equal(r.path, '/api/firewall/alias/get_alias_u_u_i_d/iot_allowed_ports', JSON.stringify(params));
  }
});

test('same method name in different modules uses that module\'s signature', async () => {
  // core serviceRestart(name, id) vs unbound serviceRestart(data): the old name-keyed table
  // demanded "name" for every module's serviceRestart.
  const u = one(await call('unbound_manage', 'serviceRestart'));
  assert.deepEqual([u.method, u.path], ['POST', '/api/unbound/service/restart']);
  const c = one(await call('core_manage', 'serviceRestart', { name: 'unbound' }));
  assert.deepEqual([c.method, c.path], ['POST', '/api/core/service/restart/unbound']);
  // ids settingsToggleRule(sids, enabled) vs trafficshaper settingsToggleRule(uuid, enabled)
  const ids = one(await call('ids_manage', 'settingsToggleRule', { sid: '2010935', enabled: '0' }));
  assert.equal(ids.path, '/api/ids/settings/toggle_rule/2010935/0');
  const ts = one(await call('trafficshaper_manage', 'settingsToggleRule', { uuid: 't1', enabled: '1' }));
  assert.equal(ts.path, '/api/trafficshaper/settings/toggle_rule/t1/1');
});

test('every path param of every tool method is offered in its schema', () => {
  const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools-generated.json'), 'utf8')).tools;
  const cron = tools.find((t) => t.name === 'cron_manage').inputSchema.properties.params.properties;
  assert.ok(cron.uuid && cron.enabled);
  const ipsec = tools.find((t) => t.name === 'ipsec_manage').inputSchema.properties.params.properties;
  assert.ok(ipsec.ikeid && ipsec.seqid, 'derived path params (ikeid/seqid) present');
});

test('dNatToggleRule maps enabled to its inverted "disabled" path segment', async () => {
  // d_nat/toggle_rule/{uuid}/{disabled}: the old mapper sent enabled=1 into the disabled slot,
  // which disabled the port forward the caller asked to enable.
  const on = one(await call('firewall_manage', 'dNatToggleRule', { uuid: 'n1', enabled: '1' }));
  assert.equal(on.path, '/api/firewall/d_nat/toggle_rule/n1/0');
  const off = one(await call('firewall_manage', 'dNatToggleRule', { uuid: 'n1', enabled: '0' }));
  assert.equal(off.path, '/api/firewall/d_nat/toggle_rule/n1/1');
  const flip = one(await call('firewall_manage', 'dNatToggleRule', { uuid: 'n1' }));
  assert.equal(flip.path, '/api/firewall/d_nat/toggle_rule/n1');
  const explicit = one(await call('firewall_manage', 'dNatToggleRule', { uuid: 'n1', disabled: '1' }));
  assert.equal(explicit.path, '/api/firewall/d_nat/toggle_rule/n1/1');
});

// Sweep: call every method of every tool (plugins included) with all of its schema params filled.
// No request may carry an unmapped value, and nothing may fail param validation.
test('sweep: no method sends [object Object], undefined or null in its URL', async () => {
  const listed = await rpc('tools/list', {});
  const bad = [];
  let calls = 0;
  for (const tool of listed.result.tools) {
    const props = tool.inputSchema.properties.params.properties;
    const params = { data: {}, confirm: true };
    for (const [k, v] of Object.entries(props)) {
      if (v.type === 'string' && k !== 'searchPhrase') params[k] = `v_${k}`;
    }
    for (const m of tool.inputSchema.properties.method.enum) {
      calls++;
      const { res, requests: rs } = await call(tool.name, m, params);
      const text = JSON.stringify(res);
      if (res?.isError || /requires parameter|Error calling/.test(text)) bad.push(`${tool.name}.${m}: ${text.slice(0, 120)}`);
      for (const r of rs) if (/\[object|undefined|null/.test(r.path)) bad.push(`${tool.name}.${m}: ${r.method} ${r.path}`);
    }
  }
  assert.ok(calls > 2000, `swept ${calls} methods`);
  assert.deepEqual(bad, []);
});

