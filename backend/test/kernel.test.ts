import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  RpcRequestError,
  concatHex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  toFunctionSelector,
  toHex,
} from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { entryPoint07Abi } from 'viem/account-abstraction';
import { bsc } from 'viem/chains';
import {
  KERNEL_V3_3_ADDRESSES,
  KERNEL_VERSION_STRING,
  kernelAddressesForChain,
} from '../src/addresses.js';
import {
  computeCounterfactualAddress,
  computeSalt,
  getKernelAccountParams,
} from '../src/kernel.js';

/**
 * Kernel v3.3 帳戶參數（由 @zerodev/sdk 產生）的單元測試（不需要鏈）。
 *
 * 參照向量 test/fixtures/kernel-golden.json 由一次性腳本 scripts/gen-kernel-golden.ts 產生，產生者
 * 版本記在 fixture 的 generatedWith。這裡只讀 fixture，不 import 產生它的套件。
 */

type GoldenVector = {
  kernelVersion: string;
  chainId: number;
  factory: string;
  owner: `0x${string}`;
  strategyId: string;
  saltDomainTag: string;
  index: string;
  factoryData: string;
  expectedAddress: string;
  expectedRootValidator: string;
  validator: string;
  decoded: {
    deployWithFactory: { selector: string; kernelFactory: string; createData: string; salt: string };
    initialize: {
      selector: string;
      rootValidator: string;
      hook: string;
      validatorData: string;
      hookData: string;
      initConfig: string[];
    };
  };
  generatedWith: { permissionless: string; viem: string };
  note: string;
};

/** MetaFactory 外層呼叫：deployWithFactory(address factory, bytes createData, bytes32 salt)。 */
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

/** Kernel v3.1+ 帳戶的 initialize（rootValidator 是 bytes21 的 ValidationId）。 */
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

const golden = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/kernel-golden.json', import.meta.url)), 'utf8'),
) as GoldenVector;

const OWNER = golden.owner;
const STRATEGY_ID = BigInt(golden.strategyId);
const GOLDEN_SALT = golden.index as Hex;

/** 大小寫不是差異（同一組 bytes），但整串 hex 一定要比完。 */
const lower = (hex: string): string => hex.toLowerCase();

// ---------------------------------------------------------------------------
// EntryPoint stub：SDK 推導地址時只會打 eth_chainId 與 eth_call 兩支
// ---------------------------------------------------------------------------

type EntryPointCall = { to?: Address; data?: Hex };

/** getSenderAddress 的正常回應：EntryPoint 以 SenderAddressResult(address) revert 帶回地址。 */
function senderAddressResult(address: Address): Hex {
  return concatHex([
    toFunctionSelector('SenderAddressResult(address)'),
    encodeAbiParameters([{ type: 'address' }], [address]),
  ]);
}

/** factory / EntryPoint 自己帶原因時的 revert：selector 0x08c379a0 + abi 編碼的字串。 */
function errorStringResult(reason: string): Hex {
  return concatHex(['0x08c379a0', encodeAbiParameters([{ type: 'string' }], [reason])]);
}

/**
 * 只回答 eth_chainId / eth_call 的 publicClient：`answer` 依序決定每次 getSenderAddress 該 revert
 * 什麼（EntryPoint 的地址查詢是 revert-based，所以「回地址」就是「revert 這個 data」）。
 */
function entryPointStub(answer: (call: EntryPointCall, index: number) => Hex): {
  client: PublicClient;
  calls: EntryPointCall[];
} {
  const calls: EntryPointCall[] = [];
  const client = {
    chain: bsc,
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_chainId') return toHex(56);
      if (method === 'eth_call') {
        const call = (params as [EntryPointCall])[0];
        calls.push(call);
        throw new RpcRequestError({
          body: {},
          url: 'stub',
          error: { code: 3, message: 'execution reverted', data: answer(call, calls.length - 1) },
        });
      }
      throw new Error(`stub: 不支援的 RPC method ${method}`);
    },
  } as unknown as PublicClient;
  return { client, calls };
}

/**
 * 只認得 golden init code 的 EntryPoint：calldata 差一個 byte 就 revert 成「算不出地址」。
 * 這樣「地址等於 fixture」就不是把 fixture 的地址讀回去，而是「問到的 init code 必須逐 byte 相同」。
 */
