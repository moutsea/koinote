import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

test("Linux client reaches a TLS Worker bound to another namespace's loopback", {
  skip: process.env.KOINOTE_TEST_DOCKER_BRIDGE !== "1",
}, async () => {
  const docker=(...args)=>execFileSync("docker",args,{encoding:"utf8",timeout:90000}).trim();
  const root=await mkdtemp(join(tmpdir(),"koi-linux-"));
  const network="koi-bridge-"+randomUUID();
  let created=false,server;
  try {
    const certs=join(root,"tls");await mkdir(certs,{mode:0o700});
    execFileSync("python3",[fileURLToPath(new URL("./local-certs.py",import.meta.url)),certs]);
    await writeFile(join(root,"origin.mjs"),`
      import {startImageRelay} from "/app/image-relay.mjs";
      import {createServer} from "node:https";import {readFileSync} from "node:fs";
      import {once} from "node:events";import {networkInterfaces} from "node:os";
      const address=Object.values(networkInterfaces()).flat().find(n=>!n.internal&&n.family==="IPv4").address;
      const worker=createServer({key:readFileSync("/fixtures/tls/images.key"),cert:readFileSync("/fixtures/tls/images.crt")},
        (req,res)=>res.end(req.headers.authorization));
      worker.listen(8788,"127.0.0.1");await once(worker,"listening");
      await startImageRelay(address);console.log("ready");
    `);
    await writeFile(join(root,"client.mjs"),`
      import https from "node:https";import {readFileSync} from "node:fs";import assert from "node:assert/strict";
      const get=service=>new Promise((resolve,reject)=>https.get({
        host:"host.docker.internal",port:8788,ca:readFileSync("/fixtures/tls/"+service+".ca.crt"),
        headers:{Authorization:"Bearer linux-fixture"}},res=>{
          res.setEncoding("utf8");let body="";res.on("data",chunk=>body+=chunk);res.on("end",()=>resolve(body));
        }).on("error",reject));
      assert.equal(await get("images"),"Bearer linux-fixture");await assert.rejects(get("backend"));console.log("verified");
    `);
    docker("network","create",network);created=true;
    const mounts=["-v",root+":/fixtures:ro"];
    const relay=fileURLToPath(new URL("./image-relay.mjs",import.meta.url));
    server=docker("run","-d","--rm","--network",network,...mounts,"-v",relay+":/app/image-relay.mjs:ro","node:22-bookworm","node","/fixtures/origin.mjs");
    for(let i=0;i<50&&!docker("logs",server).includes("ready");i++) await new Promise(r=>setTimeout(r,100));
    const ip=docker("inspect","--format","{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",server);
    assert.equal(docker("run","--rm","--network",network,"--add-host","host.docker.internal:"+ip,...mounts,"node:22-bookworm","node","/fixtures/client.mjs"),"verified");
  } finally {
    try { if(server) docker("stop",server); }
    finally { if(created) docker("network","rm",network);await rm(root,{recursive:true,force:true}); }
  }
});
