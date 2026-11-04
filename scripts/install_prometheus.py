"""Download the pinned Prometheus release into bin/, verifying its SHA-256 checksum.

Usage: uv run python scripts/install_prometheus.py
"""

import hashlib
import io
import platform
import sys
import tarfile
import zipfile
from pathlib import Path

import httpx

VERSION = "3.15.1"

# Official checksums from the v3.15.1 release's sha256sums.txt, pinned here so a tampered or
# corrupted download is rejected even if the download server itself is compromised.
CHECKSUMS = {
    ("windows", "amd64"): (
        "zip",
        "ba25b5e590520cb9fb028edef99bdc8523244d2d489b8c629e0d453d94fb030b",
    ),
    ("linux", "amd64"): (
        "tar.gz",
        "6a726885328ad9efebbf36e876ce2fb6225468a71fd1e7ce3ba666d5f4d97a84",
    ),
    ("linux", "arm64"): (
        "tar.gz",
        "ceb6d21493c37ca0b4513b147642797c68cf39a0f50a444d50e1e80c74f21b26",
    ),
    ("darwin", "amd64"): (
        "tar.gz",
        "c89fcb30045d8c394c9d93e96cbbee3aaf2448a48326b417e811eb4e528edf88",
    ),
    ("darwin", "arm64"): (
        "tar.gz",
        "0d4d3d9837d27e4fcd0bd16d115b1b8d6732a4bf3e69107f1190d9ef653ae471",
    ),
}

BIN_DIR = Path(__file__).resolve().parents[1] / "bin"
_ARCHES = {"x86_64": "amd64", "amd64": "amd64", "arm64": "arm64", "aarch64": "arm64"}


def main() -> None:
    system = platform.system().lower()
    arch = _ARCHES.get(platform.machine().lower(), platform.machine().lower())
    if (system, arch) not in CHECKSUMS:
        sys.exit(f"Unsupported platform {system}-{arch}. Install Prometheus {VERSION} manually.")

    extension, expected = CHECKSUMS[(system, arch)]
    executable = "prometheus.exe" if system == "windows" else "prometheus"
    target = BIN_DIR / executable
    if target.exists():
        print(f"Already installed: {target}")
        return

    name = f"prometheus-{VERSION}.{system}-{arch}"
    url = (
        f"https://github.com/prometheus/prometheus/releases/download/v{VERSION}/{name}.{extension}"
    )
    print(f"Downloading {url}")
    archive = httpx.get(url, follow_redirects=True, timeout=300).raise_for_status().content

    actual = hashlib.sha256(archive).hexdigest()
    if actual != expected:
        sys.exit(f"Checksum mismatch: expected {expected}, got {actual}. Nothing was installed.")

    member = f"{name}/{executable}"
    if extension == "zip":
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            binary = zipped.read(member)
    else:
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tarred:
            binary = tarred.extractfile(member).read()

    BIN_DIR.mkdir(exist_ok=True)
    target.write_bytes(binary)
    target.chmod(0o755)
    print(f"Installed Prometheus {VERSION} to {target} (checksum verified)")


if __name__ == "__main__":
    main()
