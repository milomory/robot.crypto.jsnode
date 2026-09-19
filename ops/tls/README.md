# Fixed Crypto TLS operation

Installed on user approval 2026-09-19. Derived from the existing XContest fixed
broker pattern. Only Crypto nginx/TLS/renewal paths are modified; no Auth or
T-Invest changes. The opaque secret reference identifies the existing Hyperion
sudo credential; its value is delivered by broker stdin and never returned.

- `install-tls-profile.py`: root-only local installation, registry backup and
  concurrency check, separate destination/profile and fixed root-owned helpers.
- `crypto-tls-bridge.py`: one-use peer-verified Unix socket, fixed SSH target,
  fixed remote code, sanitized audit result, no arbitrary command arguments.
- `crypto-tls-remote.py`: dedicated constrained CA, leaf, nginx backup/test/reload,
  daily renewal timer. Existing VPN ACL must match before initial deployment.

Do not reinstall over an existing profile. Run the installed bridge as anton
with refreshed group membership if required:

```
sudo -n -u anton /usr/local/libexec/crypto-tls-bridge.py --run
```

This reissues the leaf and reloads nginx; it is a mutation, not a health check.
The server renewal service calls `--renew`, returning without changes while the
leaf has more than 30 days remaining. Runtime compose binding is managed separately.
Private keys and protected backups must never be copied into this repository.
