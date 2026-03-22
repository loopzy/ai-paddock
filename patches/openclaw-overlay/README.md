# OpenClaw Patch Overlay

This directory contains the Paddock-maintained OpenClaw source files that must
override the matching files in an upstream OpenClaw checkout.

Use:

```bash
./scripts/sync-openclaw-patches.sh "$OPENCLAW_SRC"
```

The sync script copies the files in this overlay into the target OpenClaw tree.
