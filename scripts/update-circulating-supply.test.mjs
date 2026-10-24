import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MINT, TOKEN_PROGRAM, RPC_ID, RPC_URL, MAX_RESPONSE_BYTES, MAX_SUPPLY_RAW,
  decodeMintAccount, decimalSupply, fetchMintSnapshot, renderSupplyFiles, updateCirculatingSupply, validateRpcResponse,
} from './update-circulating-supply.mjs';

function mintData(raw = MAX_SUPPLY_RAW, extended = true) {
  const data = Buffer.alloc(extended ? 234 : 82);
  data.writeBigUInt64LE(raw, 36); data[44] = 6; data[45] = 1;
  if (extended) { data[165] = 1; data.writeUInt16LE(18, 166); data.writeUInt16LE(64, 168); }
  return data;
}
function account(data = mintData()) { return { owner: TOKEN_PROGRAM, executable: false, data: [data.toString('base64'), 'base64'], space: data.length }; }
function rpc(value = account()) { return { jsonrpc: '2.0', id: RPC_ID, result: { context: { slot: 460613390 }, value } }; }
function response(body = rpc()) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); }
const FIXED_TIME = new Date('2026-10-24T18:00:00.000Z');

test('mint decoder accepts base and extended Token-2022 mints and exact fractional burns', () => {
  assert.deepEqual(decodeMintAccount(account()), { supplyRaw: MAX_SUPPLY_RAW, decimals: 6 });
  assert.equal(decodeMintAccount(account(mintData(MAX_SUPPLY_RAW - 1n, false))).supplyRaw, 999_999_999_999_999n);
  assert.equal(decimalSupply(MAX_SUPPLY_RAW - 1n), '999999999.999999');
  assert.equal(decimalSupply(1n), '0.000001');
  assert.equal(decimalSupply(1_100_000n), '1.1');
  assert.equal(decimalSupply(0n), '0'); // A verified fully burned mint is valid; errors never become zero.
  const files = renderSupplyFiles({ supplyRaw: MAX_SUPPLY_RAW - 1n, decimals: 6, slot: 123 }, FIXED_TIME.toISOString());
  assert.equal(files['circulating-supply.json'], '{"circulatingSupply":999999999.999999}\n');
  assert.deepEqual(Object.keys(JSON.parse(files['circulating-supply.json'])), ['circulatingSupply']);
  const details = JSON.parse(files['supply-details.json']);
  assert.equal(details.totalSupplyRaw, '999999999999999');
  assert.equal(details.excludedSupplyRaw, '0');
  assert.equal(details.commitment, 'finalized');
  assert.match(details.methodology, /Voluntary Season Pass deposits remain included/);
});

test('rejects wrong owner, executable account, unexpected decimals, initialization and authorities', () => {
  assert.throws(() => decodeMintAccount({ ...account(), owner: '11111111111111111111111111111111' }), /Token-2022/);
  assert.throws(() => decodeMintAccount({ ...account(), executable: true }), /Token-2022/);
  for (const [offset, value] of [[44, 9], [45, 0], [45, 2]]) {
    const data = mintData(); data[offset] = value;
    assert.throws(() => decodeMintAccount(account(data)), /initialized mint/);
  }
  for (const offset of [0, 46]) for (const value of [1, 2]) {
    const data = mintData(); data.writeUInt32LE(value, offset);
    assert.throws(() => decodeMintAccount(account(data)), /authorities/);
  }
  assert.throws(() => decodeMintAccount(account(mintData(MAX_SUPPLY_RAW + 1n))), /ceiling/);
});

test('rejects token accounts, malformed mint sizes, encoding, padding and TLV boundaries', () => {
  for (const size of [0, 81, 83, 165, 355]) assert.throws(() => decodeMintAccount(account(Buffer.alloc(size))));
  for (const change of [
    (d) => { d[165] = 2; },
    (d) => { d[82] = 1; },
    (d) => { d.writeUInt16LE(500, 168); },
  ]) { const data = mintData(); change(data); assert.throws(() => decodeMintAccount(account(data))); }
  assert.throws(() => decodeMintAccount({ ...account(), data: ['@@@', 'base64'] }));
  assert.throws(() => decodeMintAccount({ ...account(), data: [mintData().toString('base64'), 'base58'] }));
  assert.throws(() => decodeMintAccount({ ...account(), space: 999 }));
  assert.throws(() => decodeMintAccount(null));
});

