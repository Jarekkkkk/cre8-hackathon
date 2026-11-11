import { HDKey } from '@scure/bip32';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { PolicyFlags, toInitConfig, toPermissionValidator } from '@zerodev/permissions';
import type { ModularSigner, PermissionPlugin, Policy } from '@zerodev/permissions';
import { CallPolicyVersion, toCallPolicy, toGasPolicy, toTimestampPolicy } from '@zerodev/permissions/policies';
import { toEmptyECDSASigner } from '@zerodev/permissions/signers';
import { addressToEmptyAccount } from '@zerodev/sdk';
import { KERNEL_V3_3 } from '@zerodev/sdk/constants';
import type { GetKernelVersion } from '@zerodev/sdk/types';
import { encodePacked, hexToBytes, keccak256 } from 'viem';
import type { Address, Hex, PublicClient } from 'viem';
import { hdKeyToAccount } from 'viem/accounts';
import { KERNEL_VERSION_STRING, KERNEL_V3_3_ADDRESSES } from './addresses.js';
import { requireSessionKeyConfig } from './config.js';

/**
 * Kernel session key 的權限機制（第一段：只做機制，不接 enroll 流程）。
 *
 * 三個實測結論決定這個檔的形狀，先寫在最前面，因為它們是最容易搞錯的地方：
 *
 * 1. `plugins.regular` 決定「誰簽」，**不影響** counterfactual 地址；`initConfig` 決定「權限有沒有安裝」，
 *    是**唯一**影響地址的東西。production 兩者都要給。
 * 2. GasPolicy 是一次性的 wei 預算，跨 userOp 累計、**永不重置**：用完權限就永久失效，所以額度是
 *    `1e18` wei 這種一次性預算，不是「每日重置」。
 * 3. CallPolicy 只驗 target + selector，**不驗參數**。也就是說 session key 一旦裝上，executor 的
 *    `executeRebalance` 任何參數都叫得動 —— 參數層的護欄要在別的地方做。
 *
 * 另一件影響 DB 設計的事：`permissionId` 只有 4 bytes，**不能當唯一鍵**。
 */

/** EntryPoint v0.7（`toPermissionValidator` 只接受 0.7，其他版本會直接 throw）。 */
const ENTRY_POINT = { address: KERNEL_V3_3_ADDRESSES.entryPointV07, version: '0.7' } as const;

/** 允許 session key 呼叫的函式：executor 的 `executeRebalance`。 */
export const EXECUTOR_SELECTOR: Hex = '0x1b977850';

/** GasPolicy 的一次性 wei 預算（1e18 wei）。用完不重置，權限永久失效。 */
export const SESSION_GAS_ALLOWED_WEI = 10n ** 18n;

/** 生效區間的起點：0 = 該側不限（不等於「立即」，是「沒有下界」）。 */
export const SESSION_VALID_AFTER = 0;

/** 預設有效期：365 天。 */
export const SESSION_VALIDITY_SECONDS = 365 * 24 * 60 * 60;

/** CallPolicy 版本：0.0.4 修掉 4337 storage 違規，是最新的一版。 */
export const SESSION_CALL_POLICY_VERSION = CallPolicyVersion.V0_0_4;

/** 三層 policy 共用的 flag（對所有 validation 生效）。這個值也參與 permissionId 計算。 */
export const SESSION_POLICY_FLAG = PolicyFlags.FOR_ALL_VALIDATION;

/** HD 派生路徑的前綴；`portfolioId` 只佔最後一層（非 hardened，所以 index < 2^31）。 */
export const SESSION_KEY_DERIVATION_PREFIX = "m/44'/60'/0'/0" as const;

/** BIP32 非 hardened child index 的上界（2^31 - 1）。 */
export const MAX_SESSION_KEY_INDEX = 2 ** 31 - 1;

// ---------------------------------------------------------------------------
// HD 派生
// ---------------------------------------------------------------------------

/** 派生一個 session key 所需的材料。production 走 `requireSessionKeyConfig()`，測試可直接注入。 */
export type SessionKeyMaterial = { masterSeed: Hex };

/**
 * 派生結果：**只有地址與派生路徑，沒有私鑰**。
 *
 * `keyRef` 就是 DB 要存的那個字串（例：`m/44'/60'/0'/0/7`）：私鑰永遠不落 DB，要用時再從 master seed
 * 沿著同一條路徑派生回來。
 */
export type DerivedSessionKey = { address: Address; keyRef: string };

