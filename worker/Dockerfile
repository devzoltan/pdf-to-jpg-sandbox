# pdf-to-jpg-sandbox worker: renders PDF pages to JPEG with Poppler.
# Rebuilt before every job with `docker build --pull --no-cache`.
ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get -y upgrade \
 && apt-get install -y --no-install-recommends poppler-utils fonts-urw-base35 fontconfig \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
 && groupadd -g 10001 worker \
 && useradd -u 10001 -g 10001 -M -d /work -s /usr/sbin/nologin worker

COPY --chmod=0555 entry.sh convert.sh /usr/local/bin/

USER 10001:10001
WORKDIR /work
ENV HOME=/work XDG_CACHE_HOME=/work/.cache LC_ALL=C.UTF-8
ENTRYPOINT ["/usr/local/bin/entry.sh"]
