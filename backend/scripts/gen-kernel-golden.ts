/**
 * Kernel v3.3 參照向量（golden vector）的產生與回歸檢查。
 *
 * 這支腳本刻意走兩條獨立的路：
 *   1. permissionless 當**外部**參照向量（測試不 import 它，只讀它產生的 fixture）；
 *   2. 本專案的 src/kernel.ts 當被測實作。
 * 兩者都算一次，逐值比對；fixture 的數值全部來自 (1)。
 *
 * fixture 是權威：數值一律由 permissionless 產生，且只有在與本專案實作完全一致時才會寫檔，
 * 交叉檢查失敗就 exit 1 且不動 fixture（測試只讀 fixture，所以編譯期不會發現壞掉的向量）。
 *
 * 用法：
 *   bun scripts/gen-kernel-golden.ts            # 產生並寫入 fixture（交叉檢查失敗則不寫）
 *   bun scripts/gen-kernel-golden.ts --check    # 只比對現有 fixture，不寫檔，差異時 exit 1
 *   CHECK_ONLY=1 bun scripts/gen-kernel-golden.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { decodeFunctionData, createPublicClient, encodePacked, http, keccak256 } from 'viem';
import { bsc } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { toKernelSmartAccount } from 'permissionless/accounts';
import { KERNEL_V3_3_ADDRESSES, KERNEL_VERSION_STRING, SALT_DOMAIN_TAG } from '../src/addresses.js';
import { computeCounterfactualAddress, computeSalt, getKernelAccountParams } from '../src/kernel.js';

// anvil 帳號 #0 的公開測試金鑰，只用在本地／fork；fixture 只是向量，不涉及資金。
const OWNER_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const STRATEGY_ID = 1n;
const FIXTURE_PATH = resolve(import.meta.dir, '../test/fixtures/kernel-golden.json');
const CHECK_ONLY = process.argv.includes('--check') || process.env.CHECK_ONLY === '1';

const META_FACTORY_ABI = [
  {
    type: 'function',
    name: 'deployWithFactory',
    inputs: [
      { name: 'factory', type: 'address' },
      { name: 'createData', type: 'bytes' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'payable',
  },
] as const;

const INITIALIZE_ABI = [
  {
    type: 'function',
    name: 'initialize',
    inputs: [
      { name: '_rootValidator', type: 'bytes21' },
      { name: 'hook', type: 'address' },
      { name: 'validatorData', type: 'bytes' },
      { name: 'hookData', type: 'bytes' },
      { name: 'initConfig', type: 'bytes[]' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// 本地 anvil fork 優先（冷位址查詢走 fork 快取，不會被遠端 RPC 的政策擋掉），其次才是公用節點。
const RPC_CANDIDATES = [
  process.env.GOLDEN_RPC_URL,
  'http://127.0.0.1:8545',
  'https://bsc-rpc.publicnode.com',
].filter((url): url is string => typeof url === 'string' && url.length > 0);

/** hex 的「逐 byte 相同」：同一組 bytes 的大小寫不是差異，長度不同就是不同 bytes。 */
const sameHex = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

