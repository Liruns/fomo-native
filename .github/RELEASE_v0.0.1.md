# fomo-native v0.0.1

This is the first alpha release of **fomo-native**, an unofficial native desktop
client for working with a locally installed OmO runtime.

Expect rough edges. This release is intended for early testing and feedback,
not production-critical use.

## Platform

- Windows x64
- NSIS installer
- Installer: `fomo-native-0.0.1-windows-x64.exe`

Other operating systems and CPU architectures are not included in `v0.0.1`.

## Included

- Local OmO sessions and streaming conversations
- Automatic discovery of the installed `omo` executable, models, and profiles
- Project and thread navigation
- Model, reasoning, and permission controls
- Agent and workflow activity panels
- Integrated terminal, diff, file-change, and source-control surfaces
- Windows desktop notifications and taskbar activity

The Workflow panel displays grouped runs, phases, and agents. A true
node-to-node DAG visualization is planned but is not shipped in this release.

## Requirements

Install [OmO / oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)
first and ensure `omo` is available in your user environment:

```powershell
omo --version
```

fomo-native does not install or replace OmO.

## Install

1. Download `fomo-native-0.0.1-windows-x64.exe` and `SHA256SUMS` below.
2. Compare the installer's SHA-256 hash with the checksum file:

   ```powershell
   Get-FileHash .\fomo-native-0.0.1-windows-x64.exe -Algorithm SHA256
   Get-Content .\SHA256SUMS
   ```

3. Run the installer and launch **fomo-native** from the Start menu.

This alpha installer may be unsigned, so Windows SmartScreen may report an
unknown publisher. Only continue after verifying the source and checksum.
Updates are manual for this release.

## Credits and status

fomo-native is a community fork of
[T3 Code](https://github.com/pingdotgg/t3code), built by an OmO user and
[oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) fan. It is
not affiliated with or endorsed by either upstream project. See `NOTICE.md` and
`LICENSE` in the source repository for attribution and terms.
