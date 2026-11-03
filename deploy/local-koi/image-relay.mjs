// Native Linux containers reach this listener on the Docker bridge. TLS is
// passed through to the same loopback Worker used by Vite on the host.
import { createServer, createConnection } from "node:net";
import { once } from "node:events";

export async function startImageRelay(address, port = 8788, workerPort = 8788) {
  const relay = createServer(client => {
    const worker = createConnection({host:"127.0.0.1",port:workerPort});
    client.on("error", () => worker.destroy());
    worker.on("error", () => client.destroy());
    client.on("close", () => worker.destroy());
    worker.on("close", () => client.destroy());
    client.pipe(worker).pipe(client);
  });
  relay.listen(port,address);
  await once(relay,"listening");
  return relay;
}
