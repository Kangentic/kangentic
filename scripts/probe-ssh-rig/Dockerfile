# The sshd host the #913 Phase 0 probes connect to. Not shipped and not used by CI.
#
#   docker build -t kangentic-ssh-rig scripts/probe-ssh-rig
#   docker run -d --name kangentic-ssh-rig --cap-add NET_ADMIN -p 127.0.0.1:2222:22 \
#     -e AUTHORIZED_KEY="<public key>" kangentic-ssh-rig
#
# The key and the known_hosts file stay in a scratch folder, so nothing here touches a
# developer's own ssh config. `--cap-add NET_ADMIN` lets `tc netem` shape eth0.
#
# An older host, the floor of what the host program supports (glibc 2.28):
#   docker build --build-arg BASE=debian:10 -t kangentic-ssh-rig-debian10 scripts/probe-ssh-rig
# and `node scripts/ssh-link-rig.mjs --image kangentic-ssh-rig-debian10 ...`. Debian 10 is out of
# support, so its package sources are pointed at the archive.
ARG BASE=ubuntu:24.04
FROM ${BASE}

RUN if grep -qs buster /etc/apt/sources.list; then \
    sed -i 's|deb.debian.org|archive.debian.org|g; s|security.debian.org|archive.debian.org|g; /buster-updates/d' /etc/apt/sources.list; \
  fi \
  && apt-get -o Acquire::Check-Valid-Until=false update \
  && apt-get install -y --no-install-recommends \
    openssh-server iproute2 procps ca-certificates curl xz-utils python3 tmux \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash dev \
  && mkdir -p /run/sshd /home/dev/.ssh \
  && chmod 700 /home/dev/.ssh \
  && chown -R dev:dev /home/dev/.ssh

COPY rig-entry.sh /usr/local/bin/rig-entry.sh
RUN chmod +x /usr/local/bin/rig-entry.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/rig-entry.sh"]
