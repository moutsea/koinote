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

On 2026-09-24, a temporary HTTPS listener passed a local CONNECT probe, but
the Koinote host timed out connecting to relay TCP 18443. The relay's UFW
allow rule recorded zero packets while relay TCP 80 remained reachable. This
points to an upstream cloud ingress rule. The temporary listener, certificate,
and UFW rule were removed; the SSH tunnel and loopback proxy remained healthy.
Open TCP 18443 in the relay provider's security group for the Koinote host
IP only before repeating the comparison.

For local Docker development, forward the relay proxy to the host and set
`WECHAT_API_PROXY_URL=http://host.docker.internal:18080`:

```sh
ssh -N -L 0.0.0.0:18080:127.0.0.1:18080 root@<relay-host>
```

The relay's firewall should allow SSH only from the Koinote host where
possible. The WireGuard UDP rule is restricted to `172.245.27.245`; the
proxy's TCP port is never opened to the public network.
