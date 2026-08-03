#!/bin/sh
set -eu

config=${1:-"$(dirname "$0")/haproxy.cfg"}
haproxy_bin=${HAPROXY_BIN:-haproxy}
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=DeployTide controller ingress validation CA' \
  -keyout "$temporary/ca-key.pem" \
  -out "$temporary/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes \
  -subj '/CN=operator.internal.deploytide.test' \
  -keyout "$temporary/server-key.pem" \
  -out "$temporary/server.csr" >/dev/null 2>&1
openssl x509 -req -days 1 \
  -in "$temporary/server.csr" \
  -CA "$temporary/ca.pem" \
  -CAkey "$temporary/ca-key.pem" \
  -CAcreateserial \
  -out "$temporary/server-cert.pem" >/dev/null 2>&1
cat "$temporary/server-cert.pem" "$temporary/server-key.pem" > "$temporary/server.pem"

export DEPLOYTIDE_CONTROLLER_TLS_PEM="$temporary/server.pem"
export DEPLOYTIDE_CONTROLLER_CLIENT_CA="$temporary/ca.pem"
export DEPLOYTIDE_CONTROLLER_PROXY_SECRET="fixture_internal_proxy_secret_000000000000000000"
export DEPLOYTIDE_APP_BACKEND="127.0.0.1:3000"

"$haproxy_bin" -c -f "$config"

python_command=${PYTHON:-python3}
"$python_command" - "$config" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
required = [
    "verify required",
    "ssl-min-ver TLSv1.3",
    "http-request del-header X-DeployTide-Controller-Proxy",
    "http-request del-header X-DeployTide-Client-Serial",
    "http-request del-header X-DeployTide-Client-Subject",
    "http-request del-header X-DeployTide-Client-Fingerprint",
    "http-request del-header X-Forwarded-Client-Cert",
    "http-request del-header X-SSL-Client-Cert",
    "http-request del-header X-SSL-Client-Verify",
    "http-request set-header X-DeployTide-Client-Serial %[ssl_c_serial,hex]",
    "http-request set-header X-DeployTide-Client-Subject %[ssl_c_s_dn]",
    "http-request set-header X-DeployTide-Client-Fingerprint %[ssl_c_der,sha2(256),hex]",
    'http-request set-header X-DeployTide-Controller-Proxy "${DEPLOYTIDE_CONTROLLER_PROXY_SECRET}"',
    "http-request deny deny_status 404 unless",
]
for value in required:
    if value not in text:
        raise SystemExit(f"missing ingress policy: {value}")
if re.search(r"(?im)^\s*(stats\s+(?:enable|socket|uri)|listen\s+stats)\b", text):
    raise SystemExit("management or statistics endpoint must not be enabled")
binds = re.findall(r"(?im)^\s*bind\s+([^\s]+)", text)
if binds != [":8443"]:
    raise SystemExit(f"unexpected ingress listeners: {binds}")
if text.index("del-header X-DeployTide-Client-Serial") > text.index("set-header X-DeployTide-Client-Serial"):
    raise SystemExit("identity headers must be stripped before trusted values are injected")
route_acls = set(re.findall(r"(?im)^\s*acl\s+(route_[a-z]+)\s+path_reg\s+", text))
if route_acls != {"route_jobs", "route_heartbeat", "route_ack", "route_result"}:
  raise SystemExit(f"unexpected controller route ACLs: {sorted(route_acls)}")
if len(re.findall(r"(?im)^\s*default_backend\s+deploytide_controller_api\s*$", text)) != 1 or len(
  re.findall(r"(?im)^\s*backend\s+deploytide_controller_api\s*$", text)
) != 1:
    raise SystemExit("controller ingress must have one constrained application backend")
print("validated HAProxy mTLS controller ingress policy")
PY
