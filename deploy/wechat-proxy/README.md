# WeChat API proxy

`koinote-wechat-proxy` is a deliberately narrow HTTP CONNECT proxy. It accepts
only `api.weixin.qq.com:443`, limits concurrent connections, and never proxies
ordinary HTTP requests or arbitrary destinations.

Tunnels expire after two minutes of inactivity. Reads and writes refresh both deadlines
so an active image upload can finish even when the connection is older than two minutes.
Run `GO111MODULE=off go test -race ./deploy/wechat-proxy` from the repository root before
deploying a proxy change. The relay binary and `koinote-wechat-proxy` systemd service must
be updated separately from the main backend deployment; keep the previous binary for rollback.

The original production path used the checked-in SSH tunnel unit: the proxy
listened on the relay's loopback address and the Koinote Docker host forwarded
`172.18.0.1:18080` to it. WireGuard was planned, but the relay provider did
not pass UDP 51820. Production now uses the direct HTTPS listener on port
18443; the SSH tunnel remains available for rollback.

## Direct HTTPS relay

`koinote-wechat-proxy-https.service` runs a **second** listener, so the existing
SSH path remains available for immediate rollback. Its environment file sets:

```text
WECHAT_PROXY_LISTEN=0.0.0.0:18443
WECHAT_PROXY_ALLOWED_CIDRS=<Koinote host public IPv4>/32
WECHAT_PROXY_TLS_CERT=/etc/koinote/wechat-relay/proxy-https-cert.pem
WECHAT_PROXY_TLS_KEY=/etc/koinote/wechat-relay/proxy-https-key.pem
```

