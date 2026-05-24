"use client";
import { useEffect } from "react";

export function SwRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.getRegistrations().then((rs) => {
      rs.forEach((r) => r.unregister().catch(() => {}));
    }).catch(() => {});
    if ("caches" in window) {
      caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {});
    }
  }, []);
  return null;
}