test('requires matching JSON-RPC envelope, successful result and safe context slot', () => {
  for (const body of [null, [], { ...rpc(), jsonrpc: '1.0' }, { ...rpc(), id: 1 },
    { ...rpc(), error: { code: -32000, message: 'upstream failure' } },
    { jsonrpc: '2.0', id: RPC_ID }, { ...rpc(), result: null }]) {
    assert.throws(() => validateRpcResponse(body));
  }
  for (const slot of [0, -1, 1.1, '123', Number.MAX_SAFE_INTEGER + 1]) {
    const body = rpc(); body.result.context.slot = slot;
    assert.throws(() => validateRpcResponse(body), /slot/);
  }
});

test('uses only fixed public RPC, fixed MEAT mint and finalized read; rejects redirects', async () => {
  let calls = 0;
  const snapshot = await fetchMintSnapshot({ fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, RPC_URL); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.signal.aborted, false);
    assert.deepEqual(JSON.parse(init.body), { jsonrpc: '2.0', id: RPC_ID, method: 'getAccountInfo', params: [MINT, { encoding: 'base64', commitment: 'finalized' }] });
    return response();
  } });
  assert.equal(calls, 1); assert.equal(snapshot.supplyRaw, MAX_SUPPLY_RAW);
  await assert.rejects(fetchMintSnapshot({ fetchImpl: async () => new Response('', { status: 302, headers: { location: 'https://example.invalid/' } }) }), /HTTP request failed/);
});

test('rejects HTTP errors, non-JSON, malformed JSON, advertised and streamed oversized responses', async () => {
  const badResponses = [
    () => new Response('unavailable', { status: 503 }),
    () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
    () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json' } }),
    () => new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'application/json' } }),
  ];
  for (const bad of badResponses) await assert.rejects(fetchMintSnapshot({ fetchImpl: async () => bad() }));
});

test('timeout covers stalled response body as well as connection establishment', async () => {
  await assert.rejects(fetchMintSnapshot({ timeoutMs: 15, fetchImpl: async (_url, { signal }) => {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } }), /timed out/);
  await assert.rejects(fetchMintSnapshot({ timeoutMs: 15, fetchImpl: async (_url, { signal }) => {
    const body = new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); } });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  } }), /timed out/);
});

test('writes both valid snapshots and preserves existing bytes on RPC/validation failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'streetmeat-supply-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'circulating-supply.json'), 'old-number\n');
  await writeFile(join(dir, 'supply-details.json'), 'old-details\n');
  for (const fetchImpl of [
    async () => { throw new Error('network unavailable'); },
    async () => response({ ...rpc(), error: { code: -32000 } }),
    async () => response(rpc({ ...account(), owner: 'wrong-owner' })),
    async () => response(rpc(null)),
  ]) {
    await assert.rejects(updateCirculatingSupply({ outputDir: dir, fetchImpl }));
    assert.equal(await readFile(join(dir, 'circulating-supply.json'), 'utf8'), 'old-number\n');
    assert.equal(await readFile(join(dir, 'supply-details.json'), 'utf8'), 'old-details\n');
    assert.deepEqual((await readdir(dir)).sort(), ['circulating-supply.json', 'supply-details.json']);
  }
  const result = await updateCirculatingSupply({ outputDir: dir, fetchImpl: async () => response(rpc(account(mintData(MAX_SUPPLY_RAW - 1n)))), now: () => FIXED_TIME });
  assert.equal(result.circulatingSupplyDecimal, '999999999.999999');
  assert.equal(await readFile(join(dir, 'circulating-supply.json'), 'utf8'), '{"circulatingSupply":999999999.999999}\n');
  const details = JSON.parse(await readFile(join(dir, 'supply-details.json'), 'utf8'));
  assert.equal(details.checkedAt, FIXED_TIME.toISOString()); assert.equal(details.slot, 460613390);
  assert.deepEqual((await readdir(dir)).sort(), ['circulating-supply.json', 'supply-details.json']);
});
