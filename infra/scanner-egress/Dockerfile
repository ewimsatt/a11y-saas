# syntax=docker/dockerfile:1.7
# Smokescreen source/binary provenance: v0.1.0, commit 609eb8931420453daf5893509be0b25b21bd9edb.
# The official release binary is verified below. A local stdlib-only port guard
# restricts Chromium destinations to ports 80/443, then forwards only to the
# loopback Smokescreen listener. It has no direct destination dial path.
FROM golang:1.24.9-alpine3.22@sha256:8f8959f38530d159bf71d0b3eb0c547dc61e7959d8225d1599cf762477384923 AS guard-build
WORKDIR /src
COPY port-guard.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/scanner-egress-guard ./port-guard.go

FROM alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507 AS fetch
ARG TARGETARCH
RUN set -eux; \
  apk add --no-cache ca-certificates curl tar; \
  arch="${TARGETARCH:-$(apk --print-arch)}"; \
  case "$arch" in amd64|x86_64) arch=amd64; sha=4e1e447449e3cc653dae956208588722b5c8fe8ce894f633adc756a851d1ec46;; arm64|aarch64) arch=arm64; sha=f15ddd0dc2b2cbc6d7318f441928939eb9bedfab2a1881508af3096a1e24b7c9;; *) echo "unsupported architecture: $arch" >&2; exit 1;; esac; \
  asset="smokescreen_v0.1.0_linux_${arch}.tar.gz"; \
  curl --fail --location --proto '=https' --tlsv1.2 --output "/tmp/$asset" "https://github.com/stripe/smokescreen/releases/download/v0.1.0/$asset"; \
  echo "$sha  /tmp/$asset" | sha256sum -c -; \
  tar -xzf "/tmp/$asset" -C /tmp; \
  mkdir -p /out; \
  install -m 0755 "/tmp/smokescreen_v0.1.0_linux_${arch}/smokescreen" /out/smokescreen

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=fetch /out/smokescreen /usr/local/bin/smokescreen
COPY --from=guard-build /out/scanner-egress-guard /usr/local/bin/scanner-egress-guard
COPY --chown=nonroot:nonroot smokescreen.yaml /etc/smokescreen/smokescreen.yaml
USER nonroot:nonroot
EXPOSE 4750
ENTRYPOINT ["/usr/local/bin/scanner-egress-guard"]
