# WeChat API proxy

`koinote-wechat-proxy` is a deliberately narrow HTTP CONNECT proxy. It accepts
only `api.weixin.qq.com:443`, limits concurrent connections, and never proxies
ordinary HTTP requests or arbitrary destinations.

Tunnels expire after two minutes of inactivity. Reads and writes refresh both deadlines
so an active image upload can finish even when the connection is older than two minutes.
Run `GO111MODULE=off go test -race ./deploy/wechat-proxy` from the repository root before
deploying a proxy change. The relay binary and `koinote-wechat-proxy` systemd service must
be updated separately from the main backend deployment; keep the previous binary for rollback.

The intended production path is WireGuard (`10.77.0.1/24` on the relay and
`10.77.0.2/24` on the Koinote host). The relay listens on `10.77.0.1:18080`
by default. The current relay provider does not pass UDP 51820, so production
currently uses the checked-in SSH tunnel unit: the proxy listens on the relay's
loopback address and the Koinote Docker host forwards `172.18.0.1:18080` to it.

## Direct HTTPS trial

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
The certificate must contain the relay's IP address or hostname in its SAN,
and the Koinote host must trust its issuer. A public certificate makes Go's
existing `WECHAT_API_PROXY_URL=https://<relay>:18443` work without backend
changes. [Let's Encrypt IP certificates](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)
are available but expire after six days, so their renewal and a service restart
must be automated. A private test certificate can instead be passed to curl
with `--proxy-cacert` for a network comparison without changing the backend.

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
the trial. The production backend remains on the SSH route.

Before a permanent switch, provision a publicly trusted relay certificate
with automated renewal and restart, and verify renewal. IP-address certificates
currently require Certbot 5.4+ and the `shortlived` profile, with a lifetime
of about six days. Keep the SSH tunnel available as the rollback path.

For local Docker development, forward the relay proxy to the host and set
`WECHAT_API_PROXY_URL=http://host.docker.internal:18080`:

```sh
ssh -N -L 0.0.0.0:18080:127.0.0.1:18080 root@<relay-host>
```

The relay's firewall should allow SSH only from the Koinote host where
possible. The WireGuard UDP rule is restricted to `172.245.27.245`; the
plain HTTP CONNECT port is never opened to the public network. A direct HTTPS
listener must be restricted to the Koinote host at both cloud ingress and UFW.