/**
 * 由 `portfolioId` 派生 session key 的地址與派生路徑：`m/44'/60'/0'/0/<portfolioId>`。
 *
 * 用真的 BIP32 HD 派生（`@scure/bip32` 的 `HDKey` + viem 的 `hdKeyToAccount`），不是拿
 * `keccak256(seed ++ id)` 當私鑰的降級寫法：同一條路徑可以用任何標準錢包工具複核，而且
 * `keyRef` 本身就能重建金鑰，不需要把私鑰存起來。
 */
export function deriveSessionKey(
  portfolioId: bigint | number,
  material: SessionKeyMaterial = requireSessionKeyConfig(),
): DerivedSessionKey {
  const index = sessionKeyIndex(portfolioId);
  const masterSeed = assertMasterSeed(material.masterSeed);
  // as const 讓字面型別滲進 template literal，才符合 viem HDOptions.path 的 `m/44'/60'/${string}`。
  const keyRef = `${SESSION_KEY_DERIVATION_PREFIX}/${index.toString()}` as const;

  // hdKeyToAccount 會對 root 做 derive(path)，所以這裡傳 root 與絕對路徑，不要再自己 derive 一次。
  const account = hdKeyToAccount(HDKey.fromMasterSeed(hexToBytes(masterSeed)), { path: keyRef });

  // 只回傳 address：account 物件本身帶著 privateKey，不要讓它離開這個函式。
  return { address: account.address, keyRef };
}

/** `portfolioId` → BIP32 child index。超出非 hardened 範圍就拋錯，不要讓它變成別人的金鑰。 */
function sessionKeyIndex(portfolioId: bigint | number): bigint {
  if (typeof portfolioId === 'number' && !Number.isInteger(portfolioId)) {
    throw new Error(`Session key 派生失敗：portfolioId 必須是整數（收到 ${String(portfolioId)}）`);
  }
  const index = typeof portfolioId === 'bigint' ? portfolioId : BigInt(portfolioId);
  if (index < 0n || index > BigInt(MAX_SESSION_KEY_INDEX)) {
    throw new Error(
      `Session key 派生失敗：portfolioId 必須在 0..${MAX_SESSION_KEY_INDEX} 之間（收到 ${index.toString()}）——` +
        `最後一層是 BIP32 非 hardened child index，超出範圍會撞到 hardened 區間`,
    );
  }
  return index;
}

function assertMasterSeed(seed: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(seed))) {
    throw new Error(`Session key 派生失敗：master seed 必須是 0x + 64 hex（32 bytes），收到 "${String(seed)}"`);
  }
  return seed;
}

/**
 * 穩定索引的 domain tag。刻意與帳戶 salt 的 `SALT_DOMAIN_TAG` 不同：同一個 (owner, strategyId) 的
 * 「帳戶 salt」與「金鑰索引」是兩件事，共用一顆 hash 等於讓其中一個的改動波及另一個。
 */
export const SESSION_KEY_INDEX_DOMAIN_TAG = 'cre8-atp:session-key:v1';

/**
 * `(owner, strategyId)` → BIP32 child index：`keccak256(encodePacked(tag, owner, strategyId)) % MAX`。
 *
 * **這不是美化版的可讀性工具，它是「重跑一致性」的全部依據。**
 *
 * enroll 的順序是「鏈上先、DB 後」，而 `portfolios.id` 是 bigserial —— 在 INSERT 之前不存在。若拿
 * `portfolios.id` 當派生索引，重跑時（鏈上成功但 DB 沒寫完）就必須先 insert 才能派生，而 insert 拿到的
 * 又是新的 id：索引會變 → session key 會變 → **而 initConfig 一變，counterfactual 地址也跟著變**，
 * 於是重跑會部署第二個帳戶、在鏈上 enroll 第二個地址，DB 只留下後面那一個，前面那個變成沒人認領的孤兒。
 *
 * 改成純函式之後，`(owner, strategyId)` 就是 session key 與帳戶地址的唯一輸入：重跑必然得到同一個索引、
 * 同一把金鑰、同一個地址，`deploySmartAccount` 的 getCode 守衛因此仍然有效。
 *
 * 代價：兩個不同的 `(owner, strategyId)` 有機會算到同一個索引（生日碰撞，2^31 空間）。
 * 那時 `session_keys.key_ref` 的 UNIQUE 會擋下並讓整個交易回滾 —— 大聲失敗，不會靜默共用同一把金鑰。
 */
