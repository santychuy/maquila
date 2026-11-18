# exe.dev reference

Commands are sent over SSH to `exe.dev`. Most accept `--json`. Source: https://exe.dev/docs

| Task | Command |
|---|---|
| Check account | `ssh exe.dev ls --json` (unregistered: `{"error":"Registration is required."}`) |
| Sign up / add key | `ssh exe.dev` (interactive) |
| Create VM | `ssh exe.dev new --name=NAME [--image=IMG] [--cpu=N] [--memory=16GB] [--disk=50GB] [--json]` |
| List VMs | `ssh exe.dev ls --json` → `vms[]{vm_name, https_url, ssh_dest, status, region}` |
| Delete VM | `ssh exe.dev rm NAME` |
| Shell / run command | `ssh NAME.exe.xyz [command]` |
| Copy files | `scp file NAME.exe.xyz:~/`, or `tar cf - dir \| ssh NAME.exe.xyz 'tar xf - -C ~/'` |
| Route HTTPS to a port | `ssh exe.dev share port NAME 8000` |
| Visibility | `ssh exe.dev share show NAME`, `share set-private NAME`, `share set-public NAME` |
| Share with someone | `ssh exe.dev share add NAME EMAIL`, `share add-link NAME` |

## Facts the setup relies on

- The URL is `https://NAME.exe.xyz`. It is private by default: only the owner (after exe.dev login) gets through.
- Authenticated requests reach the app with `X-ExeDev-UserID` and `X-ExeDev-Email` headers.
- The default image is `exeuntu` (Ubuntu with systemd; Claude Code, Codex, and Pi preinstalled).
- Pricing: subscription (Personal $20/month, 50 VMs) with a free trial.
