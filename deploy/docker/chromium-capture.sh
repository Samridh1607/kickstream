#!/bin/sh
# The hidden browser that records the program picture. A container has no user namespaces for
# Chromium's sandbox and a small /dev/shm, and no GPU: WebGL (the 3D pitch) runs on SwiftShader.
exec chromium --no-sandbox --disable-dev-shm-usage --use-angle=swiftshader --enable-unsafe-swiftshader "$@"