export function sessionKeyIndexFor(owner: Address, strategyId: bigint | number): bigint {
  const ownerAddress = assertAddressArg(owner, 'owner');
  if (typeof strategyId === 'number' && !Number.isInteger(strategyId)) {
    throw new Error(`Session key 索引算不出來：strategyId 必須是整數（收到 ${String(strategyId)}）`);
  }
  const id = typeof strategyId === 'bigint' ? strategyId : BigInt(strategyId);
  if (id < 0n) {
    throw new Error(`Session key 索引算不出來：strategyId 不可為負（收到 ${id.toString()}）`);
  }

  const digest = keccak256(
    encodePacked(['string', 'address', 'uint256'], [SESSION_KEY_INDEX_DOMAIN_TAG, ownerAddress, id]),
  );
  // % MAX（而不是 MAX+1）：索引落在 0..2^31-2，穩穩在非 hardened 區間內。
  return BigInt(digest) % BigInt(MAX_SESSION_KEY_INDEX);
}

/**
 * enroll 用的派生入口：`(owner, strategyId)` → session key 的地址與派生路徑。
 *
 * 與 `deriveSessionKey` 的差別只在索引怎麼來：這裡不接受 DB 產生的 id，所以同一對輸入重跑必然一致。
 */
export function deriveSessionKeyFor(
  owner: Address,
  strategyId: bigint | number,
  material: SessionKeyMaterial = requireSessionKeyConfig(),
): DerivedSessionKey {
  return deriveSessionKey(sessionKeyIndexFor(owner, strategyId), material);
}

// ---------------------------------------------------------------------------
// 三層 policy 的參數（單一來源：測試、log、DB snapshot 都讀這裡）
// ---------------------------------------------------------------------------

/** 時間區間：`validAfter` 0 = 該側不限，`validUntil` 是 Unix 秒（uint48）。 */
export type SessionTimestampPolicySnapshot = {
  policyAddress: Address;
  policyFlag: Hex;
  validAfter: number;
  validUntil: number;
};

/**
 * GasPolicy：`allowed` 是 **uint128 的 wei 預算**，跨 userOp 累計、永不重置。
 * JSON 裡存十進位字串（bigint 不能直接 JSON 化，但字串可以無損重建）。
 */
export type SessionGasPolicySnapshot = {
  policyAddress: Address;
  policyFlag: Hex;
  allowed: string;
  enforcePaymaster: boolean;
  allowedPaymaster: Address;
};

/** CallPolicy 的一條權限：只鎖 target + selector（不驗參數）。 */
export type SessionCallPermissionSnapshot = {
  callType: Hex;
  target: Address;
  selector: Hex;
  valueLimit: string;
  rules: { condition: number; offset: number; params: Hex | Hex[] }[];
};

export type SessionCallPolicySnapshot = {
  policyAddress: Address;
  policyFlag: Hex;
  policyVersion: CallPolicyVersion;
  permissions: SessionCallPermissionSnapshot[];
};

/**
 * 要存進 DB `session_keys.permissions` 的 policy 快照：三層 policy 的完整參數，
 * 含各自的 policy 合約地址與 flag（換版本時地址就不同，不記下來就重建不出來）。
 * 全部是 JSON-safe 的值（bigint 一律轉十進位字串）。
 */
export type SessionPolicies = {
  /** 快照格式版本，之後改結構時用來判斷舊資料怎麼讀。 */
  version: 1;
  entryPoint: Address;
  kernelVersion: string;
  flag: Hex;
  call: SessionCallPolicySnapshot;
  gas: SessionGasPolicySnapshot;
  timestamp: SessionTimestampPolicySnapshot;
};

/** `buildSessionPermissions` 的產出：快照再加上「這組權限是誰的」。 */
export type SessionPolicySnapshot = SessionPolicies & {
  permissionId: Hex;
  sessionKeyAddress: Address;
  expiresAt: string;
};

/** 一次算好的三層 policy 物件；snapshot 與 validator 都從同一份長出來。 */
type BuiltPolicies = { call: Policy; gas: Policy; timestamp: Policy };

function buildPolicies(executorAddress: Address, validAfter: number, validUntil: number): BuiltPolicies {
  return {
    // 只給 target + selector：CallPolicy 不驗參數，所以這裡沒得鎖更細。
    call: toCallPolicy({
      policyVersion: SESSION_CALL_POLICY_VERSION,
      permissions: [{ target: executorAddress, selector: EXECUTOR_SELECTOR }],
    }),
    gas: toGasPolicy({ allowed: SESSION_GAS_ALLOWED_WEI }),
    timestamp: toTimestampPolicy({ validAfter, validUntil }),
  };
}

