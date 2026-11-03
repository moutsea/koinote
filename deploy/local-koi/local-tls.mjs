// Local HTTPS clients trust only the root provisioned for their target.
// Node verifies it on the connection that actually carries headers and body.
import { Agent } from "node:https";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function localServiceProxy(service, directory = process.env.KOI_LOCAL_TLS_DIR || join(homedir(), ".config", "koinote-local", "tls")) {
  const port = { backend: 18090, images: 8788 }[service];
  if (!port) throw new Error("Unknown Koinote Local service");
  const agent = new Agent({maxCachedSessions:0,rejectUnauthorized:true, minVersion:"TLSv1.2"});
  // Load the root on each new connection. An offline editor can start before
  // services exist, and rotations take effect without restarting Vite.
  agent.createConnection = function(options, callback) {
    let ca;
    try { ca = readFileSync(join(directory, service + ".ca.crt")); }
    catch { callback(new Error("Local 服务未配置，请运行 npm run local:services。")); return; }
    return Agent.prototype.createConnection.call(this, {...options, ca, servername:"localhost", rejectUnauthorized:true}, callback);
  };
  return { target: "https://127.0.0.1:" + port, secure:true, agent };
}
