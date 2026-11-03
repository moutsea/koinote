"""Provision separate TLS identities for the Local Go service and image Worker."""
from contextlib import contextmanager
import os
import re
import subprocess
import tempfile
from pathlib import Path


def valid_identity(cert, key, ca):
    if not all(path.is_file() for path in (cert,key,ca)):
        return False
    def run(*args):
        return subprocess.run(['openssl', *map(str,args)], capture_output=True)
    public = run('x509','-in',cert,'-pubkey','-noout')
    private = run('pkey','-in',key,'-passin','pass:','-pubout')
    details=run('x509','-in',cert,'-noout','-text').stdout
    names=(b'IP Address:127.0.0.1', b'DNS:localhost', b'DNS:host.docker.internal')
    return (public.returncode == private.returncode == 0 and public.stdout == private.stdout
            and run('x509','-in',cert,'-checkend','2592000','-noout').returncode == 0
            and run('x509','-in',ca,'-checkend','2592000','-noout').returncode == 0
            and run('verify','-CAfile',ca,'-purpose','sslserver',cert).returncode == 0
            and all(re.search(rb'(?:^|[,\s])'+re.escape(name)+rb'(?=[,\s]|$)',details) for name in names))


@contextmanager
def generation_lock(directory):
    with (directory / '.provision.lock').open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            if lock.tell() == 0:
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def provision(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink():
        raise SystemExit('The Local TLS directory must not be a symlink.')
    if os.name == 'nt':
        # Set a fresh owner-only DACL. Removing just inherited entries would
        # leave existing explicit grants on an interrupted installation.
        command = """
$ErrorActionPreference = 'Stop'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:KOI_TLS_ACL_PATH -AclObject $acl
"""
        subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',command],
                       env={**os.environ, 'KOI_TLS_ACL_PATH':str(directory)},check=True)
    elif directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise SystemExit('The Local TLS directory must be owned by this user with mode 0700.')
    with generation_lock(directory):
        provision_identities(directory)


def provision_identities(directory):
    for service in ('backend', 'images'):
        cert, key, ca = (directory / (service + ext) for ext in ('.crt', '.key', '.ca.crt'))
        if valid_identity(cert,key,ca):
            continue
        with tempfile.TemporaryDirectory(dir=directory) as temporary:
            stage = Path(temporary)
            config = stage / 'openssl.cnf'
            config.write_text(
                '[req]\nprompt=no\ndistinguished_name=name\nx509_extensions=server\n'
                f'[name]\nCN=Koinote Local {service}\n[server]\nbasicConstraints=critical,CA:FALSE\n'
                'extendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
                'subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:host.docker.internal\n'
            )
            def openssl(*args):
                subprocess.run(['openssl', *map(str, args)], cwd=stage, check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            # Separate roots prevent the image service from impersonating Go.
            # The CA signing key exists only for the lifetime of this directory.
            (stage / 'ca.cnf').write_text(
                f'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Koinote Local {service} root\n'
                '[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n'
            )
            openssl('req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '800',
                    '-config', 'ca.cnf', '-keyout', 'ca.key', '-out', 'ca.crt')
            openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', config, '-keyout', 'key', '-out', 'server.csr')
            openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
                    '-sha256', '-days', '730', '-extfile', config, '-extensions', 'server', '-out', 'cert')
            # The container's unprivileged uid reads a single mounted key.
            # Its host directory is owner-only. Never mount the image key into Go.
            (stage / 'key').chmod(0o444 if service == 'backend' else 0o600)
            (stage / 'cert').chmod(0o444)
            if not valid_identity(stage / 'cert', stage / 'key', stage / 'ca.crt'):
                raise SystemExit('Generated Local TLS identity did not verify.')
            if os.name == 'nt':
                for target in (key, cert, ca):
                    if target.exists():
                        target.chmod(0o600)
            os.replace(stage / 'key', key)
            os.replace(stage / 'cert', cert)
            (stage / 'ca.crt').chmod(0o444)
            os.replace(stage / 'ca.crt', ca)


if __name__ == '__main__':
    import sys
    provision(Path(sys.argv[1]))