The process refuses a public listener without both TLS and a client CIDR
allowlist. Also restrict TCP 18443 at the relay firewall to the Koinote host.
The certificate must contain the relay's IP address in its SAN. A publicly
trusted certificate lets the backend use
`WECHAT_API_PROXY_URL=https://<relay-ip>:18443` without a custom trust bundle.
[Let's Encrypt IP certificates](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)
expire after about six days, so automatic renewal and a service restart are
mandatory. A private test certificate can instead be passed to curl with
`--proxy-cacert` for a short trial.

### Production certificate and renewal

The relay's port 80 nginx default server serves only
`/.well-known/acme-challenge/` from `/var/www/koinote-acme`; every other path
still returns 404. Before requesting a certificate, verify that a temporary
file under that webroot is reachable at
`http://<relay-ip>/.well-known/acme-challenge/<filename>` from outside the
relay. Use Certbot 5.4 or newer (the production relay uses the official 5.8
snap). First test issuance with `--staging` and a separate config directory,
then issue the trusted certificate:

```sh
certbot certonly --preferred-profile shortlived --webroot \
  --webroot-path /var/www/koinote-acme --ip-address <relay-ip> \
  --cert-name <relay-ip> --non-interactive --agree-tos \
  --register-unsafely-without-email
```

Install `https-cert-deploy-hook.sh` as executable at
`/etc/letsencrypt/renewal-hooks/deploy/koinote-wechat-proxy-https` before
issuance. It checks the new certificate and key, copies them to the
`koinote-wechat-proxy` group's restricted directory, and restarts the HTTPS
service only when that certificate was renewed. Adjust the hook's expected
lineage if the relay IP changes. The Certbot snap's `snap.certbot.renew.timer`
must be enabled and active. Verify the renewal path with:

```sh
certbot renew --dry-run --cert-name <relay-ip> --non-interactive
```

The dry run can pause for a random delay of several minutes. After it passes,
check that `systemctl is-active koinote-wechat-proxy-https.service` returns
`active`, and use the Koinote host to make a CONNECT request **without**
`--proxy-cacert`. Restrict both the relay's cloud ingress rule and UFW port
18443 rule to the Koinote host's public IP. Set the same HTTPS URL in the
production `.env` and the repository's `WECHAT_API_PROXY_URL` deployment
variable, then recreate the backend container and check its health. Roll back
by restoring `WECHAT_API_PROXY_URL=http://172.18.0.1:18080` in both places and
recreating the backend; leave the SSH tunnel service running.

Compare the old and new routes **from the Koinote host**, using the same
WeChat API endpoint and similar concurrency. Curl reports the proxy CONNECT
status and total time without logging a token:

```sh
curl -sS -o /dev/null -w 'ssh: connect=%{http_connect} total=%{time_total}\n' \
  -x http://172.18.0.1:18080 \
  'https://api.weixin.qq.com/cgi-bin/get_api_domain_ip'
curl -sS -o /dev/null -w 'https: connect=%{http_connect} total=%{time_total}\n' \
  --proxy-cacert /path/to/trial-cert.pem \
  -x https://<relay>:18443 \
  'https://api.weixin.qq.com/cgi-bin/get_api_domain_ip'
```

After deploying backend upload timing logs, compare `queue_ms` (waiting for
the two image upload workers) with `request_ms` (token acquisition and upload)
for similar uncached drafts before and after changing the proxy URL. Switch
back to `http://172.18.0.1:18080` if the direct path fails or offers no benefit.

On 2026-09-24, the first trial was blocked by the relay provider's cloud
ingress rule. After TCP 18443 was allowed from the Koinote host, both routes
returned a successful CONNECT to the same WeChat API endpoint. Measurements
were taken from the Koinote host, alternating route order:

| Requests at once | SSH tunnel | Direct HTTPS | Measure |
| --- | ---: | ---: | --- |
| 1 | 1.08 s | 1.33 s | Median of six requests per route |
| 2 | 2.09 s | 1.39 s | Median wall time of four pairs per route |
| 4 | 2.08 s | 1.47 s | Mean wall time of two groups per route |

These are small unauthenticated API requests, **not** real image uploads.
Direct HTTPS improved concurrent request completion, while the existing SSH
route was faster for one request. The application's two-worker image upload
queue remains; compare real draft upload logs before any permanent switch.
The temporary HTTPS listener, three-day test certificate, and UFW rule were
removed after measurement. The original SSH route remained healthy.

### Real 16-image draft trial

On 2026-09-24, the same article was tested through the existing SSH relay and
the direct HTTPS relay. Both runs used the same WeChat account and the **same
16 prepared-image SHA-256 hashes**. The SSH figures come from cache timestamps
recorded during the user's preceding sync on 2026-09-23; its full request time
was not captured. For the HTTPS run, the 16 cache entries were backed up and
temporarily cleared, so all images had to upload again. The backend used a
temporary trust bundle containing the relay trial certificate, without
disabling certificate validation.

| Route | First-to-last image cache write | Full draft request |
| --- | ---: | ---: |
| SSH tunnel (historical run) | 137.12 s | Not recorded; user reported over 2 min |
| Direct HTTPS (fresh run) | 16.24 s | About 42.6 s, browser click to credit commit |

The direct route reduced the observed image-upload window by about 88%, or
8.4x. The comparison is from different times and includes image-cache database
writes rather than isolated network transfer timing, so it does not establish
the precise SSH overhead. It does demonstrate a large improvement for this
real workload. The HTTPS run created a draft successfully; only the normal
20-credit draft charge was recorded. The original SSH backend configuration,
all 16 cache rows, firewall rule, and relay service state were restored after
the trial. Later on 2026-09-24, the trusted certificate, automated renewal
hook, and direct HTTPS listener were installed. The renewal dry run passed and
production switched to HTTPS. The SSH tunnel remains running for rollback.

For local Docker development, forward the relay proxy to the host and set
`WECHAT_API_PROXY_URL=http://host.docker.internal:18080`:

```sh
ssh -N -L 0.0.0.0:18080:127.0.0.1:18080 root@<relay-host>
```

The relay's firewall should allow SSH only from the Koinote host where
possible. The WireGuard UDP rule is restricted to `172.245.27.245`; the
plain HTTP CONNECT port is never opened to the public network. A direct HTTPS
listener must be restricted to the Koinote host at both cloud ingress and UFW.