async function pickClient() {
  const failures: string[] = [];
  for (const url of RPC_CANDIDATES) {
    try {
      const client = createPublicClient({ chain: bsc, transport: http(url, { timeout: 12_000, retryCount: 1 }) });
      const chainId = await client.getChainId();
      if (chainId !== 56) {
        failures.push(`${url}: chainId ${chainId} != 56`);
        continue;
      }
      const entryPointCode = await client.getCode({ address: KERNEL_V3_3_ADDRESSES.entryPointV07 });
      const metaFactoryCode = await client.getCode({ address: KERNEL_V3_3_ADDRESSES.kernelMetaFactory });
      if (!entryPointCode || entryPointCode === '0x' || !metaFactoryCode || metaFactoryCode === '0x') {
        failures.push(`${url}: EntryPoint/MetaFactory 沒有 code`);
        continue;
      }
      console.log(`RPC: ${url} (chainId ${chainId}, block ${await client.getBlockNumber()})`);
      return { client, url };
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw new Error(`所有 RPC 都不可用:\n  ${failures.join('\n  ')}`);
}

/** 只比對語意（不看 key 順序、不看 note）用的正規化。 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    );
  }
  return value;
}

/** 列出兩個物件的差異路徑，讓 --check 失敗時看得出是哪個欄位。 */
function diffPaths(left: unknown, right: unknown, prefix = ''): string[] {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(left) && isObj(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => diffPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    const out: string[] = [];
    for (let i = 0; i < length; i += 1) {
      if (JSON.stringify(left[i]) !== JSON.stringify(right[i])) out.push(`${prefix}[${i}]`);
    }
    return out;
  }
  return JSON.stringify(left) === JSON.stringify(right) ? [] : [prefix];
}

const { client, url: rpcUrl } = await pickClient();
const owner = privateKeyToAccount(OWNER_PRIVATE_KEY);

// ---- 路 1：permissionless（外部參照向量，fixture 的數值全部來自這裡）----
// salt 也在此「獨立」算一次，不呼叫 computeSalt，避免 fixture 被我方實作污染（稍後再交叉比對）。
const salt = keccak256(
  encodePacked(['string', 'address', 'uint256'], [SALT_DOMAIN_TAG, owner.address, STRATEGY_ID]),
);

const kernel = await toKernelSmartAccount({
  client,
  owners: [owner],
  version: KERNEL_VERSION_STRING,
  index: BigInt(salt),
  entryPoint: { address: entryPoint07Address, version: '0.7' },
});

const { factory, factoryData } = await kernel.getFactoryArgs();
if (!factory || !factoryData) throw new Error('permissionless 沒有回傳完整的 factoryArgs');

// 把 permissionless 實際 encode 的內容拆出來：MetaFactory 外層 → 內層 initialize 參數。
const deployArgs = decodeFunctionData({ abi: META_FACTORY_ABI, functionName: 'deployWithFactory', data: factoryData });
const [kernelFactoryArg, createData, saltArg] = deployArgs.args;
const initArgs = decodeFunctionData({ abi: INITIALIZE_ABI, functionName: 'initialize', data: createData });
const [rootValidator, hook, validatorData, hookData, initConfig] = initArgs.args;
const validatorAddress = `0x${rootValidator.slice(4)}` as const;

const permissionlessVersion = (await Bun.file(
  resolve(import.meta.dir, '../node_modules/permissionless/package.json'),
).json()).version as string;
const viemVersion = (await Bun.file(resolve(import.meta.dir, '../node_modules/viem/package.json')).json())
  .version as string;

const fixture = {
  kernelVersion: KERNEL_VERSION_STRING,
  chainId: 56,
  factory,
  owner: owner.address,
  strategyId: STRATEGY_ID.toString(),
  saltDomainTag: SALT_DOMAIN_TAG,
  index: salt,
  factoryData,
  expectedAddress: kernel.address,
  expectedRootValidator: rootValidator,
  validator: validatorAddress,
  decoded: {
    deployWithFactory: {
      selector: factoryData.slice(0, 10),
      kernelFactory: kernelFactoryArg,
      createData,
      salt: saltArg,
    },
    initialize: {
      selector: createData.slice(0, 10),
      rootValidator,
      hook,
      validatorData,
      hookData,
      initConfig,
    },
  },
  generatedWith: { permissionless: permissionlessVersion, viem: viemVersion },
  note:
    `由 permissionless ${permissionlessVersion} 產生的參照向量（Kernel v3.3 / EntryPoint v0.7 / BSC chainId 56），` +
    `並已用本專案 getKernelAccountParams 獨立複核（factoryData / counterfactual 地址 / decoded 參數逐 byte 一致）。` +
    `測試只讀本檔、不 import permissionless；回歸檢查跑 bun scripts/gen-kernel-golden.ts --check。`,
};

// ---- 路 2：本專案實作（被測對象）----
const own = await getKernelAccountParams(client, owner.address, salt);

const checks: Array<[string, boolean, string]> = [];
checks.push(['computeSalt === index', sameHex(computeSalt(owner.address, STRATEGY_ID), salt), salt]);
checks.push(['factory === MetaFactory', factory === KERNEL_V3_3_ADDRESSES.kernelMetaFactory, factory]);
checks.push([
  'decoded kernelFactory === KERNEL_FACTORY_V33',
  kernelFactoryArg === KERNEL_V3_3_ADDRESSES.kernelFactoryV33,
  kernelFactoryArg,
]);
checks.push(['decoded salt === index', sameHex(saltArg, salt), saltArg]);
checks.push([
  'validator === ECDSA_VALIDATOR_V31',
  sameHex(validatorAddress, KERNEL_V3_3_ADDRESSES.ecdsaValidatorV31),
  validatorAddress,
]);
checks.push([
  'rootValidator === 0x01 ++ validator',
  sameHex(rootValidator, `0x01${KERNEL_V3_3_ADDRESSES.ecdsaValidatorV31.slice(2)}`),
  rootValidator,
]);
checks.push(['hook === zeroAddress', hook === '0x0000000000000000000000000000000000000000', hook]);
checks.push(['validatorData === owner', sameHex(validatorData, owner.address), validatorData]);
checks.push(['hookData === 0x', hookData === '0x', hookData]);
checks.push(['initConfig empty', initConfig.length === 0, JSON.stringify(initConfig)]);

// 核心交叉檢查：我方實作（@zerodev/sdk）與 permissionless 必須得到同一組部署參數與地址。
checks.push(['getKernelAccountParams factory === permissionless factory', own.factory === factory, own.factory]);
checks.push([
  'getKernelAccountParams factoryData === permissionless factoryData',
  sameHex(own.factoryData, factoryData),
  own.factoryData,
]);
checks.push([
  'getKernelAccountParams address === permissionless address',
  own.address === kernel.address,
  own.address,
]);

try {
  const computed = await computeCounterfactualAddress(client, owner.address, salt);
  checks.push(['computeCounterfactualAddress === expectedAddress', computed === kernel.address, computed]);
} catch (error) {
  checks.push([
    'computeCounterfactualAddress === expectedAddress',
    false,
    error instanceof Error ? error.message.split('\n')[0] : String(error),
  ]);
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed (rpc ${rpcUrl})`);

// ---- 寫檔／回歸檢查 ----
if (CHECK_ONLY) {
  const existing = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
  const { note: _existingNote, ...existingValues } = existing;
  const { note: _generatedNote, ...generatedValues } = fixture;
  const differences = diffPaths(normalize(generatedValues), normalize(existingValues));
  if (differences.length === 0) {
    console.log(`與現有 fixture 一致：${FIXTURE_PATH}（僅 note 不列入比對）`);
  } else {
    console.log(`與現有 fixture 不一致：${FIXTURE_PATH}`);
    for (const path of differences) console.log(`  DIFF ${path}`);
  }
  if (failed > 0 || differences.length > 0) process.exitCode = 1;
  // --check 只比對，不寫檔。
  process.exit();
}

if (failed > 0) {
  console.log(`\n交叉檢查失敗，fixture 未寫入：${FIXTURE_PATH}`);
  process.exitCode = 1;
  process.exit();
}

await mkdir(dirname(FIXTURE_PATH), { recursive: true });
await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`fixture -> ${FIXTURE_PATH}`);
