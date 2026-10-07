#!/usr/bin/env python3
"""
Trigger Remotion Cloud Video Render via GitHub Actions
------------------------------------------------------
Dispatches a render job to a 7GB RAM GitHub Cloud runner.
"""

import sys
import argparse
import subprocess
import os

REPO = "pradeep90043/my-video"
WORKFLOW = "render.yml"


def trigger_via_gh_cli(project: str, resolution: str, draft: bool, ref: str):
    """Uses authenticated `gh` CLI to trigger the workflow on the specified git branch."""
    cmd = [
        "gh", "workflow", "run", WORKFLOW,
        "--repo", REPO,
        "--ref", ref,
        "-f", f"project={project}",
        "-f", f"resolution={resolution}",
        "-f", f"draft={'true' if draft else 'false'}"
    ]
    print(f"🚀 Dispatching render job for '{project}' on branch '{ref}' via GitHub CLI...")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        print(f"✅ Workflow dispatched successfully for project: {project} on {ref}!")
        print(f"👉 Watch progress: https://github.com/{REPO}/actions")
        return True
    else:
        print(f"⚠️ gh CLI dispatch failed: {result.stderr}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Trigger Remotion render on GitHub Cloud")
    parser.add_argument("--project", default="stickman-demo", help="Project slug")
    parser.add_argument("--resolution", default="720", choices=["720", "1080", "360"])
    parser.add_argument("--draft", action="store_true", help="Fast draft review render")
    parser.add_argument("--ref", default="feat/production-longform-stickman", help="Git branch")

    args = parser.parse_args()
    success = trigger_via_gh_cli(args.project, args.resolution, args.draft, args.ref)
    if not success:
        sys.exit(1)


if __name__ == "__main__":
    main()
