# WeChat API proxy

`koinote-wechat-proxy` is a deliberately narrow HTTP CONNECT proxy. It accepts
only `api.weixin.qq.com:443`, limits concurrent connections, and never proxies
ordinary HTTP requests or arbitrary destinations.

The intended production path is WireGuard (`10.77.0.1/24` on the relay and
`10.77.0.2/24` on the Koinote host). The relay listens on `10.77.0.1:18080`
by default. The current relay provider does not pass UDP 51820, so production
currently uses the checked-in SSH tunnel unit: the proxy listens on the relay's
loopback address and the Koinote Docker host forwards `172.18.0.1:18080` to it.

For local Docker development, forward the relay proxy to the host and set
`WECHAT_API_PROXY_URL=http://host.docker.internal:18080`:

```sh
ssh -N -L 0.0.0.0:18080:127.0.0.1:18080 root@<relay-host>
```

The relay's firewall should allow SSH only from the Koinote host where
possible. The WireGuard UDP rule is restricted to `172.245.27.245`; the
proxy's TCP port is never opened to the public network.
