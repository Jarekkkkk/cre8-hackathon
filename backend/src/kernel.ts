import { addressToEmptyAccount, createKernelAccount, type CreateKernelAccountParameters } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { encodePacked, isAddressEqual, keccak256, zeroAddress } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { KERNEL_V3_3_ADDRESSES, SALT_DOMAIN_TAG } from './addresses.js';

/**
 * Kernel v3.3 smart account 的 counterfactual 部署參數，實作由 `@zerodev/sdk` 提供。
 *
 * 這裡不自己組 `initialize` / `deployWithFactory` 的 calldata：那些位元組決定帳戶地址，交給 SDK
 * 產生（版本對照表由 SDK 維護），本檔只負責本專案自己的 salt 規則、地址護欄與錯誤訊息。
 *
 * 一條不能踩的線：`createKernelAccount` 在 MetaFactory 模擬出零地址時會**靜默改走 KernelFactory**
 * 路徑。兩條路徑的 CREATE2 輸入不同 → 地址不同且不會報錯，所以 `getKernelAccountParams` 明確驗
 * 「factory 必須是 MetaFactory」與「地址不得為零」，不符合就拋錯。
 */

/** EntryPoint v0.7（地址取自 src/addresses.ts，不由 SDK 預設值決定）。 */
const ENTRY_POINT = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;

/** sudo plugin 的型別（SDK 的 plugins 參數）；下一刀的 permission/session-key plugin 從這裡進來。 */
type KernelPlugins = NonNullable<CreateKernelAccountParameters<'0.7', GetKernelVersion<'0.7'>>['plugins']>;

/**
 * 帳戶建構的選配。預設（不傳）＝只有 owner 的 ECDSA sudo validator，等同手寫版本產生的地址。
 *
 * 兩者的差別是這一刀最重要的一條線，寫死在這裡免得又被搞錯：
 *
 * - `plugins.regular` 決定「**誰簽**」，**不影響 counterfactual 地址**。它不進入 init code，
 *   所以只加 regular 時，地址與 factoryData 與完全不傳 options 逐 byte 相同。
 * - `initConfig` 決定「**權限有沒有安裝**」，而且是**唯一**影響地址的東西：它會被寫進
 *   `initialize(...)` 的 initConfig 參數，init code 一變，CREATE2 地址就變。
 *
 * 因此 production 要開 session key 時**兩者必須同時給**：只給 `plugins.regular` 不給 `initConfig`，
 * 帳戶上就沒有安裝那組權限，拿 session key 簽的 userOp 過不了 validation —— 而且因為地址沒變，
 * 整個過程不會有任何錯誤提示。
 *
 * 這條不變量由 test/permissions.test.ts 的「只有 initConfig 改變 counterfactual 地址」釘住。
 */
export type KernelAccountOptions = {
  /** sudo（owner）與 regular（例如 permission plugin）validator。不給 = 只有 owner 的 ECDSA sudo。 */
  plugins?: KernelPlugins;
  /** 隨帳戶建立一起安裝的設定（permission install calldata）。不給 = 不帶，地址維持原樣。 */
  initConfig?: Hex[];
};

/** 一次拿齊部署帳戶所需的三個值：counterfactual 地址、factory、factoryData。 */
export type KernelAccountParams = {
  address: Address;
  factory: Address;
  factoryData: Hex;
};

/**
 * counterfactual 地址的 salt：把 domain tag、owner、strategyId 綁成單一 bytes32。
 * 同一 (owner, strategyId) 永遠得到同一地址；strategyId 不同就是不同帳戶。
 * 這是本專案自訂的規則（不是 Kernel 協議的一部分），所以自己用 viem 算。
 */
export function computeSalt(owner: Address, strategyId: bigint): Hex {
  return keccak256(encodePacked(['string', 'address', 'uint256'], [SALT_DOMAIN_TAG, owner, strategyId]));
}

/**
 * 由 SDK 建出帳戶，回傳 counterfactual 地址與部署參數。
 *
 * `index` 就是我們的 salt：SDK 內部走 `toHex(index, { size: 32 })`，所以
 * `index = BigInt(salt)` 產生的 bytes32 與 `computeSalt` 逐 byte 相同。
 */