function goldenEntryPoint(): { client: PublicClient; calls: EntryPointCall[] } {
  const expectedInitCode = lower(concatHex([golden.factory as Hex, golden.factoryData as Hex]));
  return entryPointStub((call) => {
    const [initCode] = decodeFunctionData({
      abi: entryPoint07Abi,
      data: call.data as Hex,
    }).args as [Hex];
    if (lower(initCode) !== expectedInitCode) {
      return errorStringResult(`init code 不是 golden vector：${initCode}`);
    }
    return senderAddressResult(golden.expectedAddress as Address);
  });
}

// ---------------------------------------------------------------------------
// salt
// ---------------------------------------------------------------------------

test('computeSalt: 固定 (owner, strategyId) 對上 golden vector 的 index', () => {
  assert.equal(lower(computeSalt(OWNER, STRATEGY_ID)), lower(golden.index));
  assert.equal(golden.saltDomainTag.length > 0, true);
});

test('computeSalt: 同輸入穩定、不同 strategyId 給不同 salt、輸出是 32-byte hex', () => {
  const salt = computeSalt(OWNER, STRATEGY_ID);
  assert.match(salt, /^0x[0-9a-f]{64}$/);
  assert.equal(salt, computeSalt(OWNER, STRATEGY_ID));
  assert.notEqual(lower(computeSalt(OWNER, STRATEGY_ID + 1n)), lower(salt));
  assert.notEqual(lower(computeSalt(OWNER, 0n)), lower(salt));
});

// ---------------------------------------------------------------------------
// getKernelAccountParams：本檔最關鍵的 byte-level 比對
// ---------------------------------------------------------------------------

test('getKernelAccountParams: factoryData 與 golden vector 完整 hex 相同', async () => {
  const { client } = goldenEntryPoint();

  const fromGoldenSalt = await getKernelAccountParams(client, OWNER, GOLDEN_SALT);
  assert.equal(lower(fromGoldenSalt.factoryData), lower(golden.factoryData));

  const fromComputedSalt = await getKernelAccountParams(client, OWNER, computeSalt(OWNER, STRATEGY_ID));
  assert.equal(lower(fromComputedSalt.factoryData), lower(golden.factoryData));
});

test('getKernelAccountParams: factory 是 Kernel MetaFactory（不是 KernelFactory）', async () => {
  const { client } = goldenEntryPoint();

  const { factory } = await getKernelAccountParams(client, OWNER, GOLDEN_SALT);

  assert.equal(lower(factory), lower(golden.factory));
  assert.equal(lower(factory), lower(KERNEL_V3_3_ADDRESSES.kernelMetaFactory));
  assert.equal(
    lower(factory),
    lower('0xd703aaE79538628d27099B8c4f621bE4CCd142d5'),
    'MetaFactory 地址是 fixture 釘死的常數，不是 SDK 說了算',
  );
  // 靜默 fallback 的哨兵：SDK 若偷偷改用 KernelFactory，下方斷言就會紅。
  assert.notEqual(
    lower(factory),
    lower(KERNEL_V3_3_ADDRESSES.kernelFactoryV33),
    'factory 不可以是 KernelFactory（0x2577507b78c2008Ff367261CB6285d44ba5eF2E9）：那條路徑算出不同地址',
  );
  assert.notEqual(lower(factory), lower('0x2577507b78c2008Ff367261CB6285d44ba5eF2E9'));
});

test('getKernelAccountParams: counterfactual 地址等於 golden vector 的 expectedAddress', async () => {
  const { client, calls } = goldenEntryPoint();

  const { address } = await getKernelAccountParams(client, OWNER, GOLDEN_SALT);

  assert.equal(lower(address), lower(golden.expectedAddress));
  assert.equal(lower(address), lower('0xa54971f72BCC64a849fF66B48EC8d7699B37399c'));
  assert.equal(getAddress(address), getAddress(golden.expectedAddress));
  // 地址是「EntryPoint 對 golden init code 的答案」：證明問的是同一段 calldata。
  assert.equal(calls.length, 1, '地址推導只能問 EntryPoint 一次');
  assert.equal(lower(calls[0]?.to as string), lower(KERNEL_V3_3_ADDRESSES.entryPointV07));
  assert.equal(
    lower(calls[0]?.data as string),
    lower(
      encodeFunctionData({
        abi: entryPoint07Abi,
        functionName: 'getSenderAddress',
        args: [concatHex([golden.factory as Hex, golden.factoryData as Hex])],
      }),
    ),
    'getSenderAddress 的 init code 必須逐 byte 等於 fixture 的 factory ++ factoryData',
  );
});

