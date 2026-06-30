#!/bin/bash
# Cleanup script to remove files older than configured days to prevent disk bloat

# Resolve paths relative to the script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUTPUT_DIR="${PROJECT_DIR}/output"
TEMP_DIR="${PROJECT_DIR}/temp"
LOGS_DIR="${PROJECT_DIR}/logs"

echo "==> Starting cleanup: $(date)"

# Clean output folder (MP4 videos) - 7 days retention
if [ -d "$OUTPUT_DIR" ]; then
    echo "Cleaning output files older than 7 days..."
    find "$OUTPUT_DIR" -type f -mtime +7 -print -delete
fi

# Clean temp folder (intermediate frames, audio snippets) - 3 days retention
if [ -d "$TEMP_DIR" ]; then
    echo "Cleaning temp files older than 3 days..."
    find "$TEMP_DIR" -type f -mtime +3 -print -delete
fi

# Clean logs folder (log files) - 14 days retention
if [ -d "$LOGS_DIR" ]; then
    echo "Cleaning log files older than 14 days..."
    find "$LOGS_DIR" -type f -name "*.log" -mtime +14 -print -delete
fi

echo "==> Cleanup complete."