export async function getKernelAccountParams(
  publicClient: PublicClient,
  owner: Address,
  salt: Hex,
  options: KernelAccountOptions = {},
): Promise<KernelAccountParams> {
  if (publicClient === undefined || publicClient === null) {
    throw new Error(
      'Kernel 帳戶參數算不出來：需要 publicClient（EntryPoint 的 getSenderAddress 要打鏈）才能推導 counterfactual 地址',
    );
  }
  if (!owner) {
    throw new Error('Kernel 帳戶參數算不出來：owner（帳戶 root validator 的 ECDSA signer）不可為空');
  }
  if (!salt || !/^0x[0-9a-fA-F]{64}$/.test(salt)) {
    throw new Error(`Kernel 帳戶參數算不出來：salt 必須是 32-byte hex（收到 ${String(salt)}）`);
  }

  // 型別放寬成整組 Kernel 版本：SDK 把 initConfig 的型別寫成 `KernelVersion extends "0.3.1" ? Hex[] : never`，
  // 在 "0.3.3" 上會被收窄成 never。執行期仍是 KERNEL_V3_3，行為不受影響。
  const kernelVersion: GetKernelVersion<'0.7'> = KERNEL_V3_3;

  const account = await createKernelAccount(publicClient, {
    plugins: options.plugins ?? { sudo: await sudoValidatorFor(publicClient, owner) },
    entryPoint: ENTRY_POINT,
    kernelVersion,
    // 自訂 salt 當 index；SDK 會 toHex(index, { size: 32 })。
    index: BigInt(salt),
    useMetaFactory: true,
    initConfig: options.initConfig,
  });

  // 刻意不用 account.getFactoryArgs()：viem 的 toSmartAccount 一旦發現帳戶已有 code（也就是冪等重跑
  // 那條路徑）就會回 { factory: undefined }，這裡要的是「無論部署與否都同一組參數」。
  const factory = account.factoryAddress;
  const factoryData = await account.generateInitCode();
  // 零地址不是「算出一個地址」，而是 EntryPoint 沒能建立帳戶（多半是 factory 自己 revert 了）。
  if (isAddressEqual(account.address, zeroAddress)) {
    throw new Error(
      `Kernel 帳戶算不出地址：EntryPoint v0.7 (${KERNEL_V3_3_ADDRESSES.entryPointV07}) 的 getSenderAddress 回傳零地址，` +
        `factory 可能 revert 了（owner=${owner} salt=${salt}）：counterfactual 地址算不出來`,
    );
  }
  // 靜默 fallback 的哨兵：MetaFactory 模擬不出地址時 SDK 會偷改用 KernelFactory，地址因此不同。
  if (!isAddressEqual(factory, KERNEL_V3_3_ADDRESSES.kernelMetaFactory)) {
    throw new Error(
      `Kernel 帳戶的 factory 不是 MetaFactory：拿到 ${factory}，預期 ${KERNEL_V3_3_ADDRESSES.kernelMetaFactory}` +
        `（owner=${owner} salt=${salt}）——這是 @zerodev/sdk 靜默 fallback 到 KernelFactory ` +
        `${KERNEL_V3_3_ADDRESSES.kernelFactoryV33} 的徵兆，該路徑會算出不同的帳戶地址`,
    );
  }

  return { address: account.address, factory, factoryData };
}

/**
 * counterfactual 地址：與部署用的是同一組 (factory, factoryData)，所以地址與實際部署位置必然一致。
 */
export async function computeCounterfactualAddress(
  publicClient: PublicClient,
  owner: Address,
  salt: Hex,
  options: KernelAccountOptions = {},
): Promise<Address> {
  const { address } = await getKernelAccountParams(publicClient, owner, salt, options);
  return address;
}

/**
 * 檢查 EntryPoint 與 MetaFactory 在鏈上有 code。少了任何一個，之後的部署只會變成難查的謎之 revert，
 * 所以在最前面就炸掉，並把塊高一起帶進錯誤訊息。
 */
export async function assertKernelInfraDeployed(publicClient: PublicClient): Promise<void> {
  const blockNumber = await publicClient.getBlockNumber();
  const [entryPointCode, metaFactoryCode] = await Promise.all([
    publicClient.getCode({ address: KERNEL_V3_3_ADDRESSES.entryPointV07, blockNumber }),
    publicClient.getCode({ address: KERNEL_V3_3_ADDRESSES.kernelMetaFactory, blockNumber }),
  ]);
  if (!entryPointCode || entryPointCode === '0x') {
    throw new Error(
      `EntryPoint v0.7 (${KERNEL_V3_3_ADDRESSES.entryPointV07}) 在 block ${blockNumber} 沒有 code：chain 或 RPC 不對，Kernel 帳戶無法部署`,
    );
  }
  if (!metaFactoryCode || metaFactoryCode === '0x') {
    throw new Error(
      `Kernel MetaFactory (${KERNEL_V3_3_ADDRESSES.kernelMetaFactory}) 在 block ${blockNumber} 沒有 code：chain 或 RPC 不對，counterfactual 地址會算錯`,
    );
  }
}

/**
 * 帳戶的 sudo validator：owner 的 ECDSA validator。位址由 SDK 依 Kernel 版本查出，
 * enableData 就是 owner 地址（initialize 的 validatorData）。
 *
 * 本行程只有 owner 的地址、沒有私鑰，所以 signer 用 SDK 的 addressToEmptyAccount（簽章會拋錯，
 * 而推導地址與 calldata 不需要簽章）。
 */
async function sudoValidatorFor(publicClient: PublicClient, owner: Address) {
  return signerToEcdsaValidator(publicClient, {
    signer: addressToEmptyAccount(owner),
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_V3_3,
  });
}
