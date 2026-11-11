import type { Address } from 'viem';

/**
 * Kernel v3.3 / ERC-4337 的協議 canonical 常數。這些位址在鏈部署時就已固定（同一組地址在所有
 * chain 上以 deterministic deployer 重複部署），不是本專案的部署參數，所以不放 env：
 * env 只放 RPC、金鑰與本專案自己部署的合約（AtpRegistry 等）。
 */
export const KERNEL_V3_3_ADDRESSES = {
  /** ERC-4337 v0.7 EntryPoint（所有 Kernel v3.3 帳戶的 entry point）。 */
  entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  /** Kernel MetaFactory：v3.0–v3.3 共用，用 deployWithFactory 轉呼叫各版本 KernelFactory。 */
  kernelMetaFactory: '0xd703aaE79538628d27099B8c4f621bE4CCd142d5',
  /** Kernel v3.3 的 KernelFactory（createAccount(bytes initData, bytes32 salt)）。 */
  kernelFactoryV33: '0x2577507b78c2008Ff367261CB6285d44ba5eF2E9',
  /** Kernel v3.3 帳戶實作（proxy 指向的 logic）。 */
  kernelImplV33: '0xd6CEDDe84be40893d153Be9d467CD6aD37875b28',
  /** ECDSA validator：Kernel v3.1 之後共用同一顆。 */
  ecdsaValidatorV31: '0x845ADb2C711129d4f3966735eD98a9F09fC4cE57',
} as const satisfies Record<string, Address>;

/** Kernel v3.3 的版本字串（也是 Kernel 帳戶 ABI 的版本標記，供 4337 SDK 對照用）。 */
export const KERNEL_VERSION_STRING = '0.3.3';

/** salt 的 domain tag：讓同一 owner 在本專案不同用途下的 counterfactual 地址互不碰撞。 */
export const SALT_DOMAIN_TAG = 'cre8-atp:kernel-v3.3';

/**
 * PancakeSwap V3 的 factory 與 WBNB（**主網真實位址**；本機 fork 也是同一組，因為它 fork 自 BSC）。
 *
 * 路由選擇需要這兩個：factory 用來判斷某個 fee tier 的池子存不存在（避免對空池打 quoter），
 * WBNB 是我們允許的中間幣（BSC 上流動性的樞紐）。
 */
export const V3_FACTORY_ADDRESS = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
export const WBNB_ADDRESS = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

/** PancakeSwap **V2** factory：V2 池的深度常常優於 V3 的某個 fee tier，路由搜尋要一起比。 */
export const V2_FACTORY_ADDRESS = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';

/**
 * 回傳該 chain 可用的 Kernel v3.3 位址組。
 * 支援 BSC mainnet（56）與本機 fork（**1337** 或舊的 31337）：Kernel 的 canonical 位址在所有鏈相同。
 */
export function kernelAddressesForChain(chainId: number): typeof KERNEL_V3_3_ADDRESSES {
  if (chainId === 56 || chainId === 31337 || chainId === 1337) {
    return KERNEL_V3_3_ADDRESSES;
  }
  throw new Error(
    `Unsupported chainId ${chainId}: CRE8 目前只支援 BSC mainnet (56) 與 anvil fork (31337) 的 Kernel v3.3 canonical 位址`,
  );
}
