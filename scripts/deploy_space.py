"""Deploy the whole system to a Hugging Face Docker Space (free, no card): the live demo.

    uv run hf auth login                       # once, in your own terminal
    uv run python scripts/deploy_space.py      # creates the Space if needed, then uploads

Only files tracked by git are uploaded, so .env, .env.cloud and data/ can never be. Hugging
Face builds deploy/space/Dockerfile and runs it. The Space then needs these secrets, set in its
Settings > Variables and secrets (never through this script):

    GEMINI_API_KEY, GROQ_API_KEY   the models
    DATABASE_URL                   the cloud's own database (.env.cloud)
    VIGIL_API_TOKEN                who may break the shop and approve fixes
"""

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from huggingface_hub import HfApi

ROOT = Path(__file__).resolve().parents[1]
# What the image needs; everything else in the repository stays out of the Space.
INCLUDE = (
    "pyproject.toml",
    "uv.lock",
    "LICENSE",
    "src/",
    "runbooks/",
    "monitoring/",
    "scripts/install_prometheus.py",
    "ui/",
    "deploy/space/",
)
EXCLUDE = ("ui/tests/", "ui/scripts/record-video.mjs")

CARD = """---
title: Vigil
emoji: 🌌
colorFrom: indigo
colorTo: yellow
sdk: docker
app_port: 8030
pinned: false
license: mit
short_description: The AI on-call engineer that never sleeps, running live.
---

# Vigil, live

The whole system running: a small online shop (four services, simulated customers,
Prometheus) and Vigil watching it, ready to detect, investigate and, with a person's approval,
fix whatever goes wrong. Built from [deploy/space/Dockerfile](deploy/space/Dockerfile).

Anyone can watch. Breaking the shop or approving a fix needs the owner's token.
"""


def tracked() -> list[str]:
    files = subprocess.run(
        ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    return [
        f
        for f in files
        if f.startswith(INCLUDE) and not f.startswith(EXCLUDE) and (ROOT / f).is_file()
    ]


def stage(target: Path) -> int:
    files = tracked()
    for name in files:
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, destination)
    # Hugging Face builds the Dockerfile at the root, with the root as the context.
    shutil.copy2(ROOT / "deploy/space/Dockerfile", target / "Dockerfile")
    shutil.copy2(ROOT / "deploy/space/Dockerfile.dockerignore", target / ".dockerignore")
    (target / "README.md").write_text(CARD, encoding="utf-8")
    return len(files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--space", help="owner/name; default: <your username>/vigil")
    args = parser.parse_args()

    api = HfApi()
    space = args.space or f"{api.whoami()['name']}/vigil"
    api.create_repo(space, repo_type="space", space_sdk="docker", exist_ok=True)
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True
    ).stdout.strip()
    with tempfile.TemporaryDirectory() as folder:
        count = stage(Path(folder))
        api.upload_folder(
            folder_path=folder,
            repo_id=space,
            repo_type="space",
            commit_message=f"Deploy {commit}",
            delete_patterns=["*", "**/*"],  # files removed from the repository leave the Space
        )
    owner, name = space.split("/")
    print(f"Uploaded {count} files. Building at https://huggingface.co/spaces/{space}")
    print(f"Once it is running: https://{owner.lower()}-{name.lower()}.hf.space")


if __name__ == "__main__":
    main()
