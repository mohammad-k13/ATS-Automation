import { fetch, ProxyAgent, type Dispatcher, type RequestInit } from 'undici';

const agents = new Map<string, Dispatcher>();
function dispatcher(proxy?: string): Dispatcher | undefined {
      if (!proxy) return undefined;
      if (!agents.has(proxy)) agents.set(proxy, new ProxyAgent(proxy));
      return agents.get(proxy);
}

export async function httpFetch(
      url: string,
      init: RequestInit = {},
      proxy?: string,
      timeoutMs = 60_000,
) {
      return fetch(url, {
            ...init,
            dispatcher: dispatcher(proxy),
            signal: AbortSignal.timeout(timeoutMs),
      });
}
