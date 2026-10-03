import { DurableObject } from "cloudflare:workers";

// Fixed proof. The query string is ignored. This is not a shell.
const PROOF_ARGV = ["uname", "-s"] as const;
const READY_ATTEMPTS = 20;
const READY_WAIT_MS = 1_000;
// Backup if destroy() fails. Billing is while the instance is running.
const SAFETY_TIMEOUT_MS = 15_000;

type Proof = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  stopped: boolean;
};

function text(value: unknown): string {
  if (typeof value === "string") return value;
  // exec().output().stdout is an ArrayBuffer, not a Uint8Array.
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return "";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProofSandbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    // A restarted isolate must not leave a lite instance running.
    if (container?.running) {
      void ctx.blockConcurrencyWhile(async () => {
        try {
          await container.setInactivityTimeout(SAFETY_TIMEOUT_MS);
        } catch {
          // The destroy below is the actual stop.
        }
        try {
          await container.destroy();
        } catch {
          // Platform will still honor the inactivity timeout.
        }
      });
    }
  }

  async fetch(): Promise<Response> {
    const done = await this.ctx.storage.get<Proof>("proof");
    if (done) return Response.json(done);

    const attempted = await this.ctx.storage.get<string>("attempted");
    if (attempted) {
      return Response.json(
        {
          error: "proof already attempted; container will not start again",
          detail: attempted,
        },
        { status: 409 },
      );
    }

    // One shot. A later request must not start another instance.
    await this.ctx.storage.put("attempted", "started");

    try {
      const proof = await this.runOnce();
      proof.stopped = true;
      await this.ctx.storage.put("proof", proof);
      return Response.json(proof);
    } catch (error) {
      const detail = message(error);
      await this.ctx.storage.put("attempted", detail);
      return Response.json({ error: detail, stopped: true }, { status: 500 });
    }
  }

  private async runOnce(): Promise<Proof> {
    const container = this.ctx.container;
    if (!container) throw new Error("No container is configured");

    try {
      if (!container.running) {
        container.start({
          image: "cloudflare/debian-trixie",
          instance: "lite",
          enableInternet: false,
          entrypoint: ["sleep", "infinity"],
        });
      }
      await container.setInactivityTimeout(SAFETY_TIMEOUT_MS);

      let last = "container not ready";
      let proof: Proof | undefined;
      for (let i = 0; i < READY_ATTEMPTS; i++) {
        try {
          const proc = await container.exec([...PROOF_ARGV]);
          const output = await proc.output();
          proof = {
            command: PROOF_ARGV.join(" "),
            stdout: text(output.stdout),
            stderr: text(output.stderr),
            exitCode: output.exitCode,
            stopped: false,
          };
          break;
        } catch (error) {
          last = message(error);
          await scheduler.wait(READY_WAIT_MS);
        }
      }
      if (!proof) throw new Error(last);
      return proof;
    } finally {
      if (container.running) {
        try {
          await container.destroy();
        } catch {
          // Inactivity timeout still stops the instance.
        }
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("not found", { status: 404 });
    }
    const stub = env.SANDBOX.getByName("proof");
    return stub.fetch("https://sandbox.internal/");
  },
} satisfies ExportedHandler<Env>;
