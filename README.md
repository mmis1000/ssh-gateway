# SSH Gateway

A proxy to create reverse tunnel, port forward, authentication and domain in one command

~~basically a ngrok clone~~

Besides port forward, this also supports serving a static directory through a HTTP domain (powered by sftp),
essentially a static HTTP server without a HTTP server.

All without a dedicated client on your computer (only a script that uses `openssh-server` and `ssh`).

## Supports

1. mac: yes
2. Linux: yes
3. Windows: use WSL instead (I don't know how to write a proper PowerShell or cmd file)

## Setup

1. Forward a whole domain or subdomain and its subdomain to your app
2. Properly config the config.json
3. Start the server

SSH host keys are generated on the first start and kept with the rest of the data in `saveDir`:

```
save/
  version                  storage format version
  host_keys/               ssh_host_{rsa,ecdsa,ed25519}_key(.pub)
  users/<id>/
    user.json              id, domain and password
    client_key(.pub)       key the client script logs in with
    gateway_key(.pub)      key the gateway logs in to the client sshd with
```

### Upgrading from older versions

Older versions kept users directly in `save/` and the host keys in the project root.
The server migrates them on start and moves the old files to `save.backup-v1-<time>/`,
keeping the host keys so existing clients do not see a changed host key.
To see what would happen first, run `npm run build && npm run migrate -- --dry-run`.

## Usage

```sh
curl -X POST https://<your domain>/setup > run.sh
chmod 755 run.sh
./run.sh
```

And then... *Magic*  
It created everything required to enable port forwarding and authentication for you

Run `./run.sh --help` for the options. Run without options, it also asks whether visitors need a user name
and password. With `--port` or `--dir` use `--auth user:password` instead, or `GATEWAY_AUTH=user:password`
to keep the password out of `ps`.
The `Authorization` header is still passed on to your app.

When sharing a folder, a folder with an `index.html` shows it instead of the file list. Use `--list`, or answer
no when asked, to always show the list. Files are sent with `ETag` and `Last-Modified`, so browsers that
already have a file get a `304` instead of reading it again through the tunnel.

The SOCKS5 tunnel has a password of its own, printed when the script connects. SOCKS5 sends it unencrypted,
so it only opens the tunnel, never the inspector or the script download. Users created before this had
the account password for SOCKS5, they get a new one on the next start of the gateway.

### What the gateway can access

- Port mode: only the port you forward.
- Folder mode: the script runs an `sshd` as you on a random local port. The gateway can read files over SFTP
  and connect to local ports (for the SOCKS5 tunnel), nothing else: no commands, no writes, no other hosts.
  Confining it to the shared folder would need `sshd` to run as root, so the gateway can read any file you can.
- The script never forwards your ssh agent or X11, offers only the key made for it, and refuses to connect
  when the gateway's host key does not match the one it was created with.
