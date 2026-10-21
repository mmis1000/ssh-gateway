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
