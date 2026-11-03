"""Preflight the VPC leaf identity before changing any Local service."""
import os
import re
import ssl
import subprocess
import time

HOST = "koi-local.koinote.app"


def verify_origin(directory):
    cert, key = directory / "origin.crt", directory / "origin.key"
    if not cert.is_file() or not key.is_file():
        raise SystemExit(f"Install the origin certificate and key for {HOST} in {directory}.")
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise SystemExit("The Local VPC certificate directory must be private (0700).")
    # These x509 options also work with the LibreSSL bundled with macOS.
    details = subprocess.check_output(["openssl", "x509", "-in", str(cert), "-noout", "-dates", "-text"], text=True)
    dates = dict(re.findall(r"^(notBefore|notAfter)=(.+)$", details, re.M))
    now = time.time()
    if not (ssl.cert_time_to_seconds(dates["notBefore"]) <= now < ssl.cert_time_to_seconds(dates["notAfter"])):
        raise SystemExit("The Local VPC certificate is not currently valid.")
    san = re.search(r"^[ \t]*X509v3 Subject Alternative Name:[^\n]*\n[ \t]+([^\n]+)", details, re.M)
    names = {s.strip()[4:].lower() for s in san.group(1).split(",") if s.strip().startswith("DNS:")} if san else set()
    if not names.intersection({HOST, "*." + HOST.split(".", 1)[1]}):
        raise SystemExit(f"The Local VPC certificate must have a DNS subject alternative name for {HOST}.")
    cert_pub = subprocess.check_output(["openssl", "x509", "-in", str(cert), "-pubkey", "-noout"])
    key_pub = subprocess.check_output(["openssl", "pkey", "-in", str(key), "-passin", "pass:", "-pubout"])
    if cert_pub != key_pub:
        raise SystemExit("Local VPC certificate and key do not match.")
    return cert, key
