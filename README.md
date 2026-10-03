# sandbox-sdk-1

Small public proof of [Sandbox SDK 1.0](https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/) on `https://sandbox.rclabs.in`.

The Worker is a Durable Object. It starts `cloudflare/debian-trixie` with `this.ctx.container.start({ instance: "lite", enableInternet: false, entrypoint: ["sleep", "infinity"] })`, runs the fixed argv `uname -s`, then `destroy()`s the instance. The query string is ignored. This is not a shell.

`@cloudflare/sandbox` `Files` is not used. That helper needs `sandbox-shim` in the image. `debian-trixie` does not include it, and this demo only needs `exec`.

Docs:

- https://developers.cloudflare.com/changelog/post/2026-09-30-sandbox-sdk-1-0/
- https://developers.cloudflare.com/containers/guides/image-management/
- https://developers.cloudflare.com/containers/api/durable-object-container/
- https://developers.cloudflare.com/containers/configuration/scheduling-policy/
- https://developers.cloudflare.com/containers/pricing/
