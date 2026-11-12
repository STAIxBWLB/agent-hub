# Security policy

## Reporting a vulnerability

Report a suspected vulnerability privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting). Do not open a public issue, pull request or discussion for it.

Include the affected version (`ahub --version`), the operating system, what an attacker needs (a local account, a hub peer, a web page the person opens), and the smallest steps that show the effect. Leave real credentials, tokens and private task text out of the report.

## Supported versions

Fixes land on the latest released minor version of `@staix/agent-hub`. Upgrade with `ahub upgrade` before reporting when you can.

## Scope

The trust boundaries this project defends are described in [docs/security.md](docs/security.md).
