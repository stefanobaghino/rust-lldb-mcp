# Installing LLDB MCP support for `rust-debug`

This file is referenced from `SKILL.md` only when the preflight check fails. It is not loaded into the agent's context by default.

## What has to be true

LLDB with MCP support (`protocol-server start MCP` accepted, `accept:///` Unix-socket transport supported). In practice:

- **macOS**: Xcode Command Line Tools 16+ ship an LLDB that has the feature (Apple's LLDB reports e.g. `lldb-2100.0.16.12` — not "LLDB 21" — but the protocol-server command is present). If you're on older CLT or a minimal install, use Homebrew LLVM.
- **Linux**: upstream LLDB 21.1.0+ (August 2025), or a distro package built with `LLDB_ENABLE_PROTOCOL_SERVERS=ON`.

One-command check on your machine:

```bash
lldb -b -o "protocol-server start MCP accept:///tmp/lldb-probe.sock" -o "protocol-server stop"
```

If the output contains `MCP server started …`, you're fine — skip to the orchestrator section at the bottom. If you see `error: 'protocol-server' is not a valid command`, follow the platform section.

## macOS (if the system LLDB is too old)

```bash
brew install llvm
echo 'export PATH="$(brew --prefix llvm)/bin:$PATH"' >> ~/.zshrc
exec zsh
```

Homebrew's LLVM build enables protocol servers by default.

**`rust-lldb` pretty-printer caveat**: if starting `rust-lldb` prints `ModuleNotFoundError`, it's a Python-path mismatch between the LLVM build and what rustup's wrapper expects. Workaround:

```bash
PYTHONPATH=$(rustc --print sysroot)/lib/rustlib/etc rust-lldb
```

## Linux (Debian / Ubuntu)

```bash
wget -qO- https://apt.llvm.org/llvm-snapshot.gpg.key | sudo tee /etc/apt/trusted.gpg.d/apt.llvm.org.asc
echo "deb http://apt.llvm.org/$(lsb_release -cs)/ llvm-toolchain-$(lsb_release -cs)-21 main" | sudo tee /etc/apt/sources.list.d/llvm.list
sudo apt update
sudo apt install lldb-21
sudo update-alternatives --install /usr/bin/lldb lldb /usr/bin/lldb-21 100
```

## Linux (Fedora / RHEL)

```bash
sudo dnf install lldb
lldb --version  # if < 21, upgrade Fedora or use the LLVM tarballs below
```

If your distro ships LLDB older than 21, grab the LLVM project's official binary tarballs from <https://github.com/llvm/llvm-project/releases>.

## The orchestrator and Claude Code registration

Once the LLDB probe at the top of this page succeeds, follow the [Install](https://github.com/stefanobaghino/rust-lldb-mcp#install) section of the repo README for `npm install`, `claude mcp add` under the id `rust-lldb` (that exact name — the skill's `allowed-tools` hard-codes it), and the `node smoke-test.js` end-to-end check. The [Security](https://github.com/stefanobaghino/rust-lldb-mcp#security) section there also applies.
