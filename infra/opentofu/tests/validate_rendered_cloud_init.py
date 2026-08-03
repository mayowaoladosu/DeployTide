#!/usr/bin/env python3
"""Decode, parse, and assert the rendered DeployTide cloud-init contracts."""

from __future__ import annotations

import base64
import gzip
import json
import re
import shutil
import subprocess
import sys
import tempfile
from email import policy
from email.parser import BytesParser
from pathlib import Path
from typing import Any

import yaml


EXPECTED_RUNTIME_IDS = {
    "east-us": (
        "runtime-cluster-exact-east-us",
        "runtime-target-exact-east-us",
    ),
    "uk-south": (
        "runtime-cluster-exact-uk-south",
        "runtime-target-exact-uk-south",
    ),
}
PRIVATE_KEY_MATERIAL = re.compile(
    rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
)
PUBLISHED_PORT = re.compile(r"(^|\s)(?:-p|--publish)(?:\s|=)")


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def construct_unique_mapping(
    loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise AssertionError(f"duplicate YAML key: {key!r}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_unique_mapping
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def decode_cloudinit(path: Path) -> tuple[dict[str, Any], bytes]:
    encoded = path.read_text(encoding="utf-8").strip()
    rendered = base64.b64decode(encoded, validate=True)
    if rendered.startswith(b"\x1f\x8b"):
        rendered = gzip.decompress(rendered)
    message = BytesParser(policy=policy.default).parsebytes(rendered)
    if message.is_multipart():
        parts = [
            part.get_payload(decode=True)
            for part in message.walk()
            if part.get_content_type() == "text/cloud-config"
        ]
        require(len(parts) == 1 and parts[0] is not None, f"{path} has no unique cloud-config MIME part")
        cloud_config = parts[0]
    else:
        cloud_config = rendered
    cloud_config = cloud_config.replace(b"\r\n", b"\n")
    require(cloud_config.startswith(b"#cloud-config\n"), f"{path} lost the cloud-config header")
    parsed = yaml.load(cloud_config.decode("utf-8"), Loader=UniqueKeyLoader)
    require(isinstance(parsed, dict), f"{path} did not parse as a YAML mapping")
    return parsed, cloud_config


def decoded_files(config: dict[str, Any]) -> dict[str, str]:
    files: dict[str, str] = {}
    entries = config.get("write_files")
    require(isinstance(entries, list), "cloud-init write_files must be a list")
    for entry in entries:
        require(isinstance(entry, dict), "write_files entry must be a mapping")
        path = entry.get("path")
        content = entry.get("content")
        require(isinstance(path, str) and isinstance(content, str), "write_files path/content is invalid")
        require(path not in files, f"duplicate write_files path: {path}")
        if entry.get("encoding") in {"b64", "base64"}:
            content = base64.b64decode(content, validate=True).decode("utf-8")
        files[path] = content
    return files


def parse_b64_environment(content: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in content.splitlines():
        if not line:
            continue
        key, separator, value = line.partition("=")
        require(bool(separator) and key not in values, "enrollment environment is malformed")
        values[key] = base64.b64decode(value, validate=True).decode("utf-8")
    return values


def shell_syntax_check(files: dict[str, str]) -> None:
    shell = shutil.which("sh")
    if shell is None:
        return
    with tempfile.TemporaryDirectory(prefix="deploytide-cloud-init-") as directory:
        for path, content in files.items():
            if not content.startswith("#!/bin/sh\n"):
                continue
            script = Path(directory, Path(path).name)
            script.write_text(content, encoding="utf-8", newline="\n")
            subprocess.run([shell, "-n", str(script)], check=True)


def public_pem_syntax_check(ca: str, job_key: str) -> None:
    openssl = shutil.which("openssl")
    if openssl is None:
        return
    with tempfile.TemporaryDirectory(prefix="deploytide-public-pem-") as directory:
        ca_path = Path(directory, "ca.pem")
        key_path = Path(directory, "job-public.pem")
        ca_path.write_text(ca, encoding="utf-8", newline="\n")
        key_path.write_text(job_key, encoding="utf-8", newline="\n")
        subprocess.run(
            [openssl, "x509", "-in", str(ca_path), "-noout", "-checkend", "300"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            [openssl, "pkey", "-pubin", "-in", str(key_path), "-noout"],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def validate_runtime(path: Path, region: str) -> None:
    config, raw = decode_cloudinit(path)
    files = decoded_files(config)
    cluster_id, target_id = EXPECTED_RUNTIME_IDS[region]
    all_decoded = raw + "\n".join(files.values()).encode("utf-8")
    require(not PRIVATE_KEY_MATERIAL.search(all_decoded), f"{region} contains private key material")

    ca = files["/etc/deploytide/trust/controller-ca.pem"]
    job_key = files["/etc/deploytide/trust/job-public-key.pem"]
    require(ca.splitlines()[0] == "-----BEGIN CERTIFICATE-----", f"{region} CA first line was damaged")
    require(job_key.splitlines()[0] == "-----BEGIN PUBLIC KEY-----", f"{region} job key first line was damaged")
    public_pem_syntax_check(ca, job_key)
    preloaded_pem_files = {
        path: content
        for path, content in files.items()
        if content.startswith("-----BEGIN ")
    }
    require(
        set(preloaded_pem_files) == {
            "/etc/deploytide/trust/controller-ca.pem",
            "/etc/deploytide/trust/job-public-key.pem",
        },
        f"{region} user-data contains pre-issued controller identity material",
    )

    controller_env = files["/etc/deploytide/controller.env"]
    require(f"DEPLOYTIDE_CLUSTER_ID={cluster_id}" in controller_env, f"{region} cluster ID was synthesized")
    require(f"DEPLOYTIDE_RUNTIME_TARGET_ID={target_id}" in controller_env, f"{region} target ID was synthesized")
    require(
        "DEPLOYTIDE_DOCKER_SOCKET=/run/deploytide-proxy/docker.sock" in controller_env,
        f"{region} controller does not use the proxy socket",
    )
    require("/var/run/docker.sock" not in controller_env, f"{region} controller env exposes the raw socket")

    enrollment = parse_b64_environment(files["/etc/deploytide/enrollment.env"])
    require(enrollment["DEPLOYTIDE_RUNTIME_CLUSTER_ID_B64"] == cluster_id, f"{region} enrollment cluster ID differs")
    require(enrollment["DEPLOYTIDE_RUNTIME_TARGET_ID_B64"] == target_id, f"{region} enrollment target ID differs")
    require(enrollment["DEPLOYTIDE_ENROLLMENT_URL_B64"].startswith("https://"), f"{region} enrollment is not HTTPS")

    token_entry = next(
        entry for entry in config["write_files"] if entry["path"] == "/etc/deploytide/enrollment.token"
    )
    require(token_entry["owner"] == "root:root" and token_entry["permissions"] == "0600", f"{region} enrollment token permissions are unsafe")
    controller_env_entry = next(
        entry for entry in config["write_files"] if entry["path"] == "/etc/deploytide/controller.env"
    )
    require(controller_env_entry["owner"] == "root:root" and controller_env_entry["permissions"] == "0600", f"{region} controller env is not root-only")

    enrollment_script = files["/usr/local/sbin/deploytide-enroll-controller"]
    require("openssl genpkey -algorithm ED25519" in enrollment_script, f"{region} does not generate its private key on-node")
    require("openssl req -new" in enrollment_script and "--config -" in enrollment_script, f"{region} PKI enrollment contract is incomplete")
    require("--connect-timeout 10 --max-time 30 --max-filesize 1048576" in enrollment_script, f"{region} enrollment response is unbounded")
    require('rm -f "$token_file" "$csr_file"' in enrollment_script, f"{region} does not remove its token after enrollment")
    require("X-DeployTide-Runtime-Cluster-Id: $cluster_id" in enrollment_script, f"{region} omits cluster identity during enrollment")
    require("X-DeployTide-Runtime-Target-Id: $runtime_target_id" in enrollment_script, f"{region} omits target identity during enrollment")

    prepare = files["/usr/local/sbin/deploytide-prepare-runtime"]
    for directory in (
        "/run/deploytide-proxy",
        "/var/lib/deploytide/controller-state",
        "/var/lib/deploytide/controller-identity",
    ):
        require(f"-o 65532 -g 65532 {directory}" in prepare, f"{region} ownership missing for {directory}")
    require("chown 65532:65532" in prepare, f"{region} certificate/key ownership is not repaired")
    tmpfiles = files["/etc/tmpfiles.d/deploytide-runtime.conf"]
    for declaration in (
        "d /run/deploytide-proxy 0750 65532 65532 -",
        "d /var/lib/deploytide/controller-state 0700 65532 65532 -",
        "d /var/lib/deploytide/controller-identity 0700 65532 65532 -",
    ):
        require(declaration in tmpfiles, f"{region} is not reboot-safe: {declaration}")

    proxy_runner = files["/usr/local/sbin/deploytide-run-docker-proxy"]
    require("--network none" in proxy_runner, f"{region} proxy has network access")
    require("--user 65532:65532" in proxy_runner and "--group-add \"$socket_gid\"" in proxy_runner, f"{region} proxy identity is not least-privileged")
    require("--read-only" in proxy_runner and "--cap-drop ALL" in proxy_runner and "--security-opt no-new-privileges" in proxy_runner, f"{region} proxy runtime policy is incomplete")
    require(proxy_runner.count("/var/run/docker.sock") >= 2, f"{region} proxy does not own the raw socket mount")
    require(not PUBLISHED_PORT.search(proxy_runner), f"{region} proxy publishes a port")

    controller_runner = files["/usr/local/sbin/deploytide-run-runtime-controller"]
    require("--user 65532:65532" in controller_runner, f"{region} controller UID/GID is wrong")
    require("--read-only" in controller_runner and "--cap-drop ALL" in controller_runner and "--security-opt no-new-privileges" in controller_runner, f"{region} controller runtime policy is incomplete")
    require("--network bridge" in controller_runner and "--network host" not in controller_runner, f"{region} controller network policy is unsafe")
    require("/var/run/docker.sock" not in controller_runner, f"{region} controller mounts the raw Docker socket")
    require("/run/deploytide-proxy" in controller_runner, f"{region} controller lacks the proxy socket")
    require(not PUBLISHED_PORT.search(controller_runner), f"{region} controller publishes a port")
    require("controller-identity,readonly" in controller_runner and "controller-state" in controller_runner, f"{region} identity/state mounts are incorrect")

    enrollment_unit = files["/etc/systemd/system/deploytide-controller-enrollment.service"]
    require("ReadWritePaths=-/etc/deploytide/enrollment.token" in enrollment_unit, f"{region} cannot restart after token removal")
    controller_unit = files["/etc/systemd/system/deploytide-runtime-controller.service"]
    proxy_unit = files["/etc/systemd/system/deploytide-docker-proxy.service"]
    require("User=65532" not in controller_unit, f"{region} host systemd cannot invoke Docker")
    require("User=65532" not in proxy_unit, f"{region} proxy host systemd cannot invoke Docker")
    require("PrivateNetwork=yes" not in controller_unit and "PrivateNetwork=yes" not in proxy_unit, f"{region} host Docker wrappers cannot reach the daemon/network")
    shell_syntax_check(files)


def validate_build(path: Path) -> None:
    config, raw = decode_cloudinit(path)
    files = decoded_files(config)
    require(not PRIVATE_KEY_MATERIAL.search(raw + "\n".join(files.values()).encode("utf-8")), "build cloud-init contains private key material")
    contract = json.loads(files["/etc/deploytide/build-worker-contract.json"])
    require(contract["orchestrator"] == "RootlessBuildKitProvider", "build host names the wrong orchestrator")
    require(contract["workerContainerPrivileged"] is True, "build host hides the actual privileged worker prerequisite")
    require(contract["ephemeralWorkers"] is True and contract["scrubAfterLease"] is True, "build host is not ephemeral/scrubbed")
    require(re.search(r"@sha256:[0-9a-f]{64}$", contract["image"]) is not None, "BuildKit image is not digest-pinned")
    verifier = files["/usr/local/sbin/deploytide-verify-build-host"]
    require("docker run" not in verifier, "build cloud-init still claims an invalid smoke invocation")
    require("user.max_user_namespaces" in verifier and "apparmor_restrict_unprivileged_userns" in verifier, "build host prerequisites are incomplete")
    require("docker image inspect" in verifier and contract["image"] in verifier, "build host does not verify the pinned image")
    shell_syntax_check(files)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate_rendered_cloud_init.py GENERATED_DIRECTORY")
    generated = Path(sys.argv[1]).resolve()
    runtime_files = sorted(generated.glob("runtime-*.cloud-init.b64"))
    build_files = sorted(generated.glob("build-*.cloud-init.b64"))
    require(len(runtime_files) == len(EXPECTED_RUNTIME_IDS), "rendered runtime cloud-init count is wrong")
    require(len(build_files) == 1, "rendered build cloud-init count is wrong")
    for path in runtime_files:
        match = re.fullmatch(r"runtime-(.+)\.cloud-init\.b64", path.name)
        require(match is not None and match.group(1) in EXPECTED_RUNTIME_IDS, f"unexpected runtime file {path.name}")
        validate_runtime(path, match.group(1))
    validate_build(build_files[0])
    print(f"validated {len(runtime_files)} runtime and {len(build_files)} build cloud-init documents")


if __name__ == "__main__":
    main()
