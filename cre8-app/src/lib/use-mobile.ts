import { useSyncExternalStore } from "react";
const query = "(max-width: 719px)";
const subscribe = (listener: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
};
// 同一份票券只掛載一次；換成手機抽屜時保留父層輸入與交易進度。
export const useMobile = () =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
