#!/usr/bin/env node
// Public, dependency-free snapshot updater. It never signs or submits transactions.
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MINT = 'BTCxVi7u6DSKbRohALwMay2i4PDsiejKqoSmMDeWpump';
export const TOKEN_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const DECIMALS = 6;
export const MAX_SUPPLY_RAW = 1_000_000_000_000_000n;
export const RPC_URL = 'https://api.mainnet-beta.solana.com';
export const RPC_ID = 'streetmeat-supply-v1';
export const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ACCOUNT_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL('../docs/api/', import.meta.url));
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => { throw new Error(message); };

/** SPL mint base layout: supply u64@36, decimals@44, initialized@45, authorities@0/46.
 * Token-2022 extended mints have 83 padding bytes and AccountType.Mint=1 at 165.
 * Layout agrees with @solana/spl-token unpackMint; no SDK is shipped or required here.
 */
export function decodeMintAccount(account) {
  if (!record(account) || account.owner !== TOKEN_PROGRAM || account.executable !== false) {
    fail('Expected a non-executable Token-2022 mint account.');
  }
  if (!Array.isArray(account.data) || account.data.length !== 2 || account.data[1] !== 'base64') {
    fail('Expected base64 account data.');
  }
  const encoded = account.data[0];
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_ACCOUNT_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    fail('Invalid or oversized base64 mint data.');
  }
  const data = Buffer.from(encoded, 'base64');
  if (data.length > MAX_ACCOUNT_BYTES || data.toString('base64') !== encoded || data.length < 82 ||
      (Object.hasOwn(account, 'space') && account.space !== data.length)) fail('Invalid mint account size.');
  if (data.length !== 82) {
    if (data.length < 166 || data.length === 355 || data[165] !== 1 || data.subarray(82, 165).some((b) => b !== 0)) {
      fail('Invalid Token-2022 mint account type or padding.');
    }
    // Validate TLV boundaries without interpreting optional metadata or copying it to the output.
    let offset = 166;
    const extensions = new Set();
    while (offset < data.length) {
      if (data.subarray(offset).every((b) => b === 0)) break;
      if (offset + 4 > data.length) fail('Truncated mint extension header.');
      const type = data.readUInt16LE(offset), length = data.readUInt16LE(offset + 2);
      if (type === 0 || extensions.has(type) || offset + 4 + length > data.length) fail('Invalid mint extensions.');
      extensions.add(type);
      offset += 4 + length;
    }
  }
  if (data[44] !== DECIMALS || data[45] !== 1) fail('Expected an initialized mint with six decimals.');
  if (data.readUInt32LE(0) !== 0 || data.readUInt32LE(46) !== 0) fail('Mint and freeze authorities must be disabled.');
  const supplyRaw = data.readBigUInt64LE(36);
  if (supplyRaw > MAX_SUPPLY_RAW) fail('Mint supply exceeds the verified one-billion-token ceiling.');
  return { supplyRaw, decimals: DECIMALS };
}

export function validateRpcResponse(body) {
  if (!record(body) || body.jsonrpc !== '2.0' || body.id !== RPC_ID ||
      Object.hasOwn(body, 'error') || !Object.hasOwn(body, 'result')) fail('Invalid or unsuccessful JSON-RPC response.');
  const result = body.result;
  if (!record(result) || !record(result.context) || !Number.isSafeInteger(result.context.slot) || result.context.slot <= 0) {
    fail('Missing or invalid finalized context slot.');
  }
  return { ...decodeMintAccount(result.value), slot: result.context.slot };
}

async function readBoundedJson(response) {
  if (!response.ok) fail(`RPC HTTP request failed (${response.status}).`);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) fail('RPC did not return JSON.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) fail('RPC response is too large.');
  if (!response.body) fail('RPC returned no body.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail('RPC response is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))); }
  catch { fail('RPC returned malformed JSON.'); }
  return body;
}

export async function fetchMintSnapshot({ fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) fail('Invalid RPC timeout.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(RPC_URL, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: RPC_ID, method: 'getAccountInfo',
        params: [MINT, { encoding: 'base64', commitment: 'finalized' }] }),
    });
    return validateRpcResponse(await readBoundedJson(response));
  } catch (error) {
    if (controller.signal.aborted) fail('RPC request timed out; existing snapshots were preserved.');
    throw error;
  } finally { clearTimeout(timer); }
}