test('getKernelAccountParams: 產生的 factoryData 拆解後與 golden vector 的內外層參數一致', async () => {
  const { client } = goldenEntryPoint();
  const { factoryData } = await getKernelAccountParams(client, OWNER, GOLDEN_SALT);

  const outer = decodeFunctionData({ abi: META_FACTORY_ABI, data: factoryData });
  assert.equal(outer.functionName, 'deployWithFactory');
  assert.equal(factoryData.slice(0, 10), golden.decoded.deployWithFactory.selector);
  const [kernelFactory, createData, salt] = outer.args;
  assert.equal(lower(kernelFactory), lower(golden.decoded.deployWithFactory.kernelFactory));
  assert.equal(lower(kernelFactory), lower(KERNEL_V3_3_ADDRESSES.kernelFactoryV33));
  assert.equal(lower(salt), lower(golden.index));
  assert.equal(lower(createData), lower(golden.decoded.deployWithFactory.createData));

  const inner = decodeFunctionData({ abi: INITIALIZE_ABI, data: createData });
  assert.equal(inner.functionName, 'initialize');
  assert.equal(createData.slice(0, 10), golden.decoded.initialize.selector);
  const [rootValidator, hook, validatorData, hookData, initConfig] = inner.args;
  assert.equal(lower(rootValidator), lower(golden.decoded.initialize.rootValidator));
  assert.equal(lower(rootValidator), lower(golden.expectedRootValidator));
  assert.equal(rootValidator.length, 2 + 21 * 2, 'rootValidator 是 bytes21（0x01 ++ validator 地址）');
  assert.equal(lower(rootValidator), lower(`0x01${KERNEL_V3_3_ADDRESSES.ecdsaValidatorV31.slice(2)}`));
  assert.equal(lower(`0x${rootValidator.slice(4)}`), lower(golden.validator));
  assert.equal(lower(hook), lower(golden.decoded.initialize.hook));
  assert.equal(lower(validatorData), lower(golden.decoded.initialize.validatorData));
  assert.equal(lower(validatorData), lower(OWNER));
  assert.equal(hookData, '0x');
  assert.deepEqual(initConfig, []);
});

test('getKernelAccountParams: 不帶 plugin 是預設（下一刀的 session key 從 options 進來）', async () => {
  const { client } = goldenEntryPoint();

  // 不傳 options 與明確傳空 options 的結果必須一模一樣：預設路徑不含任何額外 plugin。
  const withoutOptions = await getKernelAccountParams(client, OWNER, GOLDEN_SALT);
  const withEmptyOptions = await getKernelAccountParams(client, OWNER, GOLDEN_SALT, {});

  assert.deepEqual(withEmptyOptions, withoutOptions);
  assert.equal(lower(withEmptyOptions.factoryData), lower(golden.factoryData));
});

// ---------------------------------------------------------------------------
// 靜默 fallback 與錯誤硬化（stub publicClient，不需要鏈）
// ---------------------------------------------------------------------------

test('getKernelAccountParams: SDK 靜默 fallback 到 KernelFactory 時拋錯，不採用那個地址', async () => {
  // MetaFactory 路徑模擬不出地址（零地址），SDK 會改問 KernelFactory 並拿到非零地址：
  // 若不設哨兵，這裡就會安靜地回一個與 MetaFactory 不同的帳戶地址。
  const fallbackAddress = getAddress('0x0000000000000000000000000000000000000bad');
  const { client, calls } = entryPointStub((_call, index) =>
    index === 0 ? senderAddressResult('0x0000000000000000000000000000000000000000') : senderAddressResult(fallbackAddress),
  );

  await assert.rejects(
    () => getKernelAccountParams(client, OWNER, GOLDEN_SALT),
    (error: Error) => {
      assert.match(error.message, /MetaFactory/);
      assert.match(error.message, /KernelFactory/);
      assert.ok(
        error.message.includes(KERNEL_V3_3_ADDRESSES.kernelFactoryV33),
        '錯誤訊息要帶 KernelFactory 地址，才看得出是被 fallback 帶走',
      );
      return true;
    },
  );
  assert.equal(calls.length, 2, 'SDK 確實問了第二次（fallback），哨兵在它之後把結果擋下來');
});

