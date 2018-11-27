# SSH Gateway

[![Greenkeeper badge](https://badges.greenkeeper.io/mmis1000/ssh-gateway.svg)](https://greenkeeper.io/)

a proxy to create reverse tunnel, port forward, authication and domain in one command

# Setup
1. Forward a whole domain or sub domain and its sub domain to your app
2. Properly config the config.json 
3. Generate the `ssh_host_rsa_key` and `ssh_host_rsa_key.pub` properly
4. Start the server

# Usage

    curl http://<your domain>/setup > run.sh
    chmod 755 run.sh
    ./run.sh

And then... *Magics*  
It create everything required to enable port forwarding and authentication for you