/** Produces a decimal numeric literal from integers; never converts supply through Number. */
export function decimalSupply(supplyRaw) {
  if (typeof supplyRaw !== 'bigint' || supplyRaw < 0n || supplyRaw > MAX_SUPPLY_RAW) fail('Invalid raw supply.');
  const scale = 10n ** BigInt(DECIMALS);
  const fraction = (supplyRaw % scale).toString().padStart(DECIMALS, '0').replace(/0+$/, '');
  return `${supplyRaw / scale}${fraction ? `.${fraction}` : ''}`;
}

export function renderSupplyFiles(snapshot, checkedAt = new Date().toISOString()) {
  if (!record(snapshot) || snapshot.decimals !== DECIMALS || !Number.isSafeInteger(snapshot.slot) || snapshot.slot <= 0) fail('Invalid snapshot.');
  if (typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt)) || new Date(checkedAt).toISOString() !== checkedAt) fail('Invalid check timestamp.');
  const decimal = decimalSupply(snapshot.supplyRaw);
  const details = {
    mint: MINT, tokenProgram: TOKEN_PROGRAM, decimals: DECIMALS,
    totalSupplyRaw: snapshot.supplyRaw.toString(), circulatingSupplyRaw: snapshot.supplyRaw.toString(),
    circulatingSupplyDecimal: decimal, excludedSupplyRaw: '0', excludedSupply: 0,
    slot: snapshot.slot, commitment: 'finalized', checkedAt,
    source: { rpc: RPC_URL, method: 'getAccountInfo', encoding: 'base64' },
    methodology: 'Circulating supply equals the current on-chain mint supply. Voluntary Season Pass deposits remain included: these tokens have already been distributed to holders. No treasury, team, vesting or other reserved allocation is excluded. Changes to mint supply, including burns, are reflected on refresh.',
    userAttestation: { by: 'mikeminer', date: '2026-10-24', statement: 'The project owner confirmed that there are no other reserved allocations to exclude.' },
    mintAuthority: null, freezeAuthority: null,
    freshness: 'This is a snapshot at checkedAt, not a live RPC response. A failed refresh preserves the previous snapshot and its timestamp.',
  };
  return {
    'circulating-supply.json': `{"circulatingSupply":${decimal}}\n`,
    'supply-details.json': `${JSON.stringify(details, null, 2)}\n`,
  };
}

/** Stage both validated outputs, then atomically replace each file. The public number is replaced last.
 * GitHub Pages publishes both from one successful workflow artifact; a failed refresh must not deploy.
 */
async function writeSupplyFiles(outputDir, files) {
  const directory = resolve(outputDir);
  await mkdir(directory, { recursive: true });
  const staged = [];
  try {
    for (const name of ['supply-details.json', 'circulating-supply.json']) {
      const temporary = resolve(directory, `.${name}.${randomUUID()}.tmp`);
      staged.push({ temporary, target: resolve(directory, name) });
      const handle = await open(temporary, 'wx', 0o644);
      try { await handle.writeFile(files[name], 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
    }
    for (const { temporary, target } of staged) await rename(temporary, target);
  } finally {
    for (const { temporary } of staged) await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function updateCirculatingSupply({ outputDir = DEFAULT_OUTPUT_DIR, fetchImpl, timeoutMs, now = () => new Date() } = {}) {
  const snapshot = await fetchMintSnapshot({ fetchImpl, timeoutMs });
  const files = renderSupplyFiles(snapshot, now().toISOString());
  await writeSupplyFiles(outputDir, files);
  return { ...snapshot, circulatingSupplyDecimal: decimalSupply(snapshot.supplyRaw), outputDir: resolve(outputDir) };
}

// Resolve filesystem paths (including Windows drive letters), not string-built file:// URLs.
const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  updateCirculatingSupply().then((result) => {
    console.log(`MEAT supply snapshot updated: ${result.circulatingSupplyDecimal} tokens at finalized slot ${result.slot}.`);
  }).catch((error) => {
    console.error(`Supply refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exitCode = 1;
  });
}
