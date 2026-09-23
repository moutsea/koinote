#!/bin/sh
# Certbot deploy hook for the direct HTTPS WeChat relay. Run only after a
# successful issuance/renewal of the relay's IP-address certificate.
set -eu

lineage=/etc/letsencrypt/live/122.51.97.242
[ "${RENEWED_LINEAGE:-}" = "$lineage" ] || exit 0

target=/etc/koinote/wechat-relay
service=koinote-wechat-proxy-https.service
install -d -o root -g koinote-wechat-proxy -m 0750 "$target"
cert_tmp=$(mktemp "$target/.cert.XXXXXX")
key_tmp=$(mktemp "$target/.key.XXXXXX")
trap 'rm -f "$cert_tmp" "$key_tmp"' EXIT HUP INT TERM

install -o root -g koinote-wechat-proxy -m 0640 "$lineage/fullchain.pem" "$cert_tmp"
install -o root -g koinote-wechat-proxy -m 0640 "$lineage/privkey.pem" "$key_tmp"
openssl x509 -in "$cert_tmp" -noout -checkend 172800 >/dev/null
cert_pub=$(openssl x509 -in "$cert_tmp" -pubkey -noout | openssl pkey -pubin -pubout -outform DER | openssl dgst -sha256)
key_pub=$(openssl pkey -in "$key_tmp" -pubout -outform DER | openssl dgst -sha256)
[ "$cert_pub" = "$key_pub" ]

mv -f "$cert_tmp" "$target/proxy-https-cert.pem"
mv -f "$key_tmp" "$target/proxy-https-key.pem"

if systemctl is-active --quiet "$service"; then
    systemctl restart "$service"
    systemctl is-active --quiet "$service"
fi
