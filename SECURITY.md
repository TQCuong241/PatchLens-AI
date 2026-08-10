# Security Policy

PatchLens operates a privileged local daemon and can send repository, DOM, console and screenshot context to coding providers. Read [`docs/security.md`](./docs/security.md) before deployment or integration changes.

## Supported versions

Only latest unreleased `main` branch and latest published `0.x` version receive security fixes during MVP development.

## Reporting

Use GitHub private vulnerability reporting or a private security advisory for this repository when available.

- Do not open a public issue containing credentials, private source, customer data or screenshots.
- Use a minimal reproduction with fake values.
- Include affected version, operating system, Node version, attack preconditions and impact.
- State whether issue crosses browser, Studio, daemon, MCP, provider or filesystem boundary.

Public hardening suggestions without sensitive details may use normal issues.