/** 目前使用的三層 policy 參數（測試與 log 用）。`validUntil` 未給就用 `sessionValidUntil()`。 */
export function describePolicies(args: { executorAddress: Address; validUntil?: number }): SessionPolicies {
  const executorAddress = assertAddressArg(args.executorAddress, 'executorAddress');
  const validUntil = args.validUntil ?? sessionValidUntil();
  assertValidUntil(validUntil);

  const policies = buildPolicies(executorAddress, SESSION_VALID_AFTER, validUntil);
  return snapshotPolicies(policies);
}

/** 預設的 `validUntil`：`nowSeconds + 365 天`。純函式，測試可以自己指定 now。 */
export function sessionValidUntil(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
  return nowSeconds + SESSION_VALIDITY_SECONDS;
}

/**
 * policy 的「身分」是 `getPolicyInfoInBytes()`：`flag(2 bytes) ++ policy 合約地址(20 bytes)`。
 *
 * 一律從這裡讀，不要讀 `policyParams.policyAddress`：以 CallPolicy 為例，未自己指定時那個欄位是
 * `undefined`（真正的地址由版本決定、在 SDK 內部算出來的），照抄會把 undefined 寫進 DB。
 */
function policyInfo(policy: Policy): { policyFlag: Hex; policyAddress: Address } {
  const info = policy.getPolicyInfoInBytes();
  return {
    policyFlag: `0x${info.slice(2, 6)}`,
    policyAddress: `0x${info.slice(6, 46)}` as Address,
  };
}

/**
 * 把 policy 物件攤成 JSON-safe 的快照。
 *
 * 一律從 policy 本身回讀，而不是把參數再寫一次：預設值（policy 合約地址、flag、callType…）由
 * SDK 決定，重複寫一份遲早會跟 SDK 漂移。
 */
