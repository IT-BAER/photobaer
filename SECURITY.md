# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Send a report to admin@it-baer.net with:

- what is affected (photobaer.com, a self-hosted build, or photobaer-mcp) and the version,
- steps or a file that reproduces it,
- what an attacker can do with it.

You get an answer within a few days. Please give us reasonable time to fix the problem before you publish it.

## Scope

- **The editor:** files you open (PSD, images, ABR, PDF, fonts, ICC profiles) are untrusted input. A file that
  crashes the engine, hangs the tab or runs code is a valid report.
- **photobaer-mcp:** it listens on 127.0.0.1 and accepts only the photobaer origin and the token of the last
  `connect` call. A way around that is a valid report.
- **Scripts:** File > Scripts runs JavaScript with the rights of the site, by design ([docs/scripting.md](docs/scripting.md)).
  This alone is not a vulnerability.

Only the latest release is supported.
