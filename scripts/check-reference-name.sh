#!/bin/sh
# Fails if the reference app's name appears in any tracked file.
# Pattern is built from pieces so this script does not itself contain the word.
set -e
p="redacted"
if git grep -n -i -I -E "${p}" >/dev/null 2>&1; then
  echo "reference app name found in tracked files:" >&2
  git grep -n -i -I -E "${p}" >&2
  exit 1
fi
exit 0
