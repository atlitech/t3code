// @effect-diagnostics nodeBuiltinImport:off -- The session boundary owns Unix CONNECT sockets.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

export const providerEgressHosts = new Set(["api.openai.com", "chatgpt.com", "auth.openai.com"]);
const nonPublic = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  nonPublic.addSubnet(network, prefix);

export function isPublicProviderAddress(address: string): boolean {
  // IPv4-only egress deliberately excludes mapped/translated IPv6 and scope IDs.
  if (NodeNet.isIP(address) !== 4 || nonPublic.check(address, "ipv4")) return false;
  return !Object.values(NodeOS.networkInterfaces())
    .flat()
    .some((entry) => entry?.address === address);
}

/** Strict authority parsing: no generic HTTP, credentials, ports, or alternate spellings. */
export function providerConnectHost(request: string): string | undefined {
  const match = /^CONNECT ([a-z0-9.-]+):443 HTTP\/1\.[01]\r\n(?:[^\r\n]*\r\n)*\r\n$/.exec(request);
  return match && providerEgressHosts.has(match[1]!) ? match[1] : undefined;
}

/** A bounded, credential-free per-session proxy. Only validated literal IPs reach connect(). */
export async function openProviderEgress(socketPath: string) {
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((client) => {
    if (sockets.size >= 64) {
      client.destroy();
      return;
    }
    sockets.add(client);
    const close = () => {
      sockets.delete(client);
      client.destroy();
    };
    client.on("error", close);
    client.on("close", () => sockets.delete(client));
    client.setTimeout(120_000, close);
    let request = Buffer.alloc(0);
    const read = (chunk: Buffer) => {
      request = Buffer.concat([request, chunk]);
      if (request.length > 8192) {
        close();
        return;
      }
      const end = request.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.pause();
      client.removeListener("data", read);
      const host = providerConnectHost(request.subarray(0, end + 4).toString("latin1"));
      const refuse = () => client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n", close);
      if (!host) {
        refuse();
        return;
      }
      void NodeDnsPromises.lookup(host, { all: true, family: 4, verbatim: true }).then(
        (addresses) => {
          if (client.destroyed) return;
          if (
            addresses.length === 0 ||
            addresses.some(({ address }) => !isPublicProviderAddress(address))
          ) {
            refuse();
            return;
          }
          const upstream = NodeNet.connect({ host: addresses[0]!.address, port: 443, family: 4 });
          sockets.add(upstream);
          const dispose = () => {
            sockets.delete(upstream);
            upstream.destroy();
            close();
          };
          upstream.on("error", dispose);
          upstream.on("close", dispose);
          client.on("close", dispose);
          upstream.setTimeout(120_000, dispose);
          upstream.once("connect", () => {
            if (client.destroyed) {
              dispose();
              return;
            }
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            const rest = request.subarray(end + 4);
            if (rest.length) upstream.write(rest);
            client.pipe(upstream);
            upstream.pipe(client);
            client.resume();
          });
        },
        refuse,
      );
    };
    client.on("data", read);
  });
  server.maxConnections = 32;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
