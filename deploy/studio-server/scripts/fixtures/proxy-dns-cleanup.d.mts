export function cleanupProxyDnsFixture(options: {
  containers: Set<string>;
  networkId?: string;
  fixture: string;
  docker: (...args: string[]) => unknown;
  failure?: Error;
}): Promise<void>;
