"""Download the public benchmark datasets into data/datasets/, pinned and verified.

- NAB, the Numenta Anomaly Benchmark (MIT licence): 58 labelled time series for evaluating the
  metric anomaly detector against published results. ~10 MB.
- LogHub 2k samples (free for research and academic use; cite the LogHub paper): 2,000-line
  samples of 16 real system logs with ground-truth templates, for evaluating log parsing. ~11 MB.

Each dataset is pinned to an exact commit, and every file is checked against the git blob hash
GitHub reports for it, so a download is byte-identical for everyone or it fails.

Usage: uv run python scripts/download_datasets.py
"""

import hashlib
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import httpx

DATASETS_DIR = Path(__file__).resolve().parents[1] / "data" / "datasets"


@dataclass(frozen=True)
class Dataset:
    name: str
    repo: str
    commit: str
    include: re.Pattern


DATASETS = [
    Dataset(
        "nab",
        "numenta/NAB",
        "ea702d75cc2258d9d7dd35ca8e5e2539d71f3140",
        re.compile(r"^(data/.+\.csv|labels/combined_(labels|windows)\.json)$"),
    ),
    Dataset(
        "loghub",
        "logpai/loghub",
        "dd61d0952749ee7963bde24220d1be5ede023033",
        re.compile(r"^[^/]+/[^/]+_2k\.log(_structured\.csv|_templates\.csv)?$"),
    ),
]


def git_blob_sha(content: bytes) -> str:
    """The hash git (and GitHub) uses to identify a file's exact contents."""
    return hashlib.sha1(b"blob %d\0" % len(content) + content).hexdigest()


def list_files(dataset: Dataset, client: httpx.Client) -> list[tuple[str, str]]:
    url = f"https://api.github.com/repos/{dataset.repo}/git/trees/{dataset.commit}?recursive=1"
    headers = {}
    # Anonymous GitHub API calls are limited to 60 per hour per network; a token lifts that.
    if token := os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {token}"
    response = client.get(url, headers=headers)
    if response.status_code == 403:
        sys.exit("GitHub API rate limit reached. Set GITHUB_TOKEN (e.g. from `gh auth token`).")
    tree = response.raise_for_status().json()
    if tree.get("truncated"):
        sys.exit(f"File listing for {dataset.repo} was truncated by GitHub.")
    return [
        (item["path"], item["sha"])
        for item in tree["tree"]
        if item["type"] == "blob" and dataset.include.match(item["path"])
    ]


def fetch(dataset: Dataset, path: str, expected_sha: str, client: httpx.Client) -> bool:
    """Download one file unless an identical copy exists. Returns True if it was downloaded."""
    target = DATASETS_DIR / dataset.name / path
    if target.exists() and git_blob_sha(target.read_bytes()) == expected_sha:
        return False
    url = f"https://raw.githubusercontent.com/{dataset.repo}/{dataset.commit}/{path}"
    content = client.get(url).raise_for_status().content
    if git_blob_sha(content) != expected_sha:
        raise ValueError(f"{dataset.name}/{path}: content does not match the pinned commit")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return True


def main() -> None:
    with httpx.Client(timeout=60, follow_redirects=True) as client:
        for dataset in DATASETS:
            files = list_files(dataset, client)
            with ThreadPoolExecutor(max_workers=8) as pool:
                downloaded = sum(
                    pool.map(lambda file: fetch(dataset, *file, client), files)  # noqa: B023
                )
            size_mb = sum((DATASETS_DIR / dataset.name / p).stat().st_size for p, _ in files) / 1e6
            print(
                f"{dataset.name}: {len(files)} files verified ({downloaded} downloaded), "
                f"{size_mb:.1f} MB, pinned to {dataset.repo}@{dataset.commit[:7]}"
            )


if __name__ == "__main__":
    main()