test('getKernelAccountParams: 算不出地址時拋錯，而不是回傳零地址', async () => {
  const zero = '0x0000000000000000000000000000000000000000' as Address;
  const { client } = entryPointStub(() => senderAddressResult(zero));

  await assert.rejects(
    () => getKernelAccountParams(client, OWNER, GOLDEN_SALT),
    (error: Error) => {
      assert.match(error.message, /零地址/);
      assert.match(error.message, /factory 可能 revert/);
      assert.ok(
        error.message.includes(KERNEL_V3_3_ADDRESSES.entryPointV07),
        '錯誤訊息要帶 EntryPoint 地址，才查得出是哪條鏈的 EntryPoint',
      );
      return true;
    },
  );
});

test('computeCounterfactualAddress: EntryPoint 回零地址時也拋錯（不把零地址當結果）', async () => {
  const zero = '0x0000000000000000000000000000000000000000' as Address;
  const { client } = entryPointStub(() => senderAddressResult(zero));

  await assert.rejects(() => computeCounterfactualAddress(client, OWNER, GOLDEN_SALT), /零地址/);
});

test('getKernelAccountParams: EntryPoint 以 Error(string) revert 時，錯誤訊息帶著原因', async () => {
  const { client } = entryPointStub(() => errorStringResult('some reason'));

  await assert.rejects(
    () => getKernelAccountParams(client, OWNER, GOLDEN_SALT),
    (error: Error) => {
      assert.match(error.message, /some reason/);
      assert.ok(
        error.message.includes(KERNEL_V3_3_ADDRESSES.entryPointV07),
        '錯誤訊息要指出是哪個 EntryPoint 打不通',
      );
      return true;
    },
  );
});

test('getKernelAccountParams: revert 被包在 cause 裡（RPC 庫常見形狀）仍解得出地址', async () => {
  // viem 會把 transport 的錯誤包成 CallExecutionError / ContractFunctionExecutionError，真正的 revert
  // data 在 cause 鏈上；地址仍然要解得出來，否則鏈上一有錯誤包裝就推導不出帳戶。
  const counterfactual = getAddress('0x0000000000000000000000000000000000000bad');
  const client = {
    chain: bsc,
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return toHex(56);
      const revert = new RpcRequestError({
        body: {},
        url: 'stub',
        error: { code: 3, message: 'execution reverted', data: senderAddressResult(counterfactual) },
      });
      throw Object.assign(new Error('CallExecutionError'), { details: 'execution reverted', cause: revert });
    },
  } as unknown as PublicClient;

  const { address } = await getKernelAccountParams(client, OWNER, GOLDEN_SALT);

  assert.equal(address, counterfactual);
});

test('getKernelAccountParams: 缺 publicClient / salt 不對時，錯誤訊息可診斷', async () => {
  await assert.rejects(
    () => getKernelAccountParams(undefined as unknown as PublicClient, OWNER, GOLDEN_SALT),
    (error: Error) => {
      assert.match(error.message, /publicClient/);
      assert.match(error.message, /counterfactual 地址/);
      return true;
    },
  );

  const { client } = entryPointStub(() => senderAddressResult('0x0000000000000000000000000000000000000bad'));

  await assert.rejects(
    () => getKernelAccountParams(client, OWNER, '0x1234' as Hex),
    (error: Error) => {
      assert.match(error.message, /salt/);
      assert.match(error.message, /32-byte hex/);
      return true;
    },
  );

  await assert.rejects(
    () => getKernelAccountParams(client, '' as Address, GOLDEN_SALT),
    /owner/,
  );
});

// ---------------------------------------------------------------------------
// canonical 常數與依賴邊界
// ---------------------------------------------------------------------------

test('kernelAddressesForChain: 56 與 31337 共用同一組 canonical 位址，其他 chainId throw', () => {
  assert.deepEqual(kernelAddressesForChain(56), KERNEL_V3_3_ADDRESSES);
  assert.deepEqual(kernelAddressesForChain(31337), KERNEL_V3_3_ADDRESSES);
  assert.throws(() => kernelAddressesForChain(1), /Unsupported chainId 1/);
  assert.equal(KERNEL_VERSION_STRING, golden.kernelVersion);
});

test('src/ 底下沒有任何檔案提到參照向量套件（它只能是 devDependency）', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const files = readdirSync(srcDir, { recursive: true }).filter((entry) => String(entry).endsWith('.ts'));
  assert.ok(files.length > 0, 'src/ 應該要有 .ts 檔');

  const offenders = files
    .map((file) => String(file))
    .filter((file) => readFileSync(`${srcDir}/${file}`, 'utf8').toLowerCase().includes('permissionless'));
  assert.deepEqual(offenders, []);
});