function snapshotPolicies({ call, gas, timestamp }: BuiltPolicies): SessionPolicies {
  const callParams = call.policyParams;
  const gasParams = gas.policyParams;
  const timestampParams = timestamp.policyParams;

  if (callParams.type !== 'call' || gasParams.type !== 'gas' || timestampParams.type !== 'timestamp') {
    throw new Error(
      `Policy 快照型別不符：預期 call/gas/timestamp，拿到 ${callParams.type}/${gasParams.type}/${timestampParams.type}`,
    );
  }

  return {
    version: 1,
    entryPoint: KERNEL_V3_3_ADDRESSES.entryPointV07,
    kernelVersion: KERNEL_VERSION_STRING,
    flag: SESSION_POLICY_FLAG,
    call: {
      ...policyInfo(call),
      policyVersion: callParams.policyVersion,
      permissions: (callParams.permissions ?? []).map((permission) => ({
        callType: (permission.callType ?? '0x00') as Hex,
        target: permission.target as Address,
        selector: (permission.selector ?? '0x00000000') as Hex,
        valueLimit: (permission.valueLimit ?? 0n).toString(),
        rules: (permission.rules ?? []).map((rule) => ({
          condition: rule.condition,
          offset: rule.offset,
          params: rule.params,
        })),
      })),
    },
    gas: {
      ...policyInfo(gas),
      allowed: (gasParams.allowed ?? 0n).toString(),
      enforcePaymaster: gasParams.enforcePaymaster ?? false,
      allowedPaymaster: gasParams.allowedPaymaster as Address,
    },
    timestamp: {
      ...policyInfo(timestamp),
      validAfter: timestampParams.validAfter ?? SESSION_VALID_AFTER,
      validUntil: timestampParams.validUntil ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// permission validator / initConfig
// ---------------------------------------------------------------------------

/**
 * 帳戶的 sudo（root）validator：owner 的 ECDSA validator。
 *
 * 為什麼這個專案需要自己有一份：`src/kernel.ts` 的 `getKernelAccountParams` 只在**沒給** `plugins`
 * 時自己建 sudo；一旦要帶 `plugins.regular`（session key 的 permission validator），就得連 sudo 一起
 * 給 —— 漏掉 sudo 不是「用預設值」，而是根本組不出帳戶。kernel.ts 的版本是私有函式且該檔凍結，
 * 所以在這裡放一份公開的；兩者必須逐項相同，否則 rootValidator 會與驗證腳本期待的值不同。
 *
 * 本行程只有 owner 的地址、沒有私鑰：用 `addressToEmptyAccount`，推導地址與 calldata 都不需要簽章。
 */
export async function sudoValidator(publicClient: PublicClient, owner: Address) {
  const ownerAddress = assertAddressArg(owner, 'owner');
  return signerToEcdsaValidator(publicClient, {
    signer: addressToEmptyAccount(ownerAddress),
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_V3_3,
  });
}

export type BuildSessionPermissionsArgs = {
  /** 推導地址要用：`toPermissionValidator` 讀 `client.chain.id`（或打 eth_chainId）。 */
  publicClient: PublicClient;
  /** session key 的地址（由 `deriveSessionKey` 得到）。本函式不需要它的私鑰。 */
  sessionKeyAddress: Address;
  /** CallPolicy 的 target：rebalance executor。 */
  executorAddress: Address;
  /** Unix 秒。未給 = `now + 365 天`。 */
  validUntil?: number;
  /**
   * 選配：真正的簽章者。預設用 `toEmptyECDSASigner(地址)` —— 推導地址與 initConfig 不需要簽章，
   * 但那個 plugin 簽不了東西。要拿去簽 userOp 時由呼叫端傳入持有私鑰的 signer。
   */
  signer?: ModularSigner;
};

/**
 * 產出一組 session key 權限：validator plugin、initConfig、permissionId、policy 快照、到期時間。
 *
 * ⚠ `initConfig` 一定要跟著帳戶建立一起給：少了它，帳戶上就沒有安裝這組權限，之後拿 session key
 * 簽的 userOp 過不了 validation —— 而且地址**不會**因此改變，所以不會有任何錯誤提示。
 */
export type SessionPermission = {
  permissionValidator: PermissionPlugin;
  initConfig: Hex[];
  /** 只有 4 bytes，不能當唯一鍵（同組 policy + signer 必然相同）。 */
  permissionId: Hex;
  policySnapshot: SessionPolicySnapshot;
  /** 給 DB `session_keys.expires_at` 用，等於 `validUntil`。 */
  expiresAt: Date;
};

export async function buildSessionPermissions(args: BuildSessionPermissionsArgs): Promise<SessionPermission> {
  const sessionKeyAddress = assertAddressArg(args.sessionKeyAddress, 'sessionKeyAddress');
  const executorAddress = assertAddressArg(args.executorAddress, 'executorAddress');
  const validUntil = args.validUntil ?? sessionValidUntil();
  assertValidUntil(validUntil);
  if (!args.publicClient) {
    throw new Error('Session key 權限算不出來：需要 publicClient（toPermissionValidator 要讀 chain id）');
  }

  const policies = buildPolicies(executorAddress, SESSION_VALID_AFTER, validUntil);

  // 型別理由同 src/kernel.ts：SDK 把 kernelVersion 收窄成 GetKernelVersion<"0.7">。
  const kernelVersion: GetKernelVersion<'0.7'> = KERNEL_V3_3;

  const permissionValidator = await toPermissionValidator(args.publicClient, {
    signer: args.signer ?? toEmptyECDSASigner(sessionKeyAddress),
    // 順序會進 permissionId（toPolicyId 是對這個陣列做 abi.encode），所以固定在這裡排。
    policies: [policies.call, policies.gas, policies.timestamp],
    entryPoint: ENTRY_POINT,
    kernelVersion,
    flag: SESSION_POLICY_FLAG,
  });

  // 安裝權限的 calldata：只有這一段會改變 counterfactual 地址。
  const initConfig = await toInitConfig(permissionValidator);
  const permissionId = permissionValidator.getIdentifier();

  return {
    permissionValidator,
    initConfig,
    permissionId,
    policySnapshot: {
      ...snapshotPolicies(policies),
      permissionId,
      sessionKeyAddress,
      expiresAt: new Date(validUntil * 1000).toISOString(),
    },
    expiresAt: new Date(validUntil * 1000),
  };
}

// ---------------------------------------------------------------------------
// 參數護欄
// ---------------------------------------------------------------------------

function assertAddressArg(value: Address, name: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(value))) {
    throw new Error(`Session key 參數錯誤：${name} 必須是 0x + 40 hex 的地址，收到 "${String(value)}"`);
  }
  return value.toLowerCase() as Address;
}

/** uint48 的上界與「必須是正整數秒」都在這裡擋掉，免得寫進 DB 的到期時間是 NaN。 */
function assertValidUntil(validUntil: number): void {
  if (!Number.isInteger(validUntil) || validUntil < 0 || validUntil > 2 ** 48 - 1) {
    throw new Error(`Session key 參數錯誤：validUntil 必須是 uint48 範圍內的整數 Unix 秒，收到 ${String(validUntil)}`);
  }
}
