import { registerHooks } from "node:module";

// A fail-closed tripwire for this trusted offline runner, not a sandbox for arbitrary code.
// Install before loading the evaluator. Even a caught attempt remains observable by the runner.
export function installOfflineGuard() {
  const attempts = [];
  const blocked = new Set([
    "http", "https", "http2", "net", "tls", "dns", "dns/promises", "dgram",
    "child_process", "cluster", "worker_threads", "undici",
  ]);
  function deny(kind) {
    attempts.push(kind);
    const error = new Error("Offline evaluation forbids network and process execution");
    error.code = "OFFLINE_NETWORK_DISABLED";
    throw error;
  }
  const normalize = (name) => name.startsWith("node:") ? name.slice(5) : name;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const name = normalize(specifier);
      if (blocked.has(name) || name.startsWith("undici/") || /^https?:/u.test(specifier)) deny(name);
      return nextResolve(specifier, context);
    },
  });
  const getBuiltinModule = process.getBuiltinModule.bind(process);
  process.getBuiltinModule = (name) => {
    if (blocked.has(normalize(name))) deny(normalize(name));
    return getBuiltinModule(name);
  };
  globalThis.fetch = () => deny("fetch");
  for (const name of ["WebSocket", "EventSource", "XMLHttpRequest"]) {
    globalThis[name] = class { constructor() { deny(name); } };
  }
  return { attempts: () => [...attempts] };
}
