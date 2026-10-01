# photobaer-mcp

An MCP server that lets Claude Code, Codex and other MCP clients edit images in [photobaer](https://photobaer.com), the free photo editor that runs in your browser.

The editing runs in a photobaer browser tab. This server runs on your computer, talks to the agent over stdio and to the tab over a WebSocket on 127.0.0.1. Images go from your disk to the tab and back; nothing is uploaded to photobaer.com.

## Setup

Needs Node.js 20 or newer.

```sh
claude mcp add photobaer -- npx -y photobaer-mcp
codex mcp add photobaer -- npx -y photobaer-mcp
```

Then ask the agent, for example: "Use photobaer: open photo.jpg, apply a Gaussian blur with radius 3 and save it as photo-blur.png."

## How pairing works

1. The agent calls `connect`. The server opens `https://photobaer.com/#agent=PORT.TOKEN` in your default browser.
2. The tab reads the fragment, removes it from the address bar and connects to `ws://127.0.0.1:PORT`.
3. Chrome and Edge ask once to allow access to apps on this device. Allow it.
4. The tab shows "Agent connected". Click it to disconnect.

The server accepts only the photobaer origin, only the token from the last `connect` call, and only one tab at a time. A token pairs one tab once.

## Tools

| Tool | What it does |
| --- | --- |
| `connect` | Opens photobaer and pairs the tab |
| `open_file` | Opens an image from disk (PNG, JPEG, WebP, GIF, BMP, PSD, .pbaer) |
| `save_file` | Saves to disk as PNG, JPEG, WebP, PSD or .pbaer; never replaces a file unless `overwrite` is true |
| `get_document` | Document size, layers and active layer |
| `select_layer` | Makes a layer active |
| `new_document` | Creates a white RGB document |
| `list_filters`, `run_filter` | Lists filters and their parameters, runs one without a dialog |
| `list_commands`, `run_command` | Lists and runs menu commands |
| `get_preview` | Returns the image as PNG so the agent can see it |

## Options

- `--url <url>`: use a self-hosted photobaer, for example `--url http://localhost:5173/`.
- `--no-open`: do not open a browser. `connect` returns the pairing URL; open it yourself, then the agent calls `connect` again.

## Notes

- Codex asks before each MCP tool call. In `codex exec`, set `-c 'mcp_servers.photobaer.default_tools_approval_mode="approve"'`.
- `get_preview` images go to your AI provider, like any image the agent looks at.
- Safari is not tested.

## License

MIT. photobaer itself is AGPL-3.0; see the [repository](https://github.com/IT-BAER/photobaer).
