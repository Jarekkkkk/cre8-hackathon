import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * 認證狀態（client state）。放 sessionStorage，不放 localStorage：
 *
 * 這支 app 會動錢，token 的曝險窗口應該跟「這個分頁開著」一樣長。重新整理不用重簽（體驗），
 * 關掉分頁就清掉（安全）。localStorage 會讓 token 活到下次開瀏覽器 —— 對一個能動錢的 app，
 * 那個預設是錯的。
 */
export type SessionState = {
  token: string | null;
  expiresAt: string | null;
  address: string | null;
  setSession: (input: { token: string; expiresAt: string; address: string }) => void;
  clear: () => void;
};

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      expiresAt: null,
      address: null,
      setSession: ({ token, expiresAt, address }) => set({ token, expiresAt, address }),
      clear: () => set({ token: null, expiresAt: null, address: null }),
    }),
    {
      name: 'cre8.session',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({ token: state.token, expiresAt: state.expiresAt, address: state.address }),
    },
  ),
);

/** token 是否還在有效期內（本地粗判，真正的權威是後端）。 */
export function sessionIsLive(state: { token: string | null; expiresAt: string | null }): boolean {
  if (state.token === null || state.expiresAt === null) return false;
  const expiry = new Date(state.expiresAt).getTime();
  return Number.isFinite(expiry) && expiry > Date.now();
}